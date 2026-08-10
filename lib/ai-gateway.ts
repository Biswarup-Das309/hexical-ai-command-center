import 'server-only'
import { createClient } from '@supabase/supabase-js'
import { Redis } from '@upstash/redis'
import { generateText } from 'ai'
import { z } from 'zod'
import { getLanguageModel } from './hexical/providers'
import { log } from './hexical/telemetry'
import { PLAN_LIMITS } from './plans'

/**
 * Fail loudly at import time, not at request time. This is exactly the
 * class of bug a silent env-var typo causes: the client silently gets
 * `undefined` and only breaks deep inside a request, as an unhelpful crash.
 */
const REQUIRED_ENV = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
] as const

for (const key of REQUIRED_ENV) {
  const value = process.env[key]

  if (!value) {
    throw new Error(`[ai-gateway] Missing required env var: ${key}`)
  }
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

type Tier = 'free' | 'go' | 'plus' | 'pro'
type Model = 'groq' | 'openai' | 'anthropic' | 'deepseek'

/**
 * This is the real contract. If the frontend's payload shape ever changes,
 * fix the frontend or deliberately version this schema — never "fix" a
 * mismatch with `.passthrough()`. Passthrough stops validating anything,
 * and whatever isn't validated here eventually reaches a model call.
 */
const RequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string().min(1).max(20000),
      }),
    )
    .min(1)
    .max(50),
})

type ChatMessage = z.infer<typeof RequestSchema>['messages'][number]

const RATE_LIMITS: Record<Tier, { windowSecs: number; maxReq: number }> = {
  free: { windowSecs: 60, maxReq: 10 },
  go: { windowSecs: 60, maxReq: 30 },
  plus: { windowSecs: 60, maxReq: 60 },
  pro: { windowSecs: 60, maxReq: 120 },
}

/**
 * Aggregate safety cap, independent of the per-message 20k-char limit the
 * schema above already enforces. 50 messages * 20k chars is ~1M chars in
 * the worst case for every tier — this catches that before it burns a
 * model call or a budget reservation on it. This was a planned check that
 * never got written (there was a dangling comment for it and no code).
 */
const MAX_TOTAL_INPUT_CHARS = 60_000

/**
 * How long a model stays benched after a billing-type failure before we
 * try it live again. Short enough to self-heal without a separate reset
 * job, long enough that a real outage doesn't get hammered on every
 * incoming request.
 */
const MODEL_COOLDOWN_TTL_SECS = 300

/**
 * Per-attempt timeout budget. The first live attempt gets the full
 * timeout in case it's just genuinely slow; later attempts in the same
 * request get a shorter one, since the caller has already been waiting.
 * This bounds worst-case latency (PRIMARY + FALLBACK*2 ≈ 36s for a
 * 3-candidate chain) without a hard attempt cap that could strand a
 * healthy last candidate right after two fast billing failures — which
 * is exactly what a fixed attempt-count cap did in testing: two quick
 * 429/400s used up the cap and a perfectly healthy third option never
 * got tried.
 */
const PRIMARY_TIMEOUT_MS = 20_000
const FALLBACK_TIMEOUT_MS = 8_000

/**
 * Worst-case $/million-tokens per model, used only to size the pre-flight
 * budget reservation. These are placeholders — replace with your actual
 * current provider pricing. Keep them as the *highest* plausible rate for
 * that model, since underestimating here is what lets a request slip
 * through under-budgeted.
 */
const MODEL_COST_PER_MILLION_TOKENS_USD: Record<Model, number> = {
  groq: 1,
  deepseek: 1,
  openai: 15,
  anthropic: 20,
}

interface GatewayResult {
  blocked: boolean
  reason?: string
  model?: Model
  response?: string
}

/**
 * userId and tier are always resolved server-side before this is called —
 * never accepted as client input. clientIp is used only for the IP-scoped
 * half of rate limiting (a second signal on top of per-user limits, so a
 * single bad actor working through several stolen/fake accounts still gets caught).
 */
export async function aiGateway(
  userId: string,
  tier: Tier,
  rawBody: unknown,
  clientIp: string,
): Promise<GatewayResult> {
  const parsed = RequestSchema.safeParse(rawBody)
  if (!parsed.success) {
    log.warn('ai_gateway.validation_failed', { issues: parsed.error.issues })
    return { blocked: true, reason: 'invalid_request' }
  }
  const { messages } = parsed.data

  const totalInputChars = messages.reduce((n, m) => n + m.content.length, 0)
  if (totalInputChars > MAX_TOTAL_INPUT_CHARS) {
    return { blocked: true, reason: 'input_too_large' }
  }

  // Requests/minute — a fast, cheap check, separate from dollar budget.
  const rl = await checkRateLimit(userId, tier, clientIp)
  if (!rl.allowed) {
    return { blocked: true, reason: 'rate_limited' }
  }

  const limit = PLAN_LIMITS[tier]

  // HARD PLAN LIMIT CHECK (message count)
  const periodStart = new Date()
  periodStart.setUTCDate(1)
  periodStart.setUTCHours(0, 0, 0, 0)
  const usageCheck = await supabase
    .from('user_usage_summary')
    .select('messages_used, tokens_used')
    .eq('user_id', userId)
    .eq('period_start', periodStart.toISOString().slice(0, 10))
    .maybeSingle()

  if (usageCheck.error && usageCheck.error.code !== 'PGRST116') {
    return { blocked: true, reason: 'usage_fetch_failed' }
  }

  const usage = usageCheck.data ?? { messages_used: 0, tokens_used: 0 }

  if (usage.messages_used >= limit.maxMessages) {
    return { blocked: true, reason: 'message_limit_exceeded' }
  }

  // Ordered list of models this request is allowed to try, cheapest/primary
  // first, most expensive fallback last — see getModelCandidates for the
  // per-tier rules this preserves from the original routing logic.
  const candidates = getModelCandidates(tier, totalInputChars)

  // Dollar budget — atomic reservation closes the race where concurrent
  // requests all read "under budget" before any of them get logged.
  // Requires the reserve_budget / release_reservation SQL functions.
  // Sized to the worst case of everything in `candidates`, not a single
  // flat number, since a fallback can land on a pricier model than the
  // primary choice.
  const estimatedCostUsd = estimateReservationCostUsd(messages, candidates)
  const { data: reservationRows, error: reserveErr } = await supabase.rpc('reserve_budget', {
    p_user_id: userId,
    p_tier: tier,
    p_estimated_cost_usd: estimatedCostUsd,
  })

  if (reserveErr) {
    log.error('ai_gateway.reserve_budget_failed', { message: reserveErr.message, code: reserveErr.code })
    return { blocked: true, reason: 'usage_check_failed' }
  }

  const reservation = Array.isArray(reservationRows) ? reservationRows[0] : reservationRows
  if (!reservation?.allowed) {
    return { blocked: true, reason: reservation?.reason ?? 'daily_budget_exceeded' }
  }
  const reservationId: string = reservation.reservation_id

  // Walk the candidate chain: skip anything on cooldown from a recent
  // billing-type failure, call the first live one, and only mark a model
  // down (not just "this call failed") when the failure actually looks
  // like a billing/quota issue rather than a one-off timeout.
  let callResult: { text: string; inputTokens: number; outputTokens: number } | null = null
  let usedModel: Model | null = null
  let liveAttempts = 0
  let lastErr: unknown = null

  for (const candidate of candidates) {
    if (await isModelOnCooldown(candidate)) {
      continue
    }

    const timeoutMs = liveAttempts === 0 ? PRIMARY_TIMEOUT_MS : FALLBACK_TIMEOUT_MS
    liveAttempts++
    try {
      callResult = await callModelWithTimeout(candidate, messages, timeoutMs)
      usedModel = candidate
      break
    } catch (err) {
      lastErr = err
      log.warn('ai_gateway.provider_call_failed', {
        provider: candidate,
        message: err instanceof Error ? err.message : String(err),
      })
      if (isBillingFailure(err)) {
        await markModelOnCooldown(candidate)
      }
    }
  }

  if (!callResult || !usedModel) {
    log.error('ai_gateway.no_provider_result', {
      message: lastErr instanceof Error ? lastErr.message : String(lastErr),
    })
    await releaseReservation(reservationId)
    return {
      blocked: true,
      reason: liveAttempts > 0 ? 'model_call_failed' : 'all_models_unavailable',
    }
  }

  const { text, inputTokens, outputTokens } = callResult
  const totalTokens = inputTokens + outputTokens

  // Atomic usage increment via SQL function — a plain read-then-write here
  // (read usage.messages_used, write usage.messages_used + 1) would race
  // the same way reserve_budget was built to avoid: two concurrent
  // requests from the same user can both read the same starting value and
  // net one increment instead of two. Requires the increment_usage SQL
  // function (see increment_usage.sql).
  const actualCostUsd = ((inputTokens + outputTokens) / 1_000_000) * MODEL_COST_PER_MILLION_TOKENS_USD[usedModel]
  const { error: incrErr } = await supabase.rpc('increment_usage', {
    p_user_id: userId,
    p_tokens: totalTokens,
    p_cost_usd: actualCostUsd,
  })
  if (incrErr) {
    log.error('ai_gateway.increment_usage_failed', { message: incrErr.message, code: incrErr.code })
  }

  // In case anything upstream (prompt injection, model misbehavior) causes
  // the model to echo back something that looks like a secret, strip it
  // before it ever reaches the client.
  const safeText = sanitizeOutput(text)

  const { error: logErr } = await supabase.from('user_usage_logs').insert({
    user_id: userId,
    tier,
    model: usedModel,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    route_type: 'simple',
    endpoint: '/api/ai/chat',
    estimated_cost_usd: actualCostUsd,
  })
  if (logErr) {
    log.error('ai_gateway.usage_log_insert_failed', { message: logErr.message, code: logErr.code })
  }

  await releaseReservation(reservationId)

  return { blocked: false, model: usedModel, response: safeText }
}

async function releaseReservation(reservationId: string): Promise<void> {
  const { error } = await supabase.rpc('release_reservation', { p_reservation_id: reservationId })
  if (error) log.error('ai_gateway.release_reservation_failed', { message: error.message, code: error.code })
}

async function checkRateLimit(userId: string, tier: Tier, ip: string): Promise<{ allowed: boolean }> {
  const cfg = RATE_LIMITS[tier]
  const bucket = Math.floor(Date.now() / (cfg.windowSecs * 1000))

  const userKey = `rl:user:${userId}:${bucket}`
  const ipKey = `rl:ip:${ip}:${bucket}`

  const [userCount, ipCount] = await Promise.all([redis.incr(userKey), redis.incr(ipKey)])

  await Promise.all([redis.expire(userKey, cfg.windowSecs * 2), redis.expire(ipKey, cfg.windowSecs * 2)])

  return {
    allowed: userCount <= cfg.maxReq && ipCount <= cfg.maxReq * 5,
  }
}

/**
 * Preserves the original per-tier primary choice (same size thresholds as
 * before) and adds an ordered fallback behind it. Free tier intentionally
 * stays single-option with no fallback — that was the original explicit
 * rule, not an oversight, so it's kept as-is. 'go' never falls back to
 * 'anthropic' and 'free'/'go' never escalate into pro-tier-cost models;
 * that boundary looked deliberate in the original routing, so it's
 * preserved here too. Adjust if your intent is different.
 */
function getModelCandidates(tier: Tier, totalInputChars: number): Model[] {
  switch (tier) {
    case 'free':
      return ['groq']
    case 'go':
      return totalInputChars > 8000 ? ['openai', 'groq', 'deepseek'] : ['groq', 'openai', 'deepseek']
    case 'plus':
      return totalInputChars > 15000 ? ['anthropic', 'openai', 'deepseek'] : ['openai', 'anthropic', 'deepseek']
    case 'pro':
      return totalInputChars > 15000 ? ['anthropic', 'openai', 'groq'] : ['openai', 'anthropic', 'groq']
    default: {
      const _exhaustive: never = tier
      throw new Error(`[ai-gateway] Unhandled tier: ${_exhaustive}`)
    }
  }
}

async function isModelOnCooldown(model: Model): Promise<boolean> {
  const flagged = await redis.get(`model:cooldown:${model}`)
  return flagged !== null
}

async function markModelOnCooldown(model: Model): Promise<void> {
  await redis.set(`model:cooldown:${model}`, '1', { ex: MODEL_COOLDOWN_TTL_SECS })
}

interface ModelCallError extends Error {
  status?: number
}

/**
 * Providers don't agree on how billing failures show up:
 *  - OpenAI has been observed returning HTTP 429 with an
 *    insufficient_quota-type message.
 *  - Anthropic has been observed returning a plain HTTP 400
 *    invalid_request_error with "credit balance is too low" in the message
 *    body — there's no dedicated status code or error type for it, so
 *    message inspection is necessary here, not just a fallback for when
 *    status codes are missing.
 * Either signal alone is treated as sufficient.
 */
function isBillingFailure(err: unknown): boolean {
  const status = (err as ModelCallError)?.status
  if (status === 402 || status === 429) return true

  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
  return (
    message.includes('credit balance') ||
    message.includes('insufficient_quota') ||
    message.includes('quota') ||
    message.includes('billing')
  )
}

function estimateReservationCostUsd(messages: ChatMessage[], candidates: Model[]): number {
  // Conservative upper-bound guess used only to reserve budget before the
  // call. The real, billed cost still comes from the DB trigger reading
  // the provider's actual usage after the log row is inserted.
  const chars = messages.reduce((n, m) => n + m.content.length, 0)
  const roughInputTokens = Math.ceil(chars / 4)
  const roughOutputTokens = 800

  const worstCaseUsdPerMillion = candidates.reduce((max, m) => Math.max(max, MODEL_COST_PER_MILLION_TOKENS_USD[m]), 0)

  return ((roughInputTokens + roughOutputTokens) / 1_000_000) * worstCaseUsdPerMillion
}

async function callModelWithTimeout(model: Model, messages: ChatMessage[], timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await callModel(model, messages, controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

const OUTPUT_SCRUB_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/sk-[a-zA-Z0-9\-_]{20,}/g, '[REDACTED]'],
  [/Bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi, '[REDACTED]'],
  [/eyJ[a-zA-Z0-9\-_]{20,}\.[a-zA-Z0-9\-_.+/]+=*/g, '[REDACTED]'],
  [/(SUPABASE|UPSTASH|OPENAI|ANTHROPIC|GROQ|DEEPSEEK|CLERK)_[A-Z_]+/g, '[REDACTED]'],
]

function sanitizeOutput(raw: string): string {
  let out = raw
  for (const [pattern, replacement] of OUTPUT_SCRUB_RULES) {
    out = out.replace(pattern, replacement)
  }
  return out
}

/**
 * Provider adapter notes:
 *   - Wrap `messages` content in an explicit "this is untrusted user data,
 *     not instructions" block in the system prompt — don't drop raw user
 *     content straight into a prompt with no framing.
 *   - Pass `signal` through so the timeout above actually cancels the call.
 *   - Always set max_tokens, so one request can't blow past budget in a
 *     single call before the next reservation check even runs.
 *   - Return the provider's real usage numbers (response.usage), never
 *     a character-count estimate — that's the only thing the daily/monthly
 *     cost tracking trusts.
 *   - Throw errors with the provider's HTTP status on a `.status` field
 *     where the SDK exposes one — isBillingFailure() checks that first,
 *     before falling back to reading the error message text.
 */
const MODEL_ENV_KEYS: Record<Model, string> = {
  groq: 'GROQ_MAIN_MODEL',
  openai: 'OPENAI_MAIN_MODEL',
  anthropic: 'ANTHROPIC_MAIN_MODEL',
  deepseek: 'DEEPSEEK_MAIN_MODEL',
}

function modelName(model: Model): string {
  const envKey = MODEL_ENV_KEYS[model]
  const value = process.env[envKey]
  if (!value) throw new Error(`Missing required environment variable: ${envKey}`)
  return value
}

/** Calls the same Vercel AI SDK adapters used by the main analysis pipeline.
 * This keeps the chat gateway real, signal-aware, usage-aware, and subject
 * to the same model environment contract as Execute. */
async function callModel(model: Model, messages: ChatMessage[], signal: AbortSignal) {
  const result = await generateText({
    model: getLanguageModel(model, modelName(model)),
    messages,
    maxOutputTokens: 1_200,
    temperature: 0.2,
    maxRetries: 0,
    abortSignal: signal,
  })

  return {
    text: result.text,
    inputTokens: result.usage?.inputTokens ?? estimateInputTokens(messages),
    outputTokens: result.usage?.outputTokens ?? estimateInputTokens([{ role: 'assistant', content: result.text }]),
  }
}

function estimateInputTokens(messages: readonly ChatMessage[]): number {
  const characters = messages.reduce((total, message) => total + message.content.length, 0)
  return Math.max(1, Math.ceil(characters / 4))
}
