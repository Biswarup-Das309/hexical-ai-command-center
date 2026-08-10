/**
 * @file lib/hexical/cache.ts
 * Response caching for safe, repeatable prompts, plus the cost/revenue math
 * used for the per-request analytics event.
 */

import type { Redis } from '@upstash/redis'
import type { Tier, ExecutionPayload, ModelRoute, ExecutionResponse, Provider } from './types'
import {
  API_VERSION,
  SYSTEM_PROMPT_VERSION,
  PROVIDER_ROUTER_VERSION,
  CACHE_TTL_SECS,
  MODEL_PRICING_USD_PER_MILLION,
  MONTHLY_TOKEN_BUDGETS,
  PLAN_MONTHLY_PRICE_PAISE,
  getUsdToInr,
} from './types'
import { isRecord, sha256 } from './util'

export function buildCacheKey(tier: Tier, payload: ExecutionPayload, route: ModelRoute, promptLogic: string): string {
  const canonical = JSON.stringify({
    apiVersion: API_VERSION,
    systemPromptVersion: SYSTEM_PROMPT_VERSION,
    providerRouterVersion: PROVIDER_ROUTER_VERSION,
    tier,
    profile: payload.profile,
    targetArch: payload.targetArch,
    autoRedact: payload.autoRedact,
    aggressiveness: payload.aggressiveness,
    provider: route.provider,
    model: route.model,
    modelSlot: route.mode === 'swarm' ? 'swarm' : 'main',
    mode: route.mode,
    promptHash: sha256(promptLogic),
  })

  return `cache:hexical:${API_VERSION}:${sha256(canonical)}`
}

export async function readCachedResponse(redis: Redis, cacheKey: string): Promise<ExecutionResponse | null> {
  const cached = await redis.get<string>(cacheKey)
  if (!cached) return null

  try {
    const parsed = JSON.parse(cached) as unknown
    if (!isRecord(parsed)) return null
    if (typeof parsed.analysis !== 'string' || !Array.isArray(parsed.steps) || !isRecord(parsed.metrics)) return null
    return parsed as unknown as ExecutionResponse
  } catch {
    return null
  }
}

export async function writeCachedResponse(redis: Redis, cacheKey: string, response: ExecutionResponse): Promise<void> {
  await redis.set(cacheKey, JSON.stringify(response), { ex: CACHE_TTL_SECS })
}

export function estimateCostPaise(provider: Provider, tokensIn: number, tokensOut: number): number {
  const pricing = MODEL_PRICING_USD_PER_MILLION[provider]
  if (!pricing) return 0
  const usd = (tokensIn / 1_000_000) * pricing.input + (tokensOut / 1_000_000) * pricing.output
  return Math.max(0, Math.ceil(usd * getUsdToInr() * 100))
}

export function allocatedRevenuePaise(tier: Tier, tokensUsed: number): number {
  const monthlyBudget = MONTHLY_TOKEN_BUDGETS[tier]
  const monthlyPrice = PLAN_MONTHLY_PRICE_PAISE[tier]
  if (monthlyBudget <= 0 || monthlyPrice <= 0) return 0
  return Math.round((monthlyPrice * tokensUsed) / monthlyBudget)
}
