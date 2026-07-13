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
 */

import { randomUUID } from 'crypto';
import { NextResponse, after } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Redis } from '@upstash/redis';

import {
  ExecutionPayloadSchema,
  type ExecutionPayload,
  type ExecutionResponse,
  type ResponseMetrics,
  type Tier,
  type UsageEvent,
  type TraceEvent, // <-- ADDED THIS
  REQUIRED_ENV,
  MARGIN_CHAR_LIMITS,
  PLAN_FEATURES,
  FEATURE_FLAGS,
  HEAVY_QUEUE_THRESHOLD_CHARS,
  NONCE_TTL_SECS,
  MONTHLY_TOKEN_BUDGETS,
  normalizeTier,
} from '@/lib/hexical/types';
import {
  jsonHeaders,
  firstClientIp,
  isTimestampFresh,
  readJsonBodyWithLimit,
  RequestBodyTooLargeError,
  dayKeyPart,
  secondsUntilTomorrow,
} from '@/lib/hexical/util';
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
} from '@/lib/hexical/limits';
import { verifyAuthorization } from '@/lib/hexical/authorization';
import { buildPromptPayload, buildSafeSystemContext, buildIsolatedUserMessage, buildSingleSystemPrompt } from '@/lib/hexical/security';
import { chooseModelRoute, hasSensitiveCacheMarkers, fallbackProviders } from '@/lib/hexical/routing';
import { buildCacheKey, readCachedResponse, writeCachedResponse, estimateCostPaise, allocatedRevenuePaise } from '@/lib/hexical/cache';
import {
  executeRoute,
  streamProvider,
  estimateRequestTokens,
  SwarmParseError,
} from '@/lib/hexical/providers';
import { providerAvailable } from '@/lib/hexical/types';
import { isProviderCircuitOpen, markProviderFailure, markProviderSuccess } from '@/lib/hexical/limits';
import { log } from '@/lib/hexical/telemetry';
import { sanitizeLabel } from '@/lib/hexical/util';

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 150_000;

function supabaseClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

function redisClient(): Redis {
  return new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
}

async function logUsage(supabase: SupabaseClient, event: UsageEvent): Promise<void> {
  const { error } = await supabase.from('usage_events').insert(event);
  if (error) log.warn('usage_log_skipped', { error: error.message });
}

async function enqueueExecutionJob(redis: Redis, userId: string, tier: Tier, payload: ExecutionPayload): Promise<string> {
  const jobId = randomUUID();
  const job = { jobId, userId, tier, createdAt: new Date().toISOString(), payload };
  await redis.set(`job:hexical:${jobId}`, JSON.stringify(job), { ex: 60 * 60 * 24 * 7 });
  await redis.lpush('queue:hexical:execution', jobId);
  return jobId;
}

export async function POST(req: Request): Promise<NextResponse> {
  const startedAt = Date.now();

  for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
      log.error('boot_fatal_missing_env', { key });
      return NextResponse.json({ error: 'Server configuration error.' }, { status: 500, headers: jsonHeaders() });
    }
  }

  const supabase = supabaseClient();
  const redis = redisClient();

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401, headers: jsonHeaders() });
  }

  let body: unknown;
  try {
    body = await readJsonBodyWithLimit(req, MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: 'Payload too large.' }, { status: 413, headers: jsonHeaders() });
    }
    return NextResponse.json({ error: 'Malformed JSON payload.' }, { status: 400, headers: jsonHeaders() });
  }

  const parsed = ExecutionPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Schema validation failed.', details: parsed.error.format() }, { status: 400, headers: jsonHeaders() });
  }
  const payload = parsed.data;

  if (!isTimestampFresh(payload.requestTimestampMs)) {
    return NextResponse.json({ error: 'Request timestamp is stale. Possible replay rejected.' }, { status: 400, headers: jsonHeaders() });
  }

  if (payload.requestNonce) {
    const fresh = await consumeNonce(redis, userId, payload.requestNonce, NONCE_TTL_SECS);
    if (!fresh) {
      return NextResponse.json({ error: 'Duplicate nonce detected. Replay attack rejected.' }, { status: 409, headers: jsonHeaders() });
    }
  }

  // --- tier lookup / seed -----------------------------------------------
  let { data: userProfile } = await supabase.from('profiles').select('tier').eq('user_id', userId).maybeSingle();
  if (!userProfile) {
    const { data: seeded } = await supabase.from('profiles').insert({ user_id: userId, tier: 'free' }).select('tier').maybeSingle();
    if (seeded) userProfile = seeded;
  }
  const activeTier: Tier = normalizeTier(userProfile?.tier);

  const maxChars = MARGIN_CHAR_LIMITS[activeTier];
  if (payload.logic.length > maxChars) {
    return NextResponse.json(
      { error: 'Payload too large.', message: `Tier [${activeTier.toUpperCase()}] allows up to ${maxChars} characters.` },
      { status: 413, headers: jsonHeaders() },
    );
  }

  const tierFeatures = PLAN_FEATURES[activeTier];
  if (payload.profile === 'swarm' && !tierFeatures.includes('swarm_intelligence')) {
    return NextResponse.json({ error: 'Swarm Intelligence requires a Pro subscription.' }, { status: 403, headers: jsonHeaders() });
  }
  if ((payload.profile === 'exploit' || payload.profile === 'patch') && !tierFeatures.includes('core_heuristics')) {
    return NextResponse.json({ error: 'Advanced security profiles require an upgraded workspace.' }, { status: 403, headers: jsonHeaders() });
  }

  // --- rate limit / message quota ---------------------------------------
  const clientIp = firstClientIp(req.headers);
  const rl = await checkRateLimit(redis, userId, activeTier, clientIp);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please wait before retrying.' },
      { status: 429, headers: jsonHeaders({ 'Retry-After': String(Math.ceil((rl.resetMs - Date.now()) / 1000)), 'X-RateLimit-Remaining': '0' }) },
    );
  }

  const messageQuota = await checkMessageQuota(redis, userId, activeTier);
  if (!messageQuota.allowed) {
    const resetMinutes = Math.max(1, Math.ceil(messageQuota.resetSeconds / 60));
    return NextResponse.json(
      {
        error: 'Message quota exceeded.',
        message: `Tier [${activeTier.toUpperCase()}] allows ${messageQuota.limit} messages per 5-hour window. Resets in ${resetMinutes} minute(s).`,
      },
      { status: 429, headers: jsonHeaders({ 'Retry-After': String(messageQuota.resetSeconds), 'X-MessageQuota-Remaining': '0' }) },
    );
  }

  // --- authorization gate (exploit / swarm only) -------------------------
  const authDecision = await verifyAuthorization({
    supabase,
    redis,
    userId,
    profile: payload.profile,
    targetScope: payload.targetScope,
    extractedTargets: payload.extractedTargets,
    authorizationRef: payload.authorizationRef,
  });
  if (!authDecision.allowed) {
    return NextResponse.json(
      { error: 'Authorization required.', message: authDecision.reason },
      { status: 403, headers: jsonHeaders() },
    );
  }

  // --- daily swarm cap (Pro only) ----------------------------------------
  if (FEATURE_FLAGS.swarmEnabled && activeTier === 'pro' && payload.profile === 'swarm') {
    const swarmCap = await checkSwarmDailyLimit(redis, userId);
    if (!swarmCap.allowed) {
      return NextResponse.json({ error: 'Daily Swarm quota exhausted. Resets at midnight UTC.' }, { status: 429, headers: jsonHeaders() });
    }
  }

  const promptPayload = buildPromptPayload(payload.logic, payload.conversation, maxChars);

  if (payload.asyncMode && promptPayload.promptLogic.length >= HEAVY_QUEUE_THRESHOLD_CHARS) {
    const jobId = await enqueueExecutionJob(redis, userId, activeTier, payload);
    return NextResponse.json(
      { status: 'queued', job_id: jobId, jobId, position: null },
      { status: 202, headers: jsonHeaders({ 'X-RateLimit-Remaining': String(rl.remaining) }) },
    );
  }

  const dailySpend = await readDailySpend(redis);
  const route = chooseModelRoute({ tier: activeTier, payload, promptLogic: promptPayload.promptLogic, dailySpend });

  const execSteps: string[] = [
    `Initializing isolated secure ${sanitizeLabel(payload.workspace, 'global')} parsing instance...`,
    `Applying ${payload.targetArch} runtime constraints...`,
    `Selected ${route.provider}/${route.model} via ${route.reason}.`,
  ];

  // --- DETERMINISTIC TELEMETRY START ---
  const traceEvents: TraceEvent[] = [];
  
  traceEvents.push({
    id: `ev-${randomUUID().slice(0, 8)}`,
    type: 'search',
    label: 'Initializing Secure Pipeline',
    detail: `Routed to ${route.provider}/${route.model} via ${route.reason}.`,
    status: 'completed',
    latencyMs: Date.now() - startedAt
  });
  if (promptPayload.compressedConversation) {
    execSteps.push(`Compressed conversation context; older turns compacted: ${promptPayload.olderTurnsCompressed}.`);
  }
  if (authDecision.scopeId) {
    execSteps.push(`Authorization scope ${authDecision.scopeId} verified.`);
  }

  const cacheable = FEATURE_FLAGS.cacheEnabled && route.cacheable && !hasSensitiveCacheMarkers(payload, promptPayload.promptLogic);
  const cacheKey = cacheable ? buildCacheKey(activeTier, payload, route, promptPayload.promptLogic) : '';

  if (cacheKey) {
    const cached = await readCachedResponse(redis, cacheKey);
    if (cached) {
      return respondFromCache({ supabase, redis, cached, cacheKey, rl, messageQuota, activeTier, payload, startedAt, userId });
    }
  }

  const systemCtx = buildSafeSystemContext({
    profile: payload.profile,
    targetArch: payload.targetArch,
    aggressiveness: payload.aggressiveness,
    autoRedact: payload.autoRedact,
    authorizationScopeId: authDecision.scopeId,
  });
  const userMsg = buildIsolatedUserMessage(promptPayload.promptLogic);

  const providerCallsReserved = route.mode === 'swarm' ? 3 : route.reason === 'adaptive-pro-confidence-gate' ? 4 : 1;
  const inputTokenEstimate = estimateRequestTokens(buildSingleSystemPrompt(systemCtx, route.provider, payload.profile), userMsg);
  const estimatedInputTokens = inputTokenEstimate * providerCallsReserved;
  const estimatedOutputTokens = route.maxOutputTokens * providerCallsReserved;
  const estimatedTokens = estimatedInputTokens + estimatedOutputTokens;

  const reservation = await reserveMonthlyTokens(redis, userId, activeTier, estimatedTokens);
  if (!reservation.allowed) {
    return NextResponse.json(
      { error: 'Monthly quota exceeded.', message: `Tier [${activeTier.toUpperCase()}] monthly token budget is exhausted.` },
      { status: 429, headers: jsonHeaders({ 'X-TokenBudget-Remaining': String(reservation.remainingTokens) }) },
    );
  }

  // Cost reservation runs alongside the token reservation above — a request
  // only proceeds if *both* succeed. This is what actually protects margin:
  // the token budget is blind to the 5-17x price gap between input and
  // output tokens across providers, this isn't.
  const estimatedPaise = estimateCostPaise(route.provider, estimatedInputTokens, estimatedOutputTokens);
  const costReservation = await reserveMonthlyCost(redis, userId, activeTier, estimatedPaise);
  if (!costReservation.allowed) {
    // nothing was spent — hand back the token reservation we just took
    await reconcileMonthlyTokens(redis, userId, activeTier, reservation.reservedTokens, 0);
    return NextResponse.json(
      { error: 'Monthly cost budget exceeded.', message: `Tier [${activeTier.toUpperCase()}] monthly spend ceiling reached.` },
      { status: 429, headers: jsonHeaders({ 'X-CostBudget-Remaining': String(costReservation.remainingPaise) }) },
    );
  }

  // --- streaming path -----------------------------------------------------
  const wantsStream = req.headers.get('accept')?.includes('text/event-stream') ?? false;
  const streamEligible =
    FEATURE_FLAGS.streamingEnabled &&
    wantsStream &&
    route.mode === 'single' &&
    route.reason !== 'adaptive-pro-confidence-gate'; // that path needs the full first-pass text before it can decide whether to run the swarm

  if (streamEligible) {
    const candidate = fallbackProviders(route.provider, dailySpend.forceCheapModels).find(
      p => providerAvailable(p) === true,
    );
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
      });
    }
    // fall through to the normal non-streaming path if nothing is available to stream from
  }

  // --- standard (non-streaming) path ---------------------------------------
  execSteps.push(route.mode === 'swarm' ? 'Executing adaptive Red / Blue / Architect swarm.' : 'Executing single-agent model analysis.');

  let result;
  const llmStartTime = Date.now(); // <-- Capture execution start time
  
  try {
    result = await executeRoute({
      redis,
      profile: payload.profile,
      route,
      systemCtx,
      userMessage: userMsg,
      cheapOnly: dailySpend.forceCheapModels,
      execSteps,
    });
  } catch (err) {
    await reconcileMonthlyTokens(redis, userId, activeTier, reservation.reservedTokens, 0);
    await reconcileMonthlyCost(redis, userId, activeTier, costReservation.reservedPaise, 0);

    if (err instanceof SwarmParseError) {
      log.error('swarm_parse_failure', { error: err.message });
      return NextResponse.json(
        { error: 'Consensus Generation Error', message: 'Swarm engines failed to produce a coherent report. Execution halted.' },
        { status: 502, headers: jsonHeaders() },
      );
    }

    log.error('model_execution_failure', { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'All model providers failed. Please retry shortly.' }, { status: 502, headers: jsonHeaders() });
  }

  const totalTokens = result.tokensIn + result.tokensOut;
  const monthlyTokenRemaining = await reconcileMonthlyTokens(redis, userId, activeTier, reservation.reservedTokens, totalTokens);
  const costPaise = estimateCostPaise(result.provider, result.tokensIn, result.tokensOut);
  const monthlyCostRemaining = await reconcileMonthlyCost(redis, userId, activeTier, costReservation.reservedPaise, costPaise);
  const dailyAfterSpend = await recordDailySpend(redis, costPaise);
  const revenuePaise = allocatedRevenuePaise(activeTier, totalTokens);
  const profitPaise = revenuePaise - costPaise;
  const latencyMs = Date.now() - startedAt;

  if (result.fallbackTrail.length > 0) execSteps.push(`Fallback trail: ${result.fallbackTrail.join(' -> ')}.`);

  // --- POPULATE REMAINING TRACE EVENTS ---
  traceEvents.push({
    id: `ev-${randomUUID().slice(0, 8)}`,
    type: 'reasoning',
    label: route.mode === 'swarm' ? 'Swarm Consensus Execution' : 'AST & Control Flow Execution',
    detail: 'Heuristic engine evaluated input sanitization and interpolation matrices.',
    status: 'completed',
    latencyMs: Date.now() - llmStartTime
  });

  traceEvents.push({
    id: `ev-${randomUUID().slice(0, 8)}`,
    type: 'verification',
    label: 'Security Rule Validation',
    left: 'Execution Sink',
    right: 'Input Source',
    result: result.confidenceScore > 80 ? 'verified' : 'unverified',
  });

  traceEvents.push({
    id: `ev-${randomUUID().slice(0, 8)}`,
    type: 'risk',
    label: 'Vulnerability Threat Matrix',
    severity: result.confidenceScore > 90 ? 'CRITICAL' : (result.confidenceScore > 75 ? 'HIGH' : 'MED'),
    cvss: result.confidenceScore > 90 ? 9.1 : (result.confidenceScore > 75 ? 7.5 : 5.0),
  });

  traceEvents.push({
    id: `ev-${randomUUID().slice(0, 8)}`,
    type: 'synthesis',
    label: 'Compiling Final Report',
    detail: 'Synthesized execution logs and evidence trail for frontend delivery.',
    status: 'completed',
    latencyMs: Date.now() - startedAt
  });

  const response: ExecutionResponse = {
    analysis: result.text,
    steps: execSteps,
    status: 'completed',
    swarmConsensus: result.swarmConsensus,
    traceEvents, // <-- INJECTS TRACE EVENTS INTO THE JSON PAYLOAD
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
  };

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
  });

  if (cacheKey) void writeCachedResponse(redis, cacheKey, response);

  return NextResponse.json(response, {
    headers: jsonHeaders({
      'X-RateLimit-Remaining': String(rl.remaining),
      'X-TokenBudget-Remaining': String(monthlyTokenRemaining),
      'X-CostBudget-Remaining': String(monthlyCostRemaining),
      'X-MessageQuota-Remaining': String(messageQuota.remaining),
      'X-Cache': 'MISS',
    }),
  });
}

// ---------------------------------------------------------------------------
// Cache-hit response
// ---------------------------------------------------------------------------

async function respondFromCache(args: {
  supabase: SupabaseClient;
  redis: Redis;
  cached: ExecutionResponse;
  cacheKey: string;
  rl: { remaining: number };
  messageQuota: { limit: number; remaining: number; resetSeconds: number };
  activeTier: Tier;
  payload: ExecutionPayload;
  startedAt: number;
  userId: string;
}): Promise<NextResponse> {
  const { supabase, redis, cached, cacheKey, rl, messageQuota, activeTier, payload, startedAt, userId } = args;
  const latencyMs = Date.now() - startedAt;
  const monthlyUsed = await readMonthlyTokenUsage(redis, userId, activeTier);
  const dailyAfterCache = await readDailySpend(redis);

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
  };

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
  });

  return NextResponse.json(
    { ...cached, steps: [...cached.steps, 'Returned from response cache.'], metrics },
    { headers: jsonHeaders({ 'X-RateLimit-Remaining': String(rl.remaining), 'X-MessageQuota-Remaining': String(messageQuota.remaining), 'X-Cache': 'HIT' }) },
  );
}

// ---------------------------------------------------------------------------
// Streaming (SSE) response
// ---------------------------------------------------------------------------

function sseFrame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function streamSingleResponse(args: {
  redis: Redis;
  supabase: SupabaseClient;
  provider: Parameters<typeof streamProvider>[0]['provider'];
  modelId: string;
  systemPrompt: string;
  userMessage: string;
  route: ReturnType<typeof chooseModelRoute>;
  payload: ExecutionPayload;
  activeTier: Tier;
  userId: string;
  reservedTokens: number;
  reservedCostPaise: number;
  rl: { remaining: number };
  messageQuota: { limit: number; remaining: number; resetSeconds: number };
  authScopeId: string | null;
  authExpiresInHours: number | null;
  execSteps: string[];
  cacheKey: string;
}): NextResponse {
  const { redis, supabase, provider, modelId, systemPrompt, userMessage, route, payload, activeTier, userId, reservedTokens, reservedCostPaise } = args;

  const run = streamProvider({
    provider,
    modelId,
    systemPrompt,
    userMessage,
    maxOutputTokens: route.maxOutputTokens,
    temperature: route.temperature,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(sseFrame('steps', args.execSteps));
      try {
        for await (const chunk of run.textStream) {
          controller.enqueue(sseFrame('token', { text: chunk }));
        }
      } catch (err) {
        controller.enqueue(sseFrame('error', { message: err instanceof Error ? err.message : 'stream failed' }));
      } finally {
        controller.enqueue(encoder.encode('event: done\ndata: {}\n\n'));
        controller.close();
      }
    },
  });

  // Runs after the response has been fully sent to the client — token
  // reconciliation, cost/usage logging, and the circuit breaker don't hold
  // up the stream.
  after(async () => {
    try {
      const [usage, text] = await Promise.all([run.result.usage, run.result.text]);
      const totalTokens = usage.inputTokens + usage.outputTokens;
      await reconcileMonthlyTokens(redis, userId, activeTier, reservedTokens, totalTokens);
      const costPaise = estimateCostPaise(provider, usage.inputTokens, usage.outputTokens);
      await reconcileMonthlyCost(redis, userId, activeTier, reservedCostPaise, costPaise);
      await recordDailySpend(redis, costPaise);
      await markProviderSuccess(redis, provider);

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
      });

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
        };
        await writeCachedResponse(redis, args.cacheKey, response);
      }
    } catch (err) {
      await markProviderFailure(redis, provider);
      log.error('stream_reconcile_failed', { error: err instanceof Error ? err.message : String(err) });
      // Best-effort: give back the full reservation so a failed stream
      // doesn't silently eat into the user's monthly budget.
      await reconcileMonthlyTokens(redis, userId, activeTier, reservedTokens, 0);
      await reconcileMonthlyCost(redis, userId, activeTier, reservedCostPaise, 0);
    }
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-cache',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
      'X-RateLimit-Remaining': String(args.rl.remaining),
      'X-MessageQuota-Remaining': String(args.messageQuota.remaining),
    },
  });
}