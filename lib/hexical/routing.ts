/**
 * @file lib/hexical/routing.ts
 * Deterministic routing: classify request complexity, pick a provider/model/
 * mode/max-output-tokens, and define fallback order if the primary provider
 * fails or its circuit is open.
 */

import type { ExecutionPayload, Complexity, ModelRoute, Tier, DailySpendState, Provider } from './types'
import { FEATURE_FLAGS, getModelName, CACHE_MAX_PROMPT_CHARS } from './types'

export function classifyComplexity(payload: ExecutionPayload, promptLogic: string): Complexity {
  const text = promptLogic.toLowerCase()
  let score = 0

  if (promptLogic.length > 6_000) score += 1
  if (promptLogic.length > 18_000) score += 2
  if (payload.profile === 'audit' || payload.profile === 'exploit' || payload.profile === 'patch') score += 1
  if (payload.profile === 'swarm') score += 2
  if (payload.aggressiveness === 'high') score += 1
  if (payload.conversation && payload.conversation.length > 8) score += 1
  if (/```|function\s+\w+|class\s+\w+|select\s+.+from|curl\s+|http[s]?:\/\//i.test(promptLogic)) score += 1
  if (
    /(exploit|rce|ssrf|deseriali[sz]ation|privilege escalation|threat model|architecture|chain|bypass|payload)/i.test(
      text,
    )
  )
    score += 2

  if (score >= 5) return 'deep'
  if (score >= 2) return 'standard'
  return 'simple'
}

export function maxTokensFor(tier: Tier, complexity: Complexity): number {
  const base: Record<Complexity, number> = { simple: 400, standard: 900, deep: 1_800 }
  const tierCap: Record<Tier, number> = { free: 600, go: 900, plus: 1_800, pro: 2_200 }
  return Math.min(base[complexity], tierCap[tier])
}

export function chooseModelRoute(args: {
  tier: Tier
  payload: ExecutionPayload
  promptLogic: string
  dailySpend: DailySpendState
}): ModelRoute {
  const complexity = classifyComplexity(args.payload, args.promptLogic)
  const maxOutputTokens = maxTokensFor(args.tier, complexity)
  const cheapOnly = args.dailySpend.forceCheapModels || FEATURE_FLAGS.cheapMode

  if (cheapOnly) {
    return {
      provider: 'groq',
      model: getModelName('groq'),
      mode: 'single',
      maxOutputTokens: Math.min(maxOutputTokens, 900),
      temperature: 0.3,
      complexity,
      confidenceScore: 64,
      cacheable: true,
      reason: 'daily-spend-guard',
    }
  }

  if (args.tier === 'pro' && args.payload.profile === 'swarm' && FEATURE_FLAGS.swarmEnabled) {
    return {
      provider: 'anthropic',
      model: getModelName('anthropic'),
      mode: 'single',
      maxOutputTokens,
      temperature: 0.1,
      complexity,
      confidenceScore: 90,
      cacheable: false,
      reason: 'adaptive-pro-confidence-gate',
    }
  }

  if (args.tier === 'pro' && complexity === 'deep') {
    return {
      provider: 'anthropic',
      model: getModelName('anthropic'),
      mode: 'single',
      maxOutputTokens,
      temperature: 0.15,
      complexity,
      confidenceScore: 90,
      cacheable: false,
      reason: 'pro-deep-analysis',
    }
  }

  if (args.tier === 'plus' && complexity !== 'simple') {
    return {
      provider: 'openai',
      model: getModelName('openai'),
      mode: 'single',
      maxOutputTokens,
      temperature: 0.2,
      complexity,
      confidenceScore: 88,
      cacheable: true,
      reason: 'plus-premium-analysis',
    }
  }

  return {
    provider: 'groq',
    model: getModelName('groq'),
    mode: 'single',
    maxOutputTokens,
    temperature: 0.35,
    complexity,
    confidenceScore: 68,
    cacheable: true,
    reason: 'cheap-standard-route',
  }
}

export function hasSensitiveCacheMarkers(payload: ExecutionPayload, promptLogic: string): boolean {
  if (payload.profile === 'swarm') return true
  if (payload.autoRedact) return true
  if (payload.targetScope || payload.extractedTargets?.length || payload.bountyPlatform) return true
  if (promptLogic.length > CACHE_MAX_PROMPT_CHARS) return true
  return /(secret|password|token|api[_-]?key|private key|authorization:|bearer\s+)/i.test(promptLogic)
}

export function fallbackProviders(primary: Provider, cheapOnly: boolean): Provider[] {
  if (!FEATURE_FLAGS.autoFallback) return [primary]
  if (cheapOnly) return ['groq', 'deepseek', 'gemini']

  const all: Record<Provider, Provider[]> = {
    anthropic: ['anthropic', 'openai', 'groq', 'deepseek', 'gemini'],
    openai: ['openai', 'anthropic', 'groq', 'deepseek', 'gemini'],
    groq: ['groq', 'deepseek', 'gemini', 'openai', 'anthropic'],
    deepseek: ['deepseek', 'groq', 'gemini', 'openai', 'anthropic'],
    gemini: ['gemini', 'groq', 'deepseek', 'openai', 'anthropic'],
  }

  return all[primary]
}
