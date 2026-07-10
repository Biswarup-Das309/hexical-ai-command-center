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

import { generateText, streamText, generateObject, type LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGroq } from '@ai-sdk/groq';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { z } from 'zod';
import type { Redis } from '@upstash/redis';
import type { Provider, ModelRoute, ModelExecutionResult, Profile } from './types';
import {
  PROVIDER_TIMEOUT_MS,
  PROVIDER_MAX_RETRIES,
  SWARM_CONFIDENCE_STOP_THRESHOLD,
  getModelName,
  providerAvailable,
  modelEnvKey,
} from './types';
import { fallbackProviders } from './routing';
import { buildSingleSystemPrompt, INJECTION_GUARD } from './security';
import { extractConfidenceScore, sanitizeOutput, errorMessage } from './util';
import { isProviderCircuitOpen, markProviderFailure, markProviderSuccess } from './limits';
import { log } from './telemetry';

export class SwarmParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwarmParseError';
  }
}

export class ProviderCallError extends Error {
  attempts: number;
  constructor(message: string, attempts: number) {
    super(message);
    this.name = 'ProviderCallError';
    this.attempts = attempts;
  }
}

const PROVIDER_RETRY_DELAYS_MS = [500, 1_000] as const;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Explicit create*() instances, each pinned to the same env var names the
// rest of this file already checks in providerAvailable() — rather than
// relying on each package's own default env var (which for Google, e.g., is
// GOOGLE_GENERATIVE_AI_API_KEY, not this project's GEMINI_API_KEY). Memoized
// per warm lambda/instance so we're not reconstructing an SDK client object
// on every single request.
function memoize<T>(factory: () => T): () => T {
  let cached: T | undefined;
  return () => {
    if (cached === undefined) cached = factory();
    return cached;
  };
}

const anthropicProvider = memoize(() => createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
const openaiProvider = memoize(() => createOpenAI({ apiKey: process.env.OPENAI_API_KEY }));
const groqProvider = memoize(() => createGroq({ apiKey: process.env.GROQ_API_KEY }));
const googleProvider = memoize(() => createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY }));
const deepseekProvider = memoize(() => createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY }));

function resolveModel(provider: Provider, modelId: string): LanguageModel {
  switch (provider) {
    case 'anthropic':
      return anthropicProvider()(modelId);
    case 'openai':
      return openaiProvider()(modelId);
    case 'groq':
      return groqProvider()(modelId);
    case 'gemini':
      return googleProvider()(modelId);
    case 'deepseek':
      return deepseekProvider()(modelId);
  }
}

export function estimateTokensHeuristic(text: string): number {
  const charsPerToken = 3.25;
  const safetyMultiplier = 1.15;
  return Math.max(1, Math.ceil((text.length / charsPerToken) * safetyMultiplier));
}

/** Local, network-free token estimate used to size the monthly-budget
 *  reservation. Deliberately not calling a provider's countTokens endpoint
 *  on the hot path: it's an extra round trip on every request just to size
 *  a reservation that already carries a 1.3x safety buffer, and the SDK's
 *  own eventual usage numbers are what actually gets reconciled. */
export function estimateRequestTokens(systemPrompt: string, userMessage: string): number {
  return estimateTokensHeuristic(systemPrompt + userMessage);
}

async function withProviderRetry<T>(
  provider: Provider,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<{ value: T; retryCount: number }> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= PROVIDER_RETRY_DELAYS_MS.length; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    try {
      const value = await operation(controller.signal);
      return { value, retryCount: attempt };
    } catch (err) {
      lastError = err;
      const delayMs = PROVIDER_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) break;
      await sleep(delayMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new ProviderCallError(`${provider} failed after retries: ${errorMessage(lastError)}`, PROVIDER_RETRY_DELAYS_MS.length + 1);
}

async function callProviderOnce(args: {
  provider: Provider;
  modelId: string;
  systemPrompt: string;
  userMessage: string;
  maxOutputTokens: number;
  temperature: number;
}): Promise<ModelExecutionResult> {
  const model = resolveModel(args.provider, args.modelId);

  const { value: result, retryCount } = await withProviderRetry(args.provider, async signal => {
    return generateText({
      model,
      system: args.systemPrompt,
      prompt: args.userMessage,
      maxOutputTokens: args.maxOutputTokens,
      temperature: args.temperature,
      maxRetries: 0, // retries owned by withProviderRetry, not double-stacked in the SDK
      abortSignal: signal,
    });
  });

  const text = result.text ?? '';

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
  };
}

export async function executeSingleWithFallback(args: {
  redis: Redis;
  route: ModelRoute;
  profile: Profile;
  systemCtx: string;
  userMessage: string;
  cheapOnly: boolean;
}): Promise<ModelExecutionResult> {
  const trail: string[] = [];

  for (const provider of fallbackProviders(args.route.provider, args.cheapOnly)) {
    if (!providerAvailable(provider)) {
      trail.push(`${provider}: skipped, missing API key`);
      continue;
    }
    if (await isProviderCircuitOpen(args.redis, provider)) {
      trail.push(`${provider}: skipped, circuit open`);
      continue;
    }

    try {
      const modelId = provider === args.route.provider ? args.route.model : getModelName(provider);
      const systemPrompt = buildSingleSystemPrompt(args.systemCtx, provider, args.profile);
      const result = await callProviderOnce({
        provider,
        modelId,
        systemPrompt,
        userMessage: args.userMessage,
        maxOutputTokens: args.route.maxOutputTokens,
        temperature: args.route.temperature,
      });
      await markProviderSuccess(args.redis, provider);
      return { ...result, text: sanitizeOutput(result.text), fallbackTrail: trail };
    } catch (err) {
      await markProviderFailure(args.redis, provider);
      log.warn('provider_fallback', { provider, error: errorMessage(err) });
      const attempts = err instanceof ProviderCallError ? err.attempts : 1;
      trail.push(`${provider}: failed after ${attempts} attempt(s)`);
    }
  }

  throw new Error(`All model providers failed. Trail: ${trail.join(' | ')}`);
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export interface StreamingRun {
  textStream: AsyncIterable<string>;
  result: {
    usage: Promise<{ inputTokens: number; outputTokens: number }>;
    text: Promise<string>;
  };
}

/** Streams a single provider's output live while still letting the caller
 *  await final usage/text afterwards for budget reconciliation and usage
 *  logging (see route.ts, which schedules that with `after()` so it doesn't
 *  delay the response). No circuit-breaker fallback mid-stream — once bytes
 *  are flowing to the client we commit to this provider; fallback still
 *  applies to picking who starts the stream. */
export function streamProvider(args: {
  provider: Provider;
  modelId: string;
  systemPrompt: string;
  userMessage: string;
  maxOutputTokens: number;
  temperature: number;
}): StreamingRun {
  const model = resolveModel(args.provider, args.modelId);
  const result = streamText({
    model,
    system: args.systemPrompt,
    prompt: args.userMessage,
    maxOutputTokens: args.maxOutputTokens,
    temperature: args.temperature,
    maxRetries: PROVIDER_MAX_RETRIES,
    abortSignal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS * 3), // streaming responses run longer than a single call
  });

  return {
    textStream: result.textStream,
    result: {
      usage: Promise.resolve(result.usage).then(u => ({
        inputTokens: u?.inputTokens ?? 0,
        outputTokens: u?.outputTokens ?? 0,
      })),
      text: Promise.resolve(result.text),
    },
  };
}

// ---------------------------------------------------------------------------
// Swarm (Red / Blue / Architect) — schema-validated structured output
// ---------------------------------------------------------------------------

const RedTeamSchema = z.object({
  confidence: z.number().min(0).max(100),
  logic: z.string(),
  payloadSuggested: z.string(),
});

const BlueTeamSchema = z.object({
  mitigation: z.string(),
  blockedBy: z.array(z.string()).max(10),
  riskLevel: z.enum(['LOW', 'MED', 'HIGH', 'CRITICAL']),
});

const ArchitectSchema = z.object({
  route: z.string(),
  architecturalFlaw: z.string(),
});

async function generateAgentObject<T>(args: {
  provider: Provider;
  modelId: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxOutputTokens: number;
}): Promise<{ value: T; usage: { inputTokens: number; outputTokens: number }; retryCount: number }> {
  const model = resolveModel(args.provider, args.modelId);
  const { value, retryCount } = await withProviderRetry(args.provider, async signal => {
    return generateObject({
      model,
      system: args.system,
      prompt: args.prompt,
      schema: args.schema,
      temperature: 0.1,
      maxOutputTokens: args.maxOutputTokens,
      maxRetries: 0,
      abortSignal: signal,
    });
  });

  return {
    value: value.object,
    usage: {
      inputTokens: value.usage?.inputTokens ?? 0,
      outputTokens: value.usage?.outputTokens ?? 0,
    },
    retryCount,
  };
}

export async function executeSwarm(args: {
  provider: Provider;
  modelId: string;
  systemCtx: string;
  userMessage: string;
  maxOutputTokens: number;
}): Promise<ModelExecutionResult> {
  const redSys =
    INJECTION_GUARD + args.systemCtx + `ROLE: RED TEAM OFFENSIVE AGENT.\nTask: identify exploitation vectors in the untrusted payload.\n`;
  const blueSys =
    INJECTION_GUARD +
    args.systemCtx +
    `ROLE: BLUE TEAM DEFENSIVE AGENT.\nTask: identify defensive gaps and missing controls in the untrusted payload.\n`;
  const archSys =
    INJECTION_GUARD + args.systemCtx + `ROLE: SYSTEM ARCHITECT.\nTask: identify structural design flaws in the untrusted payload.\n`;

  let red: Awaited<ReturnType<typeof generateAgentObject<z.infer<typeof RedTeamSchema>>>>;
  let blue: Awaited<ReturnType<typeof generateAgentObject<z.infer<typeof BlueTeamSchema>>>>;
  let arch: Awaited<ReturnType<typeof generateAgentObject<z.infer<typeof ArchitectSchema>>>>;

  try {
    [red, blue, arch] = await Promise.all([
      generateAgentObject({ provider: args.provider, modelId: args.modelId, system: redSys, prompt: args.userMessage, schema: RedTeamSchema, maxOutputTokens: args.maxOutputTokens }),
      generateAgentObject({ provider: args.provider, modelId: args.modelId, system: blueSys, prompt: args.userMessage, schema: BlueTeamSchema, maxOutputTokens: args.maxOutputTokens }),
      generateAgentObject({ provider: args.provider, modelId: args.modelId, system: archSys, prompt: args.userMessage, schema: ArchitectSchema, maxOutputTokens: args.maxOutputTokens }),
    ]);
  } catch (err) {
    throw new SwarmParseError(`Swarm agent failed to produce schema-valid output: ${errorMessage(err)}`);
  }

  const safeConfidence = Math.min(100, Math.max(0, red.value.confidence));

  const swarmConsensus = {
    redTeam: {
      confidence: safeConfidence,
      logic: sanitizeOutput(red.value.logic),
      payloadSuggested: sanitizeOutput(red.value.payloadSuggested || 'N/A'),
    },
    blueTeam: {
      withstandMatrix: sanitizeOutput(blue.value.mitigation),
      blockedBy: blue.value.blockedBy.map(item => sanitizeOutput(item)).slice(0, 10),
      riskLevel: blue.value.riskLevel,
    },
    architect: {
      route: sanitizeOutput(arch.value.route),
      architecturalFlaw: sanitizeOutput(arch.value.architecturalFlaw),
    },
    finalConsensus: safeConfidence > 75,
  };

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
  };
}

/** Orchestrates the adaptive-Pro-swarm behaviour: run one Claude pass first;
 *  only pay for the full Red/Blue/Architect swarm if that pass's
 *  self-reported confidence doesn't clear the bar. */
export async function executeRoute(args: {
  redis: Redis;
  profile: Profile;
  route: ModelRoute;
  systemCtx: string;
  userMessage: string;
  cheapOnly: boolean;
  execSteps: string[];
}): Promise<ModelExecutionResult> {
  if (args.route.mode === 'swarm') {
    return runForcedSwarm(args);
  }

  const firstPass = await executeSingleWithFallback({
    redis: args.redis,
    route: args.route,
    profile: args.profile,
    systemCtx: args.systemCtx,
    userMessage: args.userMessage,
    cheapOnly: args.cheapOnly,
  });

  const canConfidenceGateSwarm =
    args.profile === 'swarm' && args.route.reason === 'adaptive-pro-confidence-gate' && firstPass.provider === 'anthropic';

  if (!canConfidenceGateSwarm) return firstPass;

  if (firstPass.confidenceScore > SWARM_CONFIDENCE_STOP_THRESHOLD) {
    args.execSteps.push(
      `Single-agent confidence ${firstPass.confidenceScore}% exceeded swarm threshold; skipped Red / Blue / Architect expansion.`,
    );
    return firstPass;
  }

  if (await isProviderCircuitOpen(args.redis, 'anthropic')) {
    args.execSteps.push('Anthropic circuit is open; returning single-agent result without swarm expansion.');
    return firstPass;
  }

  if (!process.env[modelEnvKey('anthropic', 'swarm')]) {
    args.execSteps.push('Swarm model is not configured; returning single-agent result.');
    return firstPass;
  }

  args.execSteps.push(
    `Single-agent confidence ${firstPass.confidenceScore}% did not exceed ${SWARM_CONFIDENCE_STOP_THRESHOLD}%; running Red / Blue / Architect swarm.`,
  );

  try {
    const swarmResult = await executeSwarm({
      provider: 'anthropic',
      modelId: getModelName('anthropic', 'swarm'),
      systemCtx: args.systemCtx,
      userMessage: args.userMessage,
      maxOutputTokens: Math.max(args.route.maxOutputTokens, 1_500),
    });
    await markProviderSuccess(args.redis, 'anthropic');

    return {
      ...swarmResult,
      text: sanitizeOutput(`[SINGLE AGENT PASS]\n${firstPass.text}\n\n${swarmResult.text}`),
      tokensIn: firstPass.tokensIn + swarmResult.tokensIn,
      tokensOut: firstPass.tokensOut + swarmResult.tokensOut,
      fallbackTrail: [...firstPass.fallbackTrail, ...swarmResult.fallbackTrail],
      providerRetryCount: firstPass.providerRetryCount + swarmResult.providerRetryCount,
    };
  } catch (err) {
    await markProviderFailure(args.redis, 'anthropic');
    if (err instanceof SwarmParseError) throw err;
    log.error('swarm_provider_failure', { error: errorMessage(err) });
    args.execSteps.push('Swarm provider unavailable; returning single-agent analysis.');
    return { ...firstPass, fallbackTrail: [...firstPass.fallbackTrail, 'anthropic swarm: unavailable after single-agent pass'] };
  }
}

async function runForcedSwarm(args: {
  redis: Redis;
  profile: Profile;
  route: ModelRoute;
  systemCtx: string;
  userMessage: string;
  cheapOnly: boolean;
  execSteps: string[];
}): Promise<ModelExecutionResult> {
  try {
    if (await isProviderCircuitOpen(args.redis, 'anthropic')) {
      throw new Error('Anthropic circuit open before swarm execution.');
    }
    const swarmResult = await executeSwarm({
      provider: args.route.provider,
      modelId: args.route.model,
      systemCtx: args.systemCtx,
      userMessage: args.userMessage,
      maxOutputTokens: args.route.maxOutputTokens,
    });
    await markProviderSuccess(args.redis, 'anthropic');
    return swarmResult;
  } catch (err) {
    await markProviderFailure(args.redis, 'anthropic');
    if (err instanceof SwarmParseError) throw err;
    log.error('swarm_provider_failure', { error: errorMessage(err) });
    args.execSteps.push('Swarm provider unavailable; downgrading to single-agent analysis.');
    return executeSingleWithFallback({
      redis: args.redis,
      route: { ...args.route, mode: 'single' },
      profile: args.profile,
      systemCtx: args.systemCtx,
      userMessage: args.userMessage,
      cheapOnly: args.cheapOnly,
    });
  }
}