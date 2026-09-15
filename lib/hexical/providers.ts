/**
 * @file lib/hexical/providers.ts
 *
 * All five providers (Groq, OpenAI, Anthropic, Gemini, DeepSeek) go through
 * the Vercel AI SDK's unified `generateText` / `streamText` / `generateObject`
 * instead of five separate hand-written client integrations. This is the
 * single biggest size/complexity reduction in the rewrite — provider-specific
 * request/response shapes, retry semantics, and error handling all live in
 * the SDK, not here.
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, streamText, generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'
import { isProviderCircuitOpen, markProviderFailure, markProviderSuccess } from './limits'
import {
  abortReason,
  createRequestDeadline,
  isRequestDeadlineExceeded,
  sleepWithSignal,
  throwIfAborted,
} from './request-deadline'
import { fallbackProviders } from './routing'
import type { HexicalRuntimeStore } from './runtime-store'
import { buildSingleSystemPrompt, INJECTION_GUARD } from './security'
import { log } from './telemetry'
import {
  PROVIDER_TIMEOUT_MS,
  PROVIDER_MAX_RETRIES,
  SWARM_CONFIDENCE_STOP_THRESHOLD,
  getModelName,
  providerAvailable,
  modelEnvKey,
  type Provider,
  type ModelRoute,
  type ModelExecutionResult,
  type Profile,
} from './types'
import { extractConfidenceScore, sanitizeOutput, errorMessage } from './util'

export class SwarmParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SwarmParseError'
  }
}

export class ProviderCallError extends Error {
  attempts: number
  classification: ProviderFailureClassification
  status?: number
  code?: string
  constructor(message: string, attempts: number, details: ProviderFailureInfo) {
    super(message)
    this.name = 'ProviderCallError'
    this.attempts = attempts
    this.classification = details.classification
    this.status = details.status
    this.code = details.code
  }
}

export type ProviderFailureClassification = 'permanent' | 'transient' | 'unknown'

export interface ProviderFailureInfo {
  classification: ProviderFailureClassification
  retryable: boolean
  status?: number
  code?: string
  safeMessage: string
}

export class ProviderChainError extends Error {
  classification: ProviderFailureClassification
  failures: ProviderFailureInfo[]

  constructor(failures: ProviderFailureInfo[], trail: string[]) {
    const classification = failures.some((failure) => failure.classification === 'transient')
      ? 'transient'
      : failures.length > 0 && failures.every((failure) => failure.classification === 'permanent')
      ? 'permanent'
      : 'unknown'
    super(`All model providers failed. Trail: ${trail.join(' | ')}`)
    this.name = 'ProviderChainError'
    this.classification = classification
    this.failures = failures
  }
}

const PERMANENT_PROVIDER_CODES = new Set([
  'authentication_error',
  'invalid_api_key',
  'invalid_configuration',
  'invalid_model',
  'invalid_request_error',
  'model_not_found',
  'model_not_supported',
  'not_found',
  'permission_error',
  'unsupported_endpoint',
  'unsupported_model',
])

const TRANSIENT_PROVIDER_CODES = new Set([
  'connection_reset',
  'econnrefused',
  'econnreset',
  'eai_again',
  'etimedout',
  'timeout',
])

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function readProviderStatus(error: unknown): number | undefined {
  const record = asRecord(error)
  const response = asRecord(record?.response)
  const cause = asRecord(record?.cause)
  const candidates = [record?.statusCode, record?.status, response?.status, cause?.statusCode, cause?.status]
  for (const candidate of candidates) {
    const status = typeof candidate === 'number' ? candidate : Number(candidate)
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status
  }
  return undefined
}

function readProviderCode(error: unknown): string | undefined {
  const record = asRecord(error)
  const data = asRecord(record?.data)
  const nestedError = asRecord(data?.error)
  const cause = asRecord(record?.cause)
  const candidates = [record?.code, nestedError?.code, data?.code, cause?.code]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().toLowerCase()
  }
  return undefined
}

export function safeProviderErrorMessage(error: unknown): string {
  let message = errorMessage(error)
  message = message
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|secret|password)[=: ]+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(sk-[a-zA-Z0-9_-]{8,})/g, '[REDACTED]')
  return message.slice(0, 240)
}

export function classifyProviderError(error: unknown): ProviderFailureInfo {
  const record = asRecord(error)
  const inheritedClassification = record?.classification
  const status = readProviderStatus(error)
  const code = readProviderCode(error)
  const safeMessage = safeProviderErrorMessage(error)

  if (inheritedClassification === 'permanent' || inheritedClassification === 'transient') {
    return {
      classification: inheritedClassification,
      retryable: inheritedClassification === 'transient',
      status,
      code,
      safeMessage,
    }
  }
  if (status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return { classification: 'transient', retryable: true, status, code, safeMessage }
  }
  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    (status !== undefined && status >= 405 && status < 500)
  ) {
    return { classification: 'permanent', retryable: false, status, code, safeMessage }
  }
  if (code && PERMANENT_PROVIDER_CODES.has(code)) {
    return { classification: 'permanent', retryable: false, status, code, safeMessage }
  }
  if (code && TRANSIENT_PROVIDER_CODES.has(code)) {
    return { classification: 'transient', retryable: true, status, code, safeMessage }
  }

  // Unknown failures retain the existing retry behavior. They are not
  // treated as permanent configuration failures without provider evidence.
  return { classification: 'unknown', retryable: true, status, code, safeMessage }
}

interface ProviderRetryContext {
  requestId?: string
  modelId?: string
}

export interface ProviderCallArgs {
  provider: Provider
  modelId: string
  systemPrompt: string
  userMessage: string
  maxOutputTokens: number
  temperature: number
  requestSignal?: AbortSignal
  requestId?: string
}

type ProviderCall = (args: ProviderCallArgs) => Promise<ModelExecutionResult>

const PROVIDER_RETRY_DELAYS_MS = [500, 1_000] as const

// Explicit create*() instances, each pinned to the same env var names the
// rest of this file already checks in providerAvailable() — rather than
// relying on each package's own default env var (which for Google, e.g., is
// GOOGLE_GENERATIVE_AI_API_KEY, not this project's GEMINI_API_KEY). Memoized
// per warm lambda/instance so we're not reconstructing an SDK client object
// on every single request.
function memoize<T>(factory: () => T): () => T {
  let cached: T | undefined
  return () => {
    if (cached === undefined) cached = factory()
    return cached
  }
}

const anthropicProvider = memoize(() => createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY }))
const openaiProvider = memoize(() => createOpenAI({ apiKey: process.env.OPENAI_API_KEY }))
const groqProvider = memoize(() => createGroq({ apiKey: process.env.GROQ_API_KEY }))
const googleProvider = memoize(() => createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY }))
const deepseekProvider = memoize(() => createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY }))

export function getLanguageModel(provider: Provider, modelId: string): LanguageModel {
  switch (provider) {
    case 'anthropic':
      return anthropicProvider()(modelId)
    case 'openai':
      return openaiProvider()(modelId)
    case 'groq':
      return groqProvider()(modelId)
    case 'gemini':
      return googleProvider()(modelId)
    case 'deepseek':
      return deepseekProvider()(modelId)
  }
}

export function estimateTokensHeuristic(text: string): number {
  const charsPerToken = 3.25
  const safetyMultiplier = 1.15
  return Math.max(1, Math.ceil((text.length / charsPerToken) * safetyMultiplier))
}

/** Local, network-free token estimate used to size the monthly-budget
 *  reservation. Deliberately not calling a provider's countTokens endpoint
 *  on the hot path: it's an extra round trip on every request just to size
 *  a reservation that already carries a 1.3x safety buffer, and the SDK's
 *  own eventual usage numbers are what actually gets reconciled. */
export function estimateRequestTokens(systemPrompt: string, userMessage: string): number {
  return estimateTokensHeuristic(systemPrompt + userMessage)
}

export async function withProviderRetry<T>(
  provider: Provider,
  operation: (signal: AbortSignal) => Promise<T>,
  requestSignal?: AbortSignal,
  context: ProviderRetryContext = {},
): Promise<{ value: T; retryCount: number }> {
  let lastError: unknown

  for (let attempt = 0; attempt <= PROVIDER_RETRY_DELAYS_MS.length; attempt += 1) {
    throwIfAborted(requestSignal)
    if (context.requestId) {
      log.info('provider_attempt', {
        requestId: context.requestId,
        provider,
        model: context.modelId,
        attempt: attempt + 1,
      })
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS)
    const onRequestAbort = () => controller.abort(abortReason(requestSignal as AbortSignal))
    if (requestSignal?.aborted) onRequestAbort()
    else requestSignal?.addEventListener('abort', onRequestAbort, { once: true })
    try {
      const value = await operation(controller.signal)
      return { value, retryCount: attempt }
    } catch (err) {
      if (requestSignal?.aborted) throw abortReason(requestSignal)
      lastError = err
      const failure = classifyProviderError(err)
      const delayMs = PROVIDER_RETRY_DELAYS_MS[attempt]
      const shouldRetry = failure.retryable && delayMs !== undefined
      if (context.requestId) {
        log.warn('provider_attempt_failed', {
          requestId: context.requestId,
          provider,
          model: context.modelId,
          attempt: attempt + 1,
          status: failure.status,
          code: failure.code,
          classification: failure.classification,
          retry: shouldRetry,
          error: failure.safeMessage,
        })
      }
      if (!shouldRetry) break
      await sleepWithSignal(delayMs, requestSignal)
    } finally {
      clearTimeout(timeout)
      requestSignal?.removeEventListener('abort', onRequestAbort)
    }
  }

  const failure = classifyProviderError(lastError)
  const attempts = failure.retryable ? PROVIDER_RETRY_DELAYS_MS.length + 1 : 1
  throw new ProviderCallError(
    `${provider} failed after ${attempts} attempt(s): ${failure.safeMessage}`,
    attempts,
    failure,
  )
}

async function callProviderOnce(args: ProviderCallArgs): Promise<ModelExecutionResult> {
  const model = getLanguageModel(args.provider, args.modelId)

  const { value: result, retryCount } = await withProviderRetry(
    args.provider,
    async (signal) => {
      return generateText({
        model,
        system: args.systemPrompt,
        prompt: args.userMessage,
        maxOutputTokens: args.maxOutputTokens,
        temperature: args.temperature,
        maxRetries: 0, // retries owned by withProviderRetry, not double-stacked in the SDK
        abortSignal: signal,
      })
    },
    args.requestSignal,
    { requestId: args.requestId, modelId: args.modelId },
  )

  const text = result.text ?? ''

  return {
    provider: args.provider,
    model: args.modelId,
    mode: 'single',
    text,
    tokensIn: result.usage?.inputTokens ?? estimateTokensHeuristic(args.systemPrompt + args.userMessage),
    tokensOut: result.usage?.outputTokens ?? estimateTokensHeuristic(text),
    confidenceScore: extractConfidenceScore(text, 70),
    fallbackTrail: [],
    providerRetryCount: retryCount,
  }
}

export async function executeSingleWithFallback(args: {
  runtime: HexicalRuntimeStore
  route: ModelRoute
  profile: Profile
  systemCtx: string
  userMessage: string
  cheapOnly: boolean
  requestSignal?: AbortSignal
  requestId?: string
  providerAvailable?: (provider: Provider) => boolean
  providerCall?: ProviderCall
}): Promise<ModelExecutionResult> {
  const trail: string[] = []
  const failures: ProviderFailureInfo[] = []
  const providers = fallbackProviders(args.route.provider, args.cheapOnly)
  const isAvailable = args.providerAvailable ?? providerAvailable
  const call = args.providerCall ?? callProviderOnce

  for (const [index, provider] of providers.entries()) {
    throwIfAborted(args.requestSignal)
    if (!isAvailable(provider)) {
      trail.push(`${provider}: skipped, missing API key`)
      continue
    }
    if (await isProviderCircuitOpen(args.runtime, provider)) {
      trail.push(`${provider}: skipped, circuit open`)
      continue
    }

    let modelId = provider === args.route.provider ? args.route.model : ''
    try {
      modelId = provider === args.route.provider ? args.route.model : getModelName(provider)
      const systemPrompt = buildSingleSystemPrompt(args.systemCtx, provider, args.profile)
      const result = await call({
        provider,
        modelId,
        systemPrompt,
        userMessage: args.userMessage,
        maxOutputTokens: args.route.maxOutputTokens,
        temperature: args.route.temperature,
        requestSignal: args.requestSignal,
        requestId: args.requestId,
      })
      await markProviderSuccess(args.runtime, provider)
      return { ...result, text: sanitizeOutput(result.text), fallbackTrail: trail }
    } catch (err) {
      if (args.requestSignal?.aborted || isRequestDeadlineExceeded(err)) throw err
      await markProviderFailure(args.runtime, provider)
      const failure = classifyProviderError(err)
      failures.push(failure)
      const attempts = err instanceof ProviderCallError ? err.attempts : 1
      trail.push(`${provider}: ${failure.classification} after ${attempts} attempt(s)`)
      log.warn('provider_fallback', {
        requestId: args.requestId,
        provider,
        model: modelId,
        fallbackPosition: index + 1,
        status: failure.status,
        code: failure.code,
        classification: failure.classification,
        attempts,
        error: failure.safeMessage,
      })
    }
  }

  throw new ProviderChainError(failures, trail)
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export interface StreamingRun {
  textStream: AsyncIterable<string>
  result: {
    usage: Promise<{ inputTokens: number; outputTokens: number }>
    text: Promise<string>
  }
  dispose(): void
}

/** Streams a single provider's output live while still letting the caller
 *  await final usage/text afterwards for budget reconciliation and usage
 *  logging (see route.ts, which schedules that with `after()` so it doesn't
 *  delay the response). No circuit-breaker fallback mid-stream — once bytes
 *  are flowing to the client we commit to this provider; fallback still
 *  applies to picking who starts the stream. */
export function streamProvider(args: {
  provider: Provider
  modelId: string
  systemPrompt: string
  userMessage: string
  maxOutputTokens: number
  temperature: number
  requestSignal?: AbortSignal
}): StreamingRun {
  const model = getLanguageModel(args.provider, args.modelId)
  const streamDeadline = createRequestDeadline(args.requestSignal, PROVIDER_TIMEOUT_MS * 3)
  const result = streamText({
    model,
    system: args.systemPrompt,
    prompt: args.userMessage,
    maxOutputTokens: args.maxOutputTokens,
    temperature: args.temperature,
    maxRetries: PROVIDER_MAX_RETRIES,
    abortSignal: streamDeadline.signal, // streaming responses run longer than a single call
  })

  return {
    textStream: result.textStream,
    result: {
      usage: Promise.resolve(result.usage).then((u) => ({
        inputTokens: u?.inputTokens ?? 0,
        outputTokens: u?.outputTokens ?? 0,
      })),
      text: Promise.resolve(result.text),
    },
    dispose: streamDeadline.dispose,
  }
}

// ---------------------------------------------------------------------------
// Swarm (Red / Blue / Architect) — schema-validated structured output
// ---------------------------------------------------------------------------

const RedTeamSchema = z.object({
  confidence: z.number().min(0).max(100),
  logic: z.string(),
  payloadSuggested: z.string(),
})

const BlueTeamSchema = z.object({
  mitigation: z.string(),
  blockedBy: z.array(z.string()).max(10),
  riskLevel: z.enum(['LOW', 'MED', 'HIGH', 'CRITICAL']),
})

const ArchitectSchema = z.object({
  route: z.string(),
  architecturalFlaw: z.string(),
})

async function generateAgentObject<T>(args: {
  provider: Provider
  modelId: string
  system: string
  prompt: string
  schema: z.ZodType<T>
  maxOutputTokens: number
  requestSignal?: AbortSignal
  requestId?: string
}): Promise<{ value: T; usage: { inputTokens: number; outputTokens: number }; retryCount: number }> {
  const model = getLanguageModel(args.provider, args.modelId)
  const { value, retryCount } = await withProviderRetry(
    args.provider,
    async (signal) => {
      return generateObject({
        model,
        system: args.system,
        prompt: args.prompt,
        schema: args.schema,
        temperature: 0.1,
        maxOutputTokens: args.maxOutputTokens,
        maxRetries: 0,
        abortSignal: signal,
      })
    },
    args.requestSignal,
    { requestId: args.requestId, modelId: args.modelId },
  )

  return {
    value: value.object,
    usage: {
      inputTokens: value.usage?.inputTokens ?? 0,
      outputTokens: value.usage?.outputTokens ?? 0,
    },
    retryCount,
  }
}

export async function executeSwarm(args: {
  provider: Provider
  modelId: string
  systemCtx: string
  userMessage: string
  maxOutputTokens: number
  requestSignal?: AbortSignal
  requestId?: string
}): Promise<ModelExecutionResult> {
  const redSys =
    INJECTION_GUARD +
    args.systemCtx +
    `ROLE: RED TEAM OFFENSIVE AGENT.\nTask: identify exploitation vectors in the untrusted payload.\n`
  const blueSys =
    INJECTION_GUARD +
    args.systemCtx +
    `ROLE: BLUE TEAM DEFENSIVE AGENT.\nTask: identify defensive gaps and missing controls in the untrusted payload.\n`
  const archSys =
    INJECTION_GUARD +
    args.systemCtx +
    `ROLE: SYSTEM ARCHITECT.\nTask: identify structural design flaws in the untrusted payload.\n`

  let red: Awaited<ReturnType<typeof generateAgentObject<z.infer<typeof RedTeamSchema>>>>
  let blue: Awaited<ReturnType<typeof generateAgentObject<z.infer<typeof BlueTeamSchema>>>>
  let arch: Awaited<ReturnType<typeof generateAgentObject<z.infer<typeof ArchitectSchema>>>>

  try {
    ;[red, blue, arch] = await Promise.all([
      generateAgentObject({
        provider: args.provider,
        modelId: args.modelId,
        system: redSys,
        prompt: args.userMessage,
        schema: RedTeamSchema,
        maxOutputTokens: args.maxOutputTokens,
        requestSignal: args.requestSignal,
        requestId: args.requestId,
      }),
      generateAgentObject({
        provider: args.provider,
        modelId: args.modelId,
        system: blueSys,
        prompt: args.userMessage,
        schema: BlueTeamSchema,
        maxOutputTokens: args.maxOutputTokens,
        requestSignal: args.requestSignal,
        requestId: args.requestId,
      }),
      generateAgentObject({
        provider: args.provider,
        modelId: args.modelId,
        system: archSys,
        prompt: args.userMessage,
        schema: ArchitectSchema,
        maxOutputTokens: args.maxOutputTokens,
        requestSignal: args.requestSignal,
        requestId: args.requestId,
      }),
    ])
  } catch (err) {
    if (args.requestSignal?.aborted || isRequestDeadlineExceeded(err)) throw err
    throw new SwarmParseError(`Swarm agent failed to produce schema-valid output: ${safeProviderErrorMessage(err)}`)
  }

  const safeConfidence = Math.min(100, Math.max(0, red.value.confidence))

  const swarmConsensus = {
    redTeam: {
      confidence: safeConfidence,
      logic: sanitizeOutput(red.value.logic),
      payloadSuggested: sanitizeOutput(red.value.payloadSuggested || 'N/A'),
    },
    blueTeam: {
      withstandMatrix: sanitizeOutput(blue.value.mitigation),
      blockedBy: blue.value.blockedBy.map((item) => sanitizeOutput(item)).slice(0, 10),
      riskLevel: blue.value.riskLevel,
    },
    architect: {
      route: sanitizeOutput(arch.value.route),
      architecturalFlaw: sanitizeOutput(arch.value.architecturalFlaw),
    },
    finalConsensus: safeConfidence > 75,
  }

  return {
    provider: args.provider,
    model: args.modelId,
    mode: 'swarm',
    text: sanitizeOutput(
      `[SWARM CONSENSUS] Offensive confidence: ${safeConfidence}%. ` +
        `Root flaw in [${swarmConsensus.architect.route}]: ${swarmConsensus.architect.architecturalFlaw}. ` +
        `Defensive recommendation: ${swarmConsensus.blueTeam.withstandMatrix}`,
    ),
    tokensIn: red.usage.inputTokens + blue.usage.inputTokens + arch.usage.inputTokens,
    tokensOut: red.usage.outputTokens + blue.usage.outputTokens + arch.usage.outputTokens,
    confidenceScore: safeConfidence,
    swarmConsensus,
    fallbackTrail: [],
    providerRetryCount: red.retryCount + blue.retryCount + arch.retryCount,
  }
}
// ---------------------------------------------------------------------------
// Structured finding extraction (trace-panel evidence, grounded in the
// model's own completed analysis — never invented). Reuses the same
// generateAgentObject/circuit-breaker/retry path as the swarm agents rather
// than a bare generateObject call, so a bad provider gets the same
// retry-then-circuit-break treatment here as everywhere else in this file.
// ---------------------------------------------------------------------------
export async function extractStructuredFinding<T>(args: {
  runtime: HexicalRuntimeStore
  provider: Provider
  modelId: string
  system: string
  prompt: string
  schema: z.ZodType<T>
  maxOutputTokens: number
  requestSignal?: AbortSignal
  requestId?: string
}): Promise<{ value: T; usage: { inputTokens: number; outputTokens: number } } | null> {
  throwIfAborted(args.requestSignal)
  if (await isProviderCircuitOpen(args.runtime, args.provider)) {
    log.warn('structured_finding_skipped_circuit_open', {
      requestId: args.requestId,
      provider: args.provider,
      model: args.modelId,
    })
    return null
  }

  try {
    const { value, usage } = await generateAgentObject({
      provider: args.provider,
      modelId: args.modelId,
      system: args.system,
      prompt: args.prompt,
      schema: args.schema,
      maxOutputTokens: args.maxOutputTokens,
      requestSignal: args.requestSignal,
      requestId: args.requestId,
    })

    await markProviderSuccess(args.runtime, args.provider)
    return { value, usage }
  } catch (err) {
    if (args.requestSignal?.aborted || isRequestDeadlineExceeded(err)) throw err
    await markProviderFailure(args.runtime, args.provider)
    const failure = classifyProviderError(err)
    log.warn('structured_finding_extraction_failed', {
      requestId: args.requestId,
      provider: args.provider,
      model: args.modelId,
      status: failure.status,
      code: failure.code,
      classification: failure.classification,
      error: failure.safeMessage,
    })
    return null // caller must treat this as "no finding" — never fall back to a fabricated one
  }
}

/** Orchestrates the adaptive-Pro-swarm behaviour: run one Claude pass first;
 *  only pay for the full Red/Blue/Architect swarm if that pass's
 *  self-reported confidence doesn't clear the bar. */
export async function executeRoute(args: {
  runtime: HexicalRuntimeStore
  profile: Profile
  route: ModelRoute
  systemCtx: string
  userMessage: string
  cheapOnly: boolean
  execSteps: string[]
  requestSignal?: AbortSignal
  requestId?: string
}): Promise<ModelExecutionResult> {
  throwIfAborted(args.requestSignal)
  if (args.route.mode === 'swarm') {
    return runForcedSwarm(args)
  }

  const firstPass = await executeSingleWithFallback({
    runtime: args.runtime,
    route: args.route,
    profile: args.profile,
    systemCtx: args.systemCtx,
    userMessage: args.userMessage,
    cheapOnly: args.cheapOnly,
    requestSignal: args.requestSignal,
    requestId: args.requestId,
  })

  const canConfidenceGateSwarm =
    args.profile === 'swarm' &&
    args.route.reason === 'adaptive-pro-confidence-gate' &&
    firstPass.provider === 'anthropic'

  if (!canConfidenceGateSwarm) return firstPass

  if (firstPass.confidenceScore > SWARM_CONFIDENCE_STOP_THRESHOLD) {
    args.execSteps.push(
      `Single-agent confidence ${firstPass.confidenceScore}% exceeded swarm threshold; skipped Red / Blue / Architect expansion.`,
    )
    return firstPass
  }

  throwIfAborted(args.requestSignal)
  if (await isProviderCircuitOpen(args.runtime, 'anthropic')) {
    args.execSteps.push('Anthropic circuit is open; returning single-agent result without swarm expansion.')
    return firstPass
  }

  if (!process.env[modelEnvKey('anthropic', 'swarm')]) {
    args.execSteps.push('Swarm model is not configured; returning single-agent result.')
    return firstPass
  }

  args.execSteps.push(
    `Single-agent confidence ${firstPass.confidenceScore}% did not exceed ${SWARM_CONFIDENCE_STOP_THRESHOLD}%; running Red / Blue / Architect swarm.`,
  )

  try {
    const swarmResult = await executeSwarm({
      provider: 'anthropic',
      modelId: getModelName('anthropic', 'swarm'),
      systemCtx: args.systemCtx,
      userMessage: args.userMessage,
      maxOutputTokens: Math.max(args.route.maxOutputTokens, 1_500),
      requestSignal: args.requestSignal,
      requestId: args.requestId,
    })
    await markProviderSuccess(args.runtime, 'anthropic')

    return {
      ...swarmResult,
      text: sanitizeOutput(`[SINGLE AGENT PASS]\n${firstPass.text}\n\n${swarmResult.text}`),
      tokensIn: firstPass.tokensIn + swarmResult.tokensIn,
      tokensOut: firstPass.tokensOut + swarmResult.tokensOut,
      fallbackTrail: [...firstPass.fallbackTrail, ...swarmResult.fallbackTrail],
      providerRetryCount: firstPass.providerRetryCount + swarmResult.providerRetryCount,
    }
  } catch (err) {
    await markProviderFailure(args.runtime, 'anthropic')
    if (err instanceof SwarmParseError) throw err
    log.error('swarm_provider_failure', {
      requestId: args.requestId,
      provider: 'anthropic',
      error: safeProviderErrorMessage(err),
    })
    args.execSteps.push('Swarm provider unavailable; returning single-agent analysis.')
    return {
      ...firstPass,
      fallbackTrail: [...firstPass.fallbackTrail, 'anthropic swarm: unavailable after single-agent pass'],
    }
  }
}

async function runForcedSwarm(args: {
  runtime: HexicalRuntimeStore
  profile: Profile
  route: ModelRoute
  systemCtx: string
  userMessage: string
  cheapOnly: boolean
  execSteps: string[]
  requestSignal?: AbortSignal
  requestId?: string
}): Promise<ModelExecutionResult> {
  try {
    throwIfAborted(args.requestSignal)
    if (await isProviderCircuitOpen(args.runtime, 'anthropic')) {
      throw new Error('Anthropic circuit open before swarm execution.')
    }
    const swarmResult = await executeSwarm({
      provider: args.route.provider,
      modelId: args.route.model,
      systemCtx: args.systemCtx,
      userMessage: args.userMessage,
      maxOutputTokens: args.route.maxOutputTokens,
      requestSignal: args.requestSignal,
      requestId: args.requestId,
    })
    await markProviderSuccess(args.runtime, 'anthropic')
    return swarmResult
  } catch (err) {
    if (args.requestSignal?.aborted || isRequestDeadlineExceeded(err)) throw err
    await markProviderFailure(args.runtime, 'anthropic')
    if (err instanceof SwarmParseError) throw err
    log.error('swarm_provider_failure', {
      requestId: args.requestId,
      provider: 'anthropic',
      error: safeProviderErrorMessage(err),
    })
    args.execSteps.push('Swarm provider unavailable; downgrading to single-agent analysis.')
    return executeSingleWithFallback({
      runtime: args.runtime,
      route: { ...args.route, mode: 'single' },
      profile: args.profile,
      systemCtx: args.systemCtx,
      userMessage: args.userMessage,
      cheapOnly: args.cheapOnly,
      requestSignal: args.requestSignal,
      requestId: args.requestId,
    })
  }
}
