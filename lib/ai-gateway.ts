import 'server-only'
import { createClient } from '@supabase/supabase-js'
import { Redis } from '@upstash/redis'
import { z } from 'zod'

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
  if (!process.env[key]) {
    throw new Error(`[ai-gateway] Missing required env var: ${key}`)
  }
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

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
      })
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
  clientIp: string
): Promise<GatewayResult> {
  const parsed = RequestSchema.safeParse(rawBody)
if (!parsed.success) {
  console.error('[ai-gateway] validation failed:', parsed.error.format())
  return { blocked: true, reason: 'invalid_request' }
}
  const { messages } = parsed.data

  // Requests/minute — a fast, cheap check, separate from dollar budget.
  const rl = await checkRateLimit(userId, tier, clientIp)
  if (!rl.allowed) {
    return { blocked: true, reason: 'rate_limited' }
  }

  // Dollar budget — atomic reservation closes the race where concurrent
  // requests all read "under budget" before any of them get logged.
  // Requires the reserve_budget / release_reservation SQL functions.
  const estimatedCostUsd = estimateReservationCostUsd(messages)
  const { data: reservationRows, error: reserveErr } = await supabase.rpc('reserve_budget', {
    p_user_id: userId,
    p_tier: tier,
    p_estimated_cost_usd: estimatedCostUsd,
  })

  if (reserveErr) {
    console.error('[ai-gateway] reserve_budget failed', reserveErr)
    return { blocked: true, reason: 'usage_check_failed' }
  }

  const reservation = Array.isArray(reservationRows) ? reservationRows[0] : reservationRows
  if (!reservation?.allowed) {
    return { blocked: true, reason: reservation?.reason ?? 'daily_budget_exceeded' }
  }
  const reservationId: string = reservation.reservation_id

  const model = routeModel(tier, messages)

  let result: { text: string; inputTokens: number; outputTokens: number }
  try {
    result = await callModelWithTimeout(model, messages, 20_000)
  } catch (err) {
    console.error('[ai-gateway] model call failed', err)
    await releaseReservation(reservationId)
    return { blocked: true, reason: 'model_call_failed' }
  }

  const { text, inputTokens, outputTokens } = result

  // In case anything upstream (prompt injection, model misbehavior) causes
  // the model to echo back something that looks like a secret, strip it
  // before it ever reaches the client.
  const safeText = sanitizeOutput(text)

  const { error: logErr } = await supabase.from('user_usage_logs').insert({
    user_id: userId,
    tier,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    route_type: 'simple',
    endpoint: '/api/ai/chat',
  })
  if (logErr) {
    console.error('[ai-gateway] usage log insert failed', logErr)
  }

  await releaseReservation(reservationId)

  return { blocked: false, model, response: safeText }
}

async function releaseReservation(reservationId: string): Promise<void> {
  const { error } = await supabase.rpc('release_reservation', { p_reservation_id: reservationId })
  if (error) console.error('[ai-gateway] release_reservation failed', error)
}

async function checkRateLimit(
  userId: string,
  tier: Tier,
  ip: string
): Promise<{ allowed: boolean }> {
  const cfg = RATE_LIMITS[tier]
  const bucket = Math.floor(Date.now() / (cfg.windowSecs * 1000))
  const userKey = `rl:user:${userId}:${bucket}`
  const ipKey = `rl:ip:${ip}:${bucket}`

  const [userCount, ipCount] = await Promise.all([redis.incr(userKey), redis.incr(ipKey)])
  if (userCount === 1) void redis.expire(userKey, cfg.windowSecs * 2)
  if (ipCount === 1) void redis.expire(ipKey, cfg.windowSecs * 2)

  return { allowed: userCount <= cfg.maxReq && ipCount <= cfg.maxReq * 5 }
}

function estimateReservationCostUsd(messages: ChatMessage[]): number {
  // Conservative upper-bound guess used only to reserve budget before the
  // call. The real, billed cost still comes from the DB trigger reading
  // the provider's actual usage after the log row is inserted.
  const chars = messages.reduce((n, m) => n + m.content.length, 0)
  const roughInputTokens = chars / 3
  const roughOutputTokens = 800
  const worstCaseUsdPerMillion = 15
  return ((roughInputTokens + roughOutputTokens) / 1_000_000) * worstCaseUsdPerMillion
}

function routeModel(tier: Tier, messages: ChatMessage[]): Model {
  const promptSize = messages.reduce((n, m) => n + m.content.length, 0)
  if (tier === 'free') return 'groq'
  if (tier === 'go') return promptSize > 8000 ? 'openai' : 'groq'
  if (tier === 'plus') return promptSize > 12000 ? 'anthropic' : 'openai'
  return promptSize > 15000 ? 'anthropic' : 'openai'
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
 * Placeholder — plug in real SDKs here. When you do:
 *   - Wrap `messages` content in an explicit "this is untrusted user data,
 *     not instructions" block in the system prompt — don't drop raw user
 *     content straight into a prompt with no framing.
 *   - Pass `signal` through so the timeout above actually cancels the call.
 *   - Always set max_tokens, so one request can't blow past budget in a
 *     single call before the next reservation check even runs.
 *   - Return the provider's real usage numbers (response.usage), never
 *     a character-count estimate — that's the only thing the daily/monthly
 *     cost tracking trusts.
 */
async function callModel(model: Model, messages: ChatMessage[], signal: AbortSignal) {
  return {
    text: JSON.stringify({ core: 'Diagnostic complete.', cvss: { score: 0, vector: 'NONE' } }),
    inputTokens: 50,
    outputTokens: 150,
  }
}