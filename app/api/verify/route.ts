/**
 *  @file app/api/verify/route.ts - Hexical AI Execution API (v5)
 *
 * v5 rewrite, on top of the v4 cost-control layer:
 *  - Provider calls unified behind the Vercel AI SDK (generateText /
 *    streamText / generateObject) instead of five hand-rolled integrations.
 *  - Rate limiting and the 5h message quota moved to @upstash/ratelimit
 *    (atomic sliding windows) — fixes a race in the old "INCR then undo"
 *    counters.
 *  - Monthly token budget kept as a custom ledger (reserve now, true up
 *    after real usage is known) but made atomic via Lua scripts, since a
 *    request-rate limiter has no notion of giving tokens back.
 *  - Monthly *cost* budget added alongside the token ledger: reserved and
 *    reconciled the same way, in paise, against MONTHLY_COST_BUDGET_PAISE.
 *    The token ledger alone can't protect margin, because it can't tell a
 *    cheap input token apart from an output token that costs 5-17x more
 *    depending on provider — a request is only actually let through if
 *    *both* the token reservation and the cost reservation succeed.
 *  - exploit / swarm profiles now require a verified, unexpired,
 *    target-matched authorization scope (lib/hexical/authorization.ts)
 *    instead of relying only on a system-prompt instruction.
 *  - Optional SSE streaming for single-agent (non swarm-gated) responses.
 *  - Structured JSON logs instead of console.error/warn strings.
 *  - Structured finding extraction holds no AI SDK calls of its own: it
 *    reserves/reconciles budget here, then delegates the actual model call
 *    to providers.ts's extractStructuredFinding(), which owns retry, the
 *    circuit breaker, and provider selection. route.ts never constructs a
 *    LanguageModel or calls generateObject() directly.
 *
 *  v5.1 patch (tier/entitlement + error-code pass):
 *  - Tier is now resolved via resolveEntitlement() instead of a bare
 *    normalizeTier() call, so an expired tier_expires_at date is honored
 *    server-side even if the `profiles.tier` column itself hasn't been
 *    reset back to 'free' yet. See lib/hexical/types.ts.
 *  - Every error response now carries a machine-readable `code` field
 *    (see ERROR_CODES in types.ts). The frontend previously had to guess
 *    the failure reason from HTTP status alone, which meant a 403 from the
 *    *authorization* gate (missing/expired scope on an exploit/swarm
 *    request) rendered identically to a 403 from the *tier* gate — both
 *    popped the "upgrade your plan" modal, even for Pro users who simply
 *    hadn't attached an authorization scope. That's fixed on both ends now.
 *  - Added structured warn logs when a profile's tier value doesn't
 *    resolve the way you'd expect (missing row, unrecognized string,
 *    expired grant), so tier mismatches show up in server logs instead of
 *    silently falling back to 'free'.
 */
import { randomUUID } from 'crypto'
import { auth } from '@clerk/nextjs/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { Redis } from '@upstash/redis'
import { NextResponse, after } from 'next/server'
import { getCanonicalEntitlement } from '@/lib/canonical-entitlement'
import { verifyAuthorization } from '@/lib/hexical/authorization'
import {
  buildCacheKey,
  readCachedResponse,
  writeCachedResponse,
  estimateCostPaise,
  allocatedRevenuePaise,
} from '@/lib/hexical/cache'
import {
  checkRateLimit,
  checkMessageQuota,
  checkSwarmDailyLimit,
  consumeNonce,
  readDailySpend,
  recordDailySpend,
  reserveMonthlyTokens,
  reconcileMonthlyTokens,
  readMonthlyTokenUsage,
  reserveMonthlyCost,
  reconcileMonthlyCost,
  isProviderCircuitOpen,
  markProviderFailure,
  markProviderSuccess,
} from '@/lib/hexical/limits'
import {
  executeRoute,
  streamProvider,
  estimateRequestTokens,
  extractStructuredFinding,
  SwarmParseError,
} from '@/lib/hexical/providers'
import { buildReconEvent, buildFingerprintEvent } from '@/lib/hexical/recon'
import { chooseModelRoute, hasSensitiveCacheMarkers, fallbackProviders } from '@/lib/hexical/routing'
import {
  buildPromptPayload,
  buildSafeSystemContext,
  buildIsolatedUserMessage,
  buildSingleSystemPrompt,
} from '@/lib/hexical/security'
import { log } from '@/lib/hexical/telemetry'
import {
  ExecutionPayloadSchema,
  type ExecutionPayload,
  type ExecutionResponse,
  type ResponseMetrics,
  type Tier,
  type UsageEvent,
  type TraceEvent,
  type StructuredFinding,
  StructuredFindingSchema,
  REQUIRED_ENV,
  MARGIN_CHAR_LIMITS,
  PLAN_FEATURES,
  FEATURE_FLAGS,
  NONCE_TTL_SECS,
  MONTHLY_TOKEN_BUDGETS,
  providerAvailable,
  ERROR_CODES,
} from '@/lib/hexical/types'
import {
  jsonHeaders,
  firstClientIp,
  isTimestampFresh,
  readJsonBodyWithLimit,
  RequestBodyTooLargeError,
  dayKeyPart,
  secondsUntilTomorrow,
  sanitizeLabel,
} from '@/lib/hexical/util'

export const runtime = 'nodejs'

const MAX_BODY_BYTES = 150_000

function supabaseClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

function redisClient(): Redis {
  return new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! })
}

async function logUsage(supabase: SupabaseClient, event: UsageEvent): Promise<void> {
  const { error } = await supabase.from('usage_events').insert(event)
  if (error) log.warn('usage_log_skipped', { error: error.message })
}

export async function POST(req: Request): Promise<NextResponse> {
  const startedAt = Date.now()

  for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
      log.error('boot_fatal_missing_env', { key })
      return NextResponse.json(
        { error: 'Server configuration error.', code: ERROR_CODES.SERVER_CONFIG_ERROR },
        { status: 500, headers: jsonHeaders() },
      )
    }
  }

  const supabase = supabaseClient()
  const redis = redisClient()

  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json(
      { error: 'Unauthorized.', code: ERROR_CODES.UNAUTHENTICATED },
      { status: 401, headers: jsonHeaders() },
    )
  }

  let body: unknown
  try {
    body = await readJsonBodyWithLimit(req, MAX_BODY_BYTES)
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return NextResponse.json(
        { error: 'Payload too large.', code: ERROR_CODES.REQUEST_BODY_TOO_LARGE },
        { status: 413, headers: jsonHeaders() },
      )
    }
    return NextResponse.json(
      { error: 'Malformed JSON payload.', code: ERROR_CODES.MALFORMED_REQUEST },
      { status: 400, headers: jsonHeaders() },
    )
  }

  const parsed = ExecutionPayloadSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'Schema validation failed.',
        code: ERROR_CODES.SCHEMA_VALIDATION_FAILED,
        details: parsed.error.format(),
      },
      { status: 400, headers: jsonHeaders() },
    )
  }
  const payload = parsed.data

  if (!isTimestampFresh(payload.requestTimestampMs)) {
    return NextResponse.json(
      { error: 'Request timestamp is stale. Possible replay rejected.', code: ERROR_CODES.REPLAY_REJECTED },
      { status: 400, headers: jsonHeaders() },
    )
  }

  if (payload.requestNonce) {
    const fresh = await consumeNonce(redis, userId, payload.requestNonce, NONCE_TTL_SECS)
    if (!fresh) {
      return NextResponse.json(
        { error: 'Duplicate nonce detected. Replay attack rejected.', code: ERROR_CODES.REPLAY_REJECTED },
        { status: 409, headers: jsonHeaders() },
      )
    }
  }

  // --- canonical entitlement lookup -------------------------------------
  // The subscription ledger is authoritative. The resolver retains profiles
  // only as a read-only migration bridge until the production backfill runs.
  const entitlement = await getCanonicalEntitlement(supabase, userId)
  const activeTier: Tier = entitlement.tier

  // Structured warnings so a "why isn't my tier applying" report is a log
  // grep away instead of a guessing game. None of these change behavior —
  // they just make the three most common misconfigurations visible:
  //   1. no profile row at all for this Clerk user id (wrong id, or the
  //      user was upgraded in a table Supabase-side that this route never reads)
  //   2. a tier string that doesn't match any VALID_TIERS entry (typo)
  //   3. a tier that resolved but whose tier_expires_at has already passed
  const maxChars = MARGIN_CHAR_LIMITS[activeTier]
  if (payload.logic.length > maxChars) {
    return NextResponse.json(
      {
        error: 'Payload too large.',
        code: ERROR_CODES.TIER_CHAR_LIMIT_EXCEEDED,
        message: `Tier [${activeTier.toUpperCase()}] allows up to ${maxChars} characters.`,
      },
      { status: 413, headers: jsonHeaders() },
    )
  }

  const tierFeatures = PLAN_FEATURES[activeTier]
  if (payload.profile === 'swarm' && !tierFeatures.includes('swarm_intelligence')) {
    return NextResponse.json(
      {
        error: 'Swarm Intelligence requires a Pro subscription.',
        code: ERROR_CODES.TIER_UPGRADE_REQUIRED,
        requiredFeature: 'swarm_intelligence',
      },
      { status: 403, headers: jsonHeaders() },
    )
  }
  // NOTE (policy gap, not a bug fixed silently): `core_heuristics` is
  // present on every tier in PLAN_FEATURES (free/go/plus/pro all include
  // it), so this check can never actually block exploit/patch access by
  // tier today — those two profiles are effectively gated by the
  // authorization-scope check below ONLY, not by plan. If exploit/patch
  // are meant to be Plus/Pro-only, remove 'core_heuristics' from
  // free/go in PLAN_FEATURES (types.ts) and this check will start
  // enforcing it. Left as-is here since that's a pricing decision, not
  // something to change without confirming intent.
  if ((payload.profile === 'exploit' || payload.profile === 'patch') && !tierFeatures.includes('core_heuristics')) {
    return NextResponse.json(
      {
        error: 'Advanced security profiles require an upgraded workspace.',
        code: ERROR_CODES.TIER_UPGRADE_REQUIRED,
        requiredFeature: 'core_heuristics',
      },
      { status: 403, headers: jsonHeaders() },
    )
  }

  // --- rate limit / message quota ---------------------------------------
  const clientIp = firstClientIp(req.headers)
  const rl = await checkRateLimit(redis, userId, activeTier, clientIp)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please wait before retrying.', code: ERROR_CODES.RATE_LIMITED },
      {
        status: 429,
        headers: jsonHeaders({
          'Retry-After': String(Math.ceil((rl.resetMs - Date.now()) / 1000)),
          'X-RateLimit-Remaining': '0',
        }),
      },
    )
  }

  const messageQuota = await checkMessageQuota(redis, userId, activeTier)
  if (!messageQuota.allowed) {
    const resetMinutes = Math.max(1, Math.ceil(messageQuota.resetSeconds / 60))
    return NextResponse.json(
      {
        error: 'Message quota exceeded.',
        code: ERROR_CODES.MESSAGE_QUOTA_EXCEEDED,
        message: `Tier [${activeTier.toUpperCase()}] allows ${
          messageQuota.limit
        } messages per 5-hour window. Resets in ${resetMinutes} minute(s).`,
      },
      {
        status: 429,
        headers: jsonHeaders({ 'Retry-After': String(messageQuota.resetSeconds), 'X-MessageQuota-Remaining': '0' }),
      },
    )
  }

  // ---------------------------------------------------------------------------
  // Authorization
  // ---------------------------------------------------------------------------
  const authDecision = await verifyAuthorization({
    supabase,
    redis,
    userId,
    profile: payload.profile,
    targetScope: payload.targetScope,
    extractedTargets: payload.extractedTargets,
    authorizationRef: payload.authorizationRef,
  })

  if (!authDecision.allowed) {
    return NextResponse.json(
      { error: authDecision.reason, code: ERROR_CODES.AUTHORIZATION_REQUIRED },
      { status: 403, headers: jsonHeaders() },
    )
  }

  // --- daily swarm cap (Pro only) ----------------------------------------
  if (FEATURE_FLAGS.swarmEnabled && activeTier === 'pro' && payload.profile === 'swarm') {
    const swarmCap = await checkSwarmDailyLimit(redis, userId)
    if (!swarmCap.allowed) {
      return NextResponse.json(
        { error: 'Daily Swarm quota exhausted. Resets at midnight UTC.', code: ERROR_CODES.SWARM_DAILY_LIMIT_EXCEEDED },
        { status: 429, headers: jsonHeaders() },
      )
    }
  }

  const promptPayload = buildPromptPayload(payload.logic, payload.conversation, maxChars)

  // Heavy requests stay on the same budgeted provider path as every other
  // request. The former Redis-only queue returned job IDs without a worker or
  // status contract, which could strand paid work indefinitely.

  const dailySpend = await readDailySpend(redis)
  const route = chooseModelRoute({ tier: activeTier, payload, promptLogic: promptPayload.promptLogic, dailySpend })

  const execSteps: string[] = [
    `Initializing isolated secure ${sanitizeLabel(payload.workspace, 'global')} parsing instance...`,
    `Applying ${payload.targetArch} runtime constraints...`,
    `Selected ${route.provider}/${route.model} via ${route.reason}.`,
  ]

  // --- DETERMINISTIC TELEMETRY START ---
  const traceEvents: TraceEvent[] = []

  traceEvents.push(buildReconEvent(promptPayload.promptLogic, `ev-${randomUUID().slice(0, 8)}`))
  traceEvents.push(buildFingerprintEvent(promptPayload.promptLogic, `ev-${randomUUID().slice(0, 8)}`))

  traceEvents.push({
    id: `ev-${randomUUID().slice(0, 8)}`,
    type: 'route',
    label: 'Optimal Inference Routing',
    status: 'completed',
    latencyMs: Date.now() - startedAt,
    routeInfo: { selectedRoute: route.mode.toUpperCase(), model: route.model, reason: route.reason },
  })
  if (promptPayload.compressedConversation) {
    execSteps.push(`Compressed conversation context; older turns compacted: ${promptPayload.olderTurnsCompressed}.`)
  }
  if (authDecision.scopeId) {
    execSteps.push(`Authorization scope ${authDecision.scopeId} verified.`)
  }

  const cacheable =
    FEATURE_FLAGS.cacheEnabled && route.cacheable && !hasSensitiveCacheMarkers(payload, promptPayload.promptLogic)
  const cacheKey = cacheable ? buildCacheKey(activeTier, payload, route, promptPayload.promptLogic) : ''

  if (cacheKey) {
    const cached = await readCachedResponse(redis, cacheKey)
    if (cached) {
      return respondFromCache({
        supabase,
        redis,
        cached,
        cacheKey,
        rl,
        messageQuota,
        activeTier,
        payload,
        startedAt,
        userId,
      })
    }
  }

  const systemCtx = buildSafeSystemContext({
    profile: payload.profile,
    targetArch: payload.targetArch,
    aggressiveness: payload.aggressiveness,
    autoRedact: payload.autoRedact,
    authorizationScopeId: authDecision.scopeId,
  })
  const userMsg = buildIsolatedUserMessage(promptPayload.promptLogic)

  const providerCallsReserved = route.mode === 'swarm' ? 3 : route.reason === 'adaptive-pro-confidence-gate' ? 4 : 1
  const inputTokenEstimate = estimateRequestTokens(
    buildSingleSystemPrompt(systemCtx, route.provider, payload.profile),
    userMsg,
  )
  const estimatedInputTokens = inputTokenEstimate * providerCallsReserved
  const estimatedOutputTokens = route.maxOutputTokens * providerCallsReserved
  const estimatedTokens = estimatedInputTokens + estimatedOutputTokens

  const reservation = await reserveMonthlyTokens(redis, userId, activeTier, estimatedTokens)
  if (!reservation.allowed) {
    return NextResponse.json(
      {
        error: 'Monthly quota exceeded.',
        code: ERROR_CODES.MONTHLY_TOKEN_BUDGET_EXCEEDED,
        message: `Tier [${activeTier.toUpperCase()}] monthly token budget is exhausted.`,
      },
      { status: 429, headers: jsonHeaders({ 'X-TokenBudget-Remaining': String(reservation.remainingTokens) }) },
    )
  }

  // Cost reservation runs alongside the token reservation above — a request
  // only proceeds if *both* succeed. This is what actually protects margin:
  // the token budget is blind to the 5-17x price gap between input and
  // output tokens across providers, this isn't.
  const estimatedPaise = estimateCostPaise(route.provider, estimatedInputTokens, estimatedOutputTokens)
  const costReservation = await reserveMonthlyCost(redis, userId, activeTier, estimatedPaise)
  if (!costReservation.allowed) {
    // nothing was spent — hand back the token reservation we just took
    await reconcileMonthlyTokens(redis, userId, activeTier, reservation.reservedTokens, 0)
    return NextResponse.json(
      {
        error: 'Monthly cost budget exceeded.',
        code: ERROR_CODES.MONTHLY_COST_BUDGET_EXCEEDED,
        message: `Tier [${activeTier.toUpperCase()}] monthly spend ceiling reached.`,
      },
      { status: 429, headers: jsonHeaders({ 'X-CostBudget-Remaining': String(costReservation.remainingPaise) }) },
    )
  }

  // --- streaming path -----------------------------------------------------
  const wantsStream = req.headers.get('accept')?.includes('text/event-stream') ?? false
  const streamEligible =
    FEATURE_FLAGS.streamingEnabled &&
    wantsStream &&
    route.mode === 'single' &&
    route.reason !== 'adaptive-pro-confidence-gate' // that path needs the full first-pass text before it can decide whether to run the swarm

  if (streamEligible) {
    const candidate = fallbackProviders(route.provider, dailySpend.forceCheapModels).find(
      (p) => providerAvailable(p) === true,
    )
    if (candidate && !(await isProviderCircuitOpen(redis, candidate))) {
      return streamSingleResponse({
        redis,
        supabase,
        provider: candidate,
        modelId: candidate === route.provider ? route.model : route.model,
        systemPrompt: buildSingleSystemPrompt(systemCtx, candidate, payload.profile),
        userMessage: userMsg,
        route,
        payload,
        activeTier,
        userId,
        reservedTokens: reservation.reservedTokens,
        reservedCostPaise: costReservation.reservedPaise,
        rl,
        messageQuota,
        authScopeId: authDecision.scopeId,
        authExpiresInHours: authDecision.expiresInHours,
        execSteps,
        cacheKey,
      })
    }
    // fall through to the normal non-streaming path if nothing is available to stream from
  }

  // --- standard (non-streaming) path ---------------------------------------
  execSteps.push(
    route.mode === 'swarm'
      ? 'Executing adaptive Red / Blue / Architect swarm.'
      : 'Executing single-agent model analysis.',
  )

  let result
  const llmStartTime = Date.now() // execution start time, used for reasoning-step latency

  try {
    result = await executeRoute({
      redis,
      profile: payload.profile,
      route,
      systemCtx,
      userMessage: userMsg,
      cheapOnly: dailySpend.forceCheapModels,
      execSteps,
    })
  } catch (err) {
    await reconcileMonthlyTokens(redis, userId, activeTier, reservation.reservedTokens, 0)
    await reconcileMonthlyCost(redis, userId, activeTier, costReservation.reservedPaise, 0)

    if (err instanceof SwarmParseError) {
      log.error('swarm_parse_failure', { error: err.message })
      return NextResponse.json(
        {
          error: 'Consensus Generation Error',
          code: ERROR_CODES.SWARM_CONSENSUS_FAILURE,
          message: 'Swarm engines failed to produce a coherent report. Execution halted.',
        },
        { status: 502, headers: jsonHeaders() },
      )
    }

    log.error('model_execution_failure', { error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json(
      { error: 'All model providers failed. Please retry shortly.', code: ERROR_CODES.PROVIDER_FAILURE },
      { status: 502, headers: jsonHeaders() },
    )
  }

  const totalTokens = result.tokensIn + result.tokensOut
  const monthlyTokenRemaining = await reconcileMonthlyTokens(
    redis,
    userId,
    activeTier,
    reservation.reservedTokens,
    totalTokens,
  )
  const costPaise = estimateCostPaise(result.provider, result.tokensIn, result.tokensOut)
  const monthlyCostRemaining = await reconcileMonthlyCost(
    redis,
    userId,
    activeTier,
    costReservation.reservedPaise,
    costPaise,
  )
  const dailyAfterSpend = await recordDailySpend(redis, costPaise)
  const revenuePaise = allocatedRevenuePaise(activeTier, totalTokens)
  const profitPaise = revenuePaise - costPaise
  const latencyMs = Date.now() - startedAt

  if (result.fallbackTrail.length > 0) execSteps.push(`Fallback trail: ${result.fallbackTrail.join(' -> ')}.`)

  traceEvents.push({
    id: `ev-${randomUUID().slice(0, 8)}`,
    type: 'reasoning',
    label: route.mode === 'swarm' ? 'Swarm Consensus Execution' : 'AST & Control Flow Execution',
    detail: 'Heuristic engine evaluated input sanitization and interpolation matrices.',
    status: 'completed',
    latencyMs: Date.now() - llmStartTime,
  })

  // --- Grounded structured findings (Plus/Pro only — costs one extra call) ---
  // Gated behind the same feature flag as other deep-analysis features so it
  // doesn't silently blow the margin ledger for free/go tiers. Reuses the
  // existing reserve → reconcile pattern so this call is properly accounted
  // against MONTHLY_TOKEN_BUDGETS and MONTHLY_COST_BUDGET_PAISE, not free.
  //
  // route.ts's role here is strictly budget bookkeeping: reserve tokens and
  // cost, hand the call to extractStructuredFinding() in providers.ts (which
  // owns provider selection, the circuit breaker, and retry), then reconcile
  // based on whatever it returns. It never builds a LanguageModel or calls
  // generateObject() itself — that stays behind the provider boundary.
  let structuredFinding: StructuredFinding | null = null
  // Plus/Pro gate — same threshold decides whether we pay for the extra
  // extraction call below AND whether traceEvents is present in the response
  // at all (see the tier strip in the final response and in respondFromCache).
  const traceLogsEnabled = tierFeatures.includes('interactive_topology')

  if (traceLogsEnabled) {
    const findingInputTokens = estimateRequestTokens('', `${userMsg}\n${result.text}`)
    const findingOutputTokens = 500 // bumped slightly to leave room for the sources array
    const findingReservation = await reserveMonthlyTokens(
      redis,
      userId,
      activeTier,
      findingInputTokens + findingOutputTokens,
    )
    const findingPaiseEstimate = estimateCostPaise(result.provider, findingInputTokens, findingOutputTokens)
    const findingCostReservation = findingReservation.allowed
      ? await reserveMonthlyCost(redis, userId, activeTier, findingPaiseEstimate)
      : { allowed: false as const, reservedPaise: 0 }

    if (findingReservation.allowed && findingCostReservation.allowed) {
      const finding = await extractStructuredFinding({
        redis,
        provider: result.provider,
        modelId: result.model,
        system:
          'Extract structured findings from a completed security analysis. Only report ' +
          'what the analysis actually concluded — if it found no vulnerability, set risk ' +
          'to null rather than inventing one. Evidence strings must cite specifics from ' +
          'the analysis text, not generic boilerplate. Every verification and every risk ' +
          'object must also include a `sources` array: one entry per distinct fact you ' +
          'relied on, each with a `type` (code_location, cwe, owasp, cve, documentation, ' +
          'or analysis_text), a short `label`, and — where one exists in the analysis — a ' +
          '`locator` such as a line reference, a CWE/CVE id, or the exact phrase in the ' +
          'analysis text the claim is grounded in. Never invent a locator; omit it rather ' +
          'than guess. If you cannot point to a real source for a claim, drop the claim.',
        prompt: `Original input:\n${userMsg}\n\nCompleted analysis:\n${result.text}`,
        schema: StructuredFindingSchema,
        maxOutputTokens: findingOutputTokens,
      })

      if (finding) {
        structuredFinding = finding.value
        await reconcileMonthlyTokens(
          redis,
          userId,
          activeTier,
          findingReservation.reservedTokens,
          finding.usage.inputTokens + finding.usage.outputTokens,
        )
        await reconcileMonthlyCost(
          redis,
          userId,
          activeTier,
          findingCostReservation.reservedPaise,
          estimateCostPaise(result.provider, finding.usage.inputTokens, finding.usage.outputTokens),
        )
      } else {
        // extractStructuredFinding() already logged the failure and tripped
        // the circuit breaker if warranted — route.ts's only remaining job
        // is to give back the reservation it took for a call that never
        // produced billable usage.
        await reconcileMonthlyTokens(redis, userId, activeTier, findingReservation.reservedTokens, 0)
        await reconcileMonthlyCost(redis, userId, activeTier, findingCostReservation.reservedPaise, 0)
      }
    } else if (findingReservation.allowed) {
      await reconcileMonthlyTokens(redis, userId, activeTier, findingReservation.reservedTokens, 0)
    }
  }

  if (structuredFinding) {
    traceEvents.push({
      id: `ev-${randomUUID().slice(0, 8)}`,
      type: 'verification',
      label: 'Security Rule Validation',
      ...structuredFinding.verification,
    })
    if (structuredFinding.risk) {
      traceEvents.push({
        id: `ev-${randomUUID().slice(0, 8)}`,
        type: 'risk',
        label: 'Vulnerability Threat Matrix',
        ...structuredFinding.risk,
      })
    }
  }

  traceEvents.push({
    id: `ev-${randomUUID().slice(0, 8)}`,
    type: 'synthesis',
    label: 'Compiling Final Report',
    detail: 'Synthesized execution logs and evidence trail for frontend delivery.',
    status: 'completed',
    latencyMs: Date.now() - startedAt,
  })

  const response: ExecutionResponse = {
    analysis: result.text,
    steps: execSteps,
    status: 'completed',
    swarmConsensus: result.swarmConsensus,
    traceEvents,
    metrics: {
      latencyMs,
      tokensUsed: totalTokens,
      tokensReserved: reservation.reservedTokens,
      monthlyTokenRemaining,
      confidenceScore: result.confidenceScore,
      rateLimitRemaining: rl.remaining,
      provider: result.provider,
      model: result.model,
      routeMode: result.mode,
      complexity: route.complexity,
      estimatedCostInr: costPaise / 100,
      estimatedProfitInr: profitPaise / 100,
      cacheHit: false,
      dailySpendRemainingInr: Math.max(0, dailyAfterSpend.budgetPaise - dailyAfterSpend.usedPaise) / 100,
      fallbackUsed: result.fallbackTrail.length > 0,
      providerRetryCount: result.providerRetryCount,
      requestSizeChars: payload.logic.length,
      swarmUsed: result.mode === 'swarm',
      messageQuotaLimit: messageQuota.limit,
      messageQuotaRemaining: messageQuota.remaining,
      messageQuotaResetSeconds: messageQuota.resetSeconds,
      authorizationScopeId: authDecision.scopeId,
      authorizationExpiresInHours: authDecision.expiresInHours,
    },
  }

  await logUsage(supabase, {
    user_id: userId,
    tier: activeTier,
    profile: payload.profile,
    provider: result.provider,
    model: result.model,
    route_mode: result.mode,
    complexity: route.complexity,
    tokens_in: result.tokensIn,
    tokens_out: result.tokensOut,
    tokens_total: totalTokens,
    estimated_cost_paise: costPaise,
    allocated_revenue_paise: revenuePaise,
    estimated_profit_paise: profitPaise,
    latency_ms: latencyMs,
    provider_retry_count: result.providerRetryCount,
    fallback_used: result.fallbackTrail.length > 0,
    cache_key: cacheKey || null,
    swarm_used: result.mode === 'swarm',
    confidence_score: result.confidenceScore,
    request_size_chars: payload.logic.length,
    cache_hit: false,
    authorization_scope_id: authDecision.scopeId,
  })

  if (cacheKey) void writeCachedResponse(redis, cacheKey, response)

  return NextResponse.json(response, {
    headers: jsonHeaders({
      'X-RateLimit-Remaining': String(rl.remaining),
      'X-TokenBudget-Remaining': String(monthlyTokenRemaining),
      'X-CostBudget-Remaining': String(monthlyCostRemaining),
      'X-MessageQuota-Remaining': String(messageQuota.remaining),
      'X-Cache': 'MISS',
    }),
  })
}

// ---------------------------------------------------------------------------
// Cache-hit response
// ---------------------------------------------------------------------------

async function respondFromCache(args: {
  supabase: SupabaseClient
  redis: Redis
  cached: ExecutionResponse
  cacheKey: string
  rl: { remaining: number }
  messageQuota: { limit: number; remaining: number; resetSeconds: number }
  activeTier: Tier
  payload: ExecutionPayload
  startedAt: number
  userId: string
}): Promise<NextResponse> {
  const { supabase, redis, cached, cacheKey, rl, messageQuota, activeTier, payload, startedAt, userId } = args
  const latencyMs = Date.now() - startedAt
  const monthlyUsed = await readMonthlyTokenUsage(redis, userId, activeTier)
  const dailyAfterCache = await readDailySpend(redis)

  const metrics: ResponseMetrics = {
    ...cached.metrics,
    latencyMs,
    tokensUsed: 0,
    tokensReserved: 0,
    monthlyTokenRemaining: Math.max(0, MONTHLY_TOKEN_BUDGETS[activeTier] - monthlyUsed),
    rateLimitRemaining: rl.remaining,
    provider: 'cache',
    routeMode: 'cache',
    estimatedCostInr: 0,
    estimatedProfitInr: 0,
    cacheHit: true,
    dailySpendRemainingInr: Math.max(0, dailyAfterCache.budgetPaise - dailyAfterCache.usedPaise) / 100,
    fallbackUsed: false,
    providerRetryCount: 0,
    requestSizeChars: payload.logic.length,
    swarmUsed: false,
    messageQuotaLimit: messageQuota.limit,
    messageQuotaRemaining: messageQuota.remaining,
    messageQuotaResetSeconds: messageQuota.resetSeconds,
  }

  await logUsage(supabase, {
    user_id: userId,
    tier: activeTier,
    profile: payload.profile,
    provider: 'cache',
    model: cached.metrics.model,
    route_mode: 'cache',
    complexity: cached.metrics.complexity,
    tokens_in: 0,
    tokens_out: 0,
    tokens_total: 0,
    estimated_cost_paise: 0,
    allocated_revenue_paise: 0,
    estimated_profit_paise: 0,
    latency_ms: latencyMs,
    provider_retry_count: 0,
    fallback_used: false,
    cache_key: cacheKey,
    swarm_used: false,
    confidence_score: metrics.confidenceScore,
    request_size_chars: payload.logic.length,
    cache_hit: true,
    authorization_scope_id: metrics.authorizationScopeId,
  })

  return NextResponse.json(
    { ...cached, steps: [...cached.steps, 'Returned from response cache.'], metrics },
    {
      headers: jsonHeaders({
        'X-RateLimit-Remaining': String(rl.remaining),
        'X-MessageQuota-Remaining': String(messageQuota.remaining),
        'X-Cache': 'HIT',
      }),
    },
  )
}

// ---------------------------------------------------------------------------
// Streaming (SSE) response
// ---------------------------------------------------------------------------

function sseFrame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function streamSingleResponse(args: {
  redis: Redis
  supabase: SupabaseClient
  provider: Parameters<typeof streamProvider>[0]['provider']
  modelId: string
  systemPrompt: string
  userMessage: string
  route: ReturnType<typeof chooseModelRoute>
  payload: ExecutionPayload
  activeTier: Tier
  userId: string
  reservedTokens: number
  reservedCostPaise: number
  rl: { remaining: number }
  messageQuota: { limit: number; remaining: number; resetSeconds: number }
  authScopeId: string | null
  authExpiresInHours: number | null
  execSteps: string[]
  cacheKey: string
}): NextResponse {
  const {
    redis,
    supabase,
    provider,
    modelId,
    systemPrompt,
    userMessage,
    route,
    payload,
    activeTier,
    userId,
    reservedTokens,
    reservedCostPaise,
  } = args

  const run = streamProvider({
    provider,
    modelId,
    systemPrompt,
    userMessage,
    maxOutputTokens: route.maxOutputTokens,
    temperature: route.temperature,
  })

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(sseFrame('steps', args.execSteps))
      try {
        for await (const chunk of run.textStream) {
          controller.enqueue(sseFrame('token', { text: chunk }))
        }
      } catch (err) {
        controller.enqueue(sseFrame('error', { message: err instanceof Error ? err.message : 'stream failed' }))
      } finally {
        controller.enqueue(encoder.encode('event: done\ndata: {}\n\n'))
        controller.close()
      }
    },
  })

  // Runs after the response has been fully sent to the client — token
  // reconciliation, cost/usage logging, and the circuit breaker don't hold
  // up the stream.
  after(async () => {
    try {
      const [usage, text] = await Promise.all([run.result.usage, run.result.text])
      const totalTokens = usage.inputTokens + usage.outputTokens
      await reconcileMonthlyTokens(redis, userId, activeTier, reservedTokens, totalTokens)
      const costPaise = estimateCostPaise(provider, usage.inputTokens, usage.outputTokens)
      await reconcileMonthlyCost(redis, userId, activeTier, reservedCostPaise, costPaise)
      await recordDailySpend(redis, costPaise)
      await markProviderSuccess(redis, provider)

      await logUsage(supabase, {
        user_id: userId,
        tier: activeTier,
        profile: payload.profile,
        provider,
        model: modelId,
        route_mode: 'single',
        complexity: route.complexity,
        tokens_in: usage.inputTokens,
        tokens_out: usage.outputTokens,
        tokens_total: totalTokens,
        estimated_cost_paise: costPaise,
        allocated_revenue_paise: allocatedRevenuePaise(activeTier, totalTokens),
        estimated_profit_paise: allocatedRevenuePaise(activeTier, totalTokens) - costPaise,
        latency_ms: 0,
        provider_retry_count: 0,
        fallback_used: false,
        cache_key: args.cacheKey || null,
        swarm_used: false,
        confidence_score: 0,
        request_size_chars: payload.logic.length,
        cache_hit: false,
        authorization_scope_id: args.authScopeId,
      })

      if (args.cacheKey && route.cacheable) {
        const response: ExecutionResponse = {
          analysis: text,
          steps: [...args.execSteps, 'Streamed response.'],
          status: 'completed',
          metrics: {
            latencyMs: 0,
            tokensUsed: totalTokens,
            tokensReserved: reservedTokens,
            monthlyTokenRemaining: 0,
            confidenceScore: 0,
            rateLimitRemaining: args.rl.remaining,
            provider,
            model: modelId,
            routeMode: 'single',
            complexity: route.complexity,
            estimatedCostInr: costPaise / 100,
            estimatedProfitInr: 0,
            cacheHit: false,
            dailySpendRemainingInr: 0,
            fallbackUsed: false,
            providerRetryCount: 0,
            requestSizeChars: payload.logic.length,
            swarmUsed: false,
            messageQuotaLimit: args.messageQuota.limit,
            messageQuotaRemaining: args.messageQuota.remaining,
            messageQuotaResetSeconds: args.messageQuota.resetSeconds,
            authorizationScopeId: args.authScopeId,
            authorizationExpiresInHours: args.authExpiresInHours,
          },
        }
        await writeCachedResponse(redis, args.cacheKey, response)
      }
    } catch (err) {
      await markProviderFailure(redis, provider)
      log.error('stream_reconcile_failed', { error: err instanceof Error ? err.message : String(err) })
      // Best-effort: give back the full reservation so a failed stream
      // doesn't silently eat into the user's monthly budget.
      await reconcileMonthlyTokens(redis, userId, activeTier, reservedTokens, 0)
      await reconcileMonthlyCost(redis, userId, activeTier, reservedCostPaise, 0)
    }
  })

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-cache',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
      'X-RateLimit-Remaining': String(args.rl.remaining),
      'X-MessageQuota-Remaining': String(args.messageQuota.remaining),
    },
  })
}
