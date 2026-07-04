import 'server-only'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'

/**
 * This file must only ever run server-side. The `server-only`
 * import above makes that a build error, not just a comment —
 * if anything tries to import this from client code, the build fails.
 */

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

type Tier = 'free' | 'go' | 'plus' | 'pro'
type Model = 'groq' | 'openai' | 'anthropic' | 'deepseek'

// Caps here are placeholders — tune to whatever context length /
// conversation length actually makes sense for your product.
const RequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string().max(20000),
      })
    )
    .min(1)
    .max(50),
})

interface GatewayResult {
  blocked: boolean
  reason?: string
  model?: Model
  response?: string
}

/**
 * MAIN ENTRY
 * userId and tier are passed in already-resolved from the server
 * (authenticated session + your billing source of truth) — this
 * function never reads either of them from client input. See route.ts.
 */
export async function aiGateway(
  userId: string,
  tier: Tier,
  rawBody: unknown
): Promise<GatewayResult> {
  const parsed = RequestSchema.safeParse(rawBody)
  if (!parsed.success) {
    return { blocked: true, reason: 'invalid_request' }
  }
  const { messages } = parsed.data

  const today = new Date().toISOString().split('T')[0]

  const { data: usage, error: usageErr } = await supabase
    .from('user_usage_daily')
    .select('total_cost_usd, request_count')
    .eq('user_id', userId)
    .eq('usage_date', today)
    .maybeSingle()

  // FAIL CLOSED: if we can't confirm today's spend, don't let the
  // request through. A DB error should never look identical to
  // "this user hasn't spent anything yet."
  if (usageErr) {
    console.error('[ai-gateway] usage lookup failed', usageErr)
    return { blocked: true, reason: 'usage_check_failed' }
  }

  const { data: limits, error: limitsErr } = await supabase
    .from('tier_limits')
    .select('*')
    .eq('tier', tier)
    .single()

  if (limitsErr || !limits) {
    console.error('[ai-gateway] tier limits lookup failed', limitsErr)
    return { blocked: true, reason: 'limits_not_configured' }
  }

  const spent = usage?.total_cost_usd ?? 0
  const count = usage?.request_count ?? 0

  if (spent >= limits.daily_budget_usd) {
    return { blocked: true, reason: 'daily_budget_exceeded' }
  }
  if (limits.max_requests_per_day && count >= limits.max_requests_per_day) {
    return { blocked: true, reason: 'daily_request_limit_exceeded' }
  }

  const model = routeModel(tier, messages)

  let result: { text: string; inputTokens: number; outputTokens: number }
  try {
    result = await callModelWithTimeout(model, messages, 20_000)
  } catch (err) {
    console.error('[ai-gateway] model call failed', err)
    return { blocked: true, reason: 'model_call_failed' }
  }

  // IMPORTANT: inputTokens/outputTokens should come from the
  // provider's own response (OpenAI: response.usage, Anthropic:
  // response.usage), not a character-count guess. A guess drifts
  // from your real bill and quietly breaks the cost tracking you
  // just built at the DB layer.
  const { text, inputTokens, outputTokens } = result

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
    // Don't fail the user's request over a logging error, but don't
    // stay silent about it either — this is exactly the kind of gap
    // that lets costs go untracked without anyone noticing.
    console.error('[ai-gateway] usage log insert failed', logErr)
  }

  return { blocked: false, model, response: text }
}

function routeModel(tier: Tier, messages: { content: string }[]): Model {
  const promptSize = messages.reduce((n, m) => n + m.content.length, 0)
  if (tier === 'free') return 'groq'
  if (tier === 'go') return promptSize > 8000 ? 'openai' : 'groq'
  if (tier === 'plus') return promptSize > 12000 ? 'anthropic' : 'openai'
  return promptSize > 15000 ? 'anthropic' : 'openai'
}

async function callModelWithTimeout(
  model: Model,
  messages: unknown[],
  timeoutMs: number
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await callModel(model, messages, controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Placeholder — plug in real SDKs here. When you do:
 *   - pass `signal` through so the timeout above actually cancels the request
 *   - always set max_tokens on the provider call, so a single request
 *     can't blow past budget in one shot before the next check even runs
 *   - return the provider's real usage numbers, not an estimate
 */
async function callModel(model: Model, messages: unknown[], signal: AbortSignal) {
  return { text: `${model} response [processed]`, inputTokens: 0, outputTokens: 0 }
}