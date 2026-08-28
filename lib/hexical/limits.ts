/**
 * @file lib/hexical/limits.ts
 *
 * Three different problems, three different tools:
 *  - "How many requests / messages in a window" -> an atomic Postgres
 *    function backed by the Supabase runtime store. The function owns the
 *    lock, expiry cleanup, and admission decision in one transaction.
 *  - "Reserve N tokens against a monthly budget, then true up to the real
 *    number afterwards" -> not a rate limiter's job (it has no concept of
 *    giving tokens back). Implemented here as two small atomic Postgres
 *    functions.
 *  - "Reserve real provider $ cost against a monthly ceiling, then true up
 *    afterwards" -> same reserve/reconcile Postgres pattern as tokens, but keyed
 *    on paise instead of token count. Exists because a flat token count
 *    can't tell a cheap input token apart from an output token that costs
 *    5-17x more depending on provider (see MODEL_PRICING_USD_PER_MILLION in
 *    types.ts) — so MONTHLY_TOKEN_BUDGETS alone can't be sized safely
 *    against a price in rupees. MONTHLY_TOKEN_BUDGETS stays in place as a
 *    loose backstop; MONTHLY_COST_BUDGET_PAISE is the real margin defense.
 */

import type { HexicalRuntimeStore } from './runtime-store'
import {
  type Tier,
  type Provider,
  RATE_LIMITS,
  MESSAGE_QUOTA_LIMITS,
  MESSAGE_QUOTA_WINDOW_SECS,
  MONTHLY_TOKEN_BUDGETS,
  MONTHLY_COST_BUDGET_PAISE,
  DAILY_SWARM_LIMIT,
  CIRCUIT_BREAKER_TTL_SECS,
  CIRCUIT_FAILURE_THRESHOLD,
  FEATURE_FLAGS,
  getDailyBudgetPaise,
  type RateLimitResult,
  type MessageQuotaResult,
  type TokenReservation,
  type CostReservation,
  type DailySpendState,
} from './types'
import { asNumber, dayKeyPart, monthKeyPart, secondsUntilNextMonth, secondsUntilTomorrow } from './util'

// ---------------------------------------------------------------------------
// Request-rate limiting (burst + rolling message quota) via Supabase/Postgres
// ---------------------------------------------------------------------------
export async function checkRateLimit(
  runtime: HexicalRuntimeStore,
  userId: string,
  tier: Tier,
  ip: string,
): Promise<RateLimitResult> {
  const cfg = RATE_LIMITS[tier]
  const [userResult, ipResult] = await Promise.all([
    runtime.rateLimit(`hexical:rl:user:${tier}:${userId}`, cfg.maxReq, cfg.windowSecs),
    runtime.rateLimit(`hexical:rl:ip:${tier}:${ip}`, cfg.maxReq * 3, cfg.windowSecs),
  ])

  return {
    allowed: userResult.allowed && ipResult.allowed,
    remaining: Math.min(userResult.remaining, ipResult.remaining),
    resetMs: Math.max(userResult.resetMs, ipResult.resetMs),
    limit: cfg.maxReq,
  }
}

export async function checkMessageQuota(
  runtime: HexicalRuntimeStore,
  userId: string,
  tier: Tier,
): Promise<MessageQuotaResult> {
  const limit = MESSAGE_QUOTA_LIMITS[tier]
  const result = await runtime.rateLimit(`hexical:msgquota:${tier}:${userId}`, limit, MESSAGE_QUOTA_WINDOW_SECS)
  const resetSeconds = Math.max(1, Math.ceil((result.resetMs - Date.now()) / 1_000))

  return {
    allowed: result.allowed,
    used: limit - result.remaining,
    remaining: Math.max(0, result.remaining),
    limit,
    resetSeconds,
  }
}

export async function checkSwarmDailyLimit(
  runtime: HexicalRuntimeStore,
  userId: string,
): Promise<{ allowed: boolean; remaining: number }> {
  const result = await runtime.rateLimit(
    `hexical:swarm:${dayKeyPart()}:${userId}`,
    DAILY_SWARM_LIMIT,
    secondsUntilTomorrow(),
  )
  return { allowed: result.allowed, remaining: Math.max(0, result.remaining) }
}

export async function consumeNonce(
  runtime: HexicalRuntimeStore,
  userId: string,
  nonce: string,
  ttlSecs: number,
): Promise<boolean> {
  const key = `nonce:${userId}:${nonce}`
  const result = await runtime.set(key, '1', { nx: true, ex: ttlSecs })
  return result === 'OK'
}

// ---------------------------------------------------------------------------
// Atomic ledgers (Postgres functions) — monthly token budget + monthly cost budget + daily spend guard
// ---------------------------------------------------------------------------

/** Reserve `amount` against `key`, capped at `cap`. Sets a TTL only the first
 *  time the key is created. Returns [ok(0|1), newTotal, remaining]. Runs as a
 *  single Lua script so concurrent requests can never together push the
 *  ledger past `cap`, unlike a plain "INCR then undo if over" pattern.
 *  Shared by both the token ledger and the cost ledger below — the only
 *  difference between them is which unit (tokens vs paise) gets passed in. */
async function reserveAtomic(
  runtime: HexicalRuntimeStore,
  key: string,
  amount: number,
  cap: number,
  ttlSecs: number,
): Promise<[number, number, number]> {
  return runtime.reserveBudget(key, Math.max(1, amount), cap, ttlSecs)
}

async function reconcileAtomic(runtime: HexicalRuntimeStore, key: string, delta: number): Promise<number> {
  return runtime.reconcileBudget(key, delta)
}

// --- token ledger ------------------------------------------------------

function monthlyBudgetKey(userId: string, tier: Tier): string {
  return `budget:tokens:${userId}:${tier}:${monthKeyPart()}`
}

export async function readMonthlyTokenUsage(runtime: HexicalRuntimeStore, userId: string, tier: Tier): Promise<number> {
  return asNumber(await runtime.get<number | string>(monthlyBudgetKey(userId, tier)))
}

export async function reserveMonthlyTokens(
  runtime: HexicalRuntimeStore,
  userId: string,
  tier: Tier,
  estimatedTokens: number,
): Promise<TokenReservation> {
  const limitTokens = MONTHLY_TOKEN_BUDGETS[tier]
  const safetyBuffer = 1.3
  const reservedTokens = Math.max(1, Math.ceil(estimatedTokens * safetyBuffer))
  const key = monthlyBudgetKey(userId, tier)

  const [ok, updated, remaining] = await reserveAtomic(
    runtime,
    key,
    reservedTokens,
    limitTokens,
    secondsUntilNextMonth(),
  )

  if (ok === 0) {
    return {
      allowed: false,
      reservedTokens: 0,
      usedTokens: updated,
      remainingTokens: Math.max(0, remaining),
      limitTokens,
    }
  }

  return {
    allowed: true,
    reservedTokens,
    usedTokens: updated,
    remainingTokens: Math.max(0, remaining),
    limitTokens,
  }
}

export async function reconcileMonthlyTokens(
  runtime: HexicalRuntimeStore,
  userId: string,
  tier: Tier,
  reservedTokens: number,
  actualTokens: number,
): Promise<number> {
  const key = monthlyBudgetKey(userId, tier)
  const delta = actualTokens - reservedTokens
  const usedTokens = await reconcileAtomic(runtime, key, delta)
  return Math.max(0, MONTHLY_TOKEN_BUDGETS[tier] - usedTokens)
}

// --- cost ledger ---------------------------------------------------------
// Same reserve-then-reconcile shape as the token ledger above, but keyed on
// paise against MONTHLY_COST_BUDGET_PAISE instead of tokens against
// MONTHLY_TOKEN_BUDGETS. Caller computes the paise amount (via
// estimateCostPaise in lib/hexical/cache.ts, using the request's provider +
// tokensIn/tokensOut) and passes it in — this module doesn't know about
// provider pricing, it just runs the same atomic ledger on a different unit.

function monthlyCostKey(userId: string, tier: Tier): string {
  return `budget:cost:${userId}:${tier}:${monthKeyPart()}`
}

export async function readMonthlyCostUsage(runtime: HexicalRuntimeStore, userId: string, tier: Tier): Promise<number> {
  return asNumber(await runtime.get<number | string>(monthlyCostKey(userId, tier)))
}

export async function reserveMonthlyCost(
  runtime: HexicalRuntimeStore,
  userId: string,
  tier: Tier,
  estimatedPaise: number,
): Promise<CostReservation> {
  const limitPaise = MONTHLY_COST_BUDGET_PAISE[tier]
  const safetyBuffer = 1.3
  const reservedPaise = Math.max(1, Math.ceil(estimatedPaise * safetyBuffer))
  const key = monthlyCostKey(userId, tier)

  const [ok, updated, remaining] = await reserveAtomic(runtime, key, reservedPaise, limitPaise, secondsUntilNextMonth())

  if (ok === 0) {
    return {
      allowed: false,
      reservedPaise: 0,
      usedPaise: updated,
      remainingPaise: Math.max(0, remaining),
      limitPaise,
    }
  }

  return {
    allowed: true,
    reservedPaise,
    usedPaise: updated,
    remainingPaise: Math.max(0, remaining),
    limitPaise,
  }
}

export async function reconcileMonthlyCost(
  runtime: HexicalRuntimeStore,
  userId: string,
  tier: Tier,
  reservedPaise: number,
  actualPaise: number,
): Promise<number> {
  const key = monthlyCostKey(userId, tier)
  const delta = actualPaise - reservedPaise
  const usedPaise = await reconcileAtomic(runtime, key, delta)
  return Math.max(0, MONTHLY_COST_BUDGET_PAISE[tier] - usedPaise)
}

// --- daily spend guard (company-wide soft guard, not per-user) ------------
// This policy deliberately constrains routing to cheaper providers instead of
// rejecting requests. The per-user monthly token and cost ledgers are the
// hard, fail-closed ceilings. Keep this distinction explicit at call sites.

export async function readDailySpend(runtime: HexicalRuntimeStore): Promise<DailySpendState> {
  const budgetPaise = getDailyBudgetPaise()
  if (!FEATURE_FLAGS.dailySpendGuard) {
    return { budgetPaise, usedPaise: 0, forceCheapModels: false }
  }
  const usedPaise = asNumber(await runtime.get<number | string>(`budget:spend:${dayKeyPart()}`))
  return { budgetPaise, usedPaise, forceCheapModels: usedPaise >= budgetPaise }
}

export async function recordDailySpend(runtime: HexicalRuntimeStore, costPaise: number): Promise<DailySpendState> {
  const budgetPaise = getDailyBudgetPaise()
  if (!FEATURE_FLAGS.dailySpendGuard) {
    return { budgetPaise, usedPaise: 0, forceCheapModels: false }
  }

  const key = `budget:spend:${dayKeyPart()}`
  const usedPaise = costPaise > 0 ? await runtime.incrby(key, costPaise) : asNumber(await runtime.get(key))
  if (usedPaise === costPaise && costPaise > 0) {
    void runtime.expire(key, secondsUntilTomorrow())
  }
  return { budgetPaise, usedPaise, forceCheapModels: usedPaise >= budgetPaise }
}

// ---------------------------------------------------------------------------
// Provider circuit breaker
// ---------------------------------------------------------------------------

function circuitKey(provider: Provider): string {
  return `circuit:provider:${provider}`
}
function failureKey(provider: Provider): string {
  return `circuit:provider:${provider}:failures`
}

export async function isProviderCircuitOpen(runtime: HexicalRuntimeStore, provider: Provider): Promise<boolean> {
  return Boolean(await runtime.get(circuitKey(provider)))
}

export async function markProviderFailure(runtime: HexicalRuntimeStore, provider: Provider): Promise<void> {
  const failures = await runtime.incr(failureKey(provider))
  if (failures === 1) void runtime.expire(failureKey(provider), CIRCUIT_BREAKER_TTL_SECS)
  if (failures >= CIRCUIT_FAILURE_THRESHOLD) {
    await runtime.set(circuitKey(provider), '1', { ex: CIRCUIT_BREAKER_TTL_SECS })
  }
}

export async function markProviderSuccess(runtime: HexicalRuntimeStore, provider: Provider): Promise<void> {
  await Promise.all([runtime.del(failureKey(provider)), runtime.del(circuitKey(provider))])
}
