/**
 * @file lib/hexical/limits.ts
 *
 * Three different problems, three different tools:
 *  - "How many requests / messages in a window" -> @upstash/ratelimit. Its
 *    sliding-window counters are atomic server-side (a single Lua script
 *    inside Upstash), which fixes the race the old hand-rolled
 *    "INCR then DECR if over" pattern had under concurrent requests.
 *  - "Reserve N tokens against a monthly budget, then true up to the real
 *    number afterwards" -> not a rate limiter's job (it has no concept of
 *    giving tokens back). Implemented here as two small atomic Lua scripts
 *    run directly against Redis.
 *  - "Reserve real provider $ cost against a monthly ceiling, then true up
 *    afterwards" -> same reserve/reconcile Lua pattern as tokens, but keyed
 *    on paise instead of token count. Exists because a flat token count
 *    can't tell a cheap input token apart from an output token that costs
 *    5-17x more depending on provider (see MODEL_PRICING_USD_PER_MILLION in
 *    types.ts) — so MONTHLY_TOKEN_BUDGETS alone can't be sized safely
 *    against a price in rupees. MONTHLY_TOKEN_BUDGETS stays in place as a
 *    loose backstop; MONTHLY_COST_BUDGET_PAISE is the real margin defense.
 */

import type { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
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
} from './types';
import type { RateLimitResult, MessageQuotaResult, TokenReservation, CostReservation, DailySpendState } from './types';
import { asNumber, dayKeyPart, monthKeyPart, secondsUntilNextMonth, secondsUntilTomorrow } from './util';

// ---------------------------------------------------------------------------
// Request-rate limiting (burst + rolling message quota) via @upstash/ratelimit
// ---------------------------------------------------------------------------

const burstLimiters = new Map<string, Ratelimit>();
const messageQuotaLimiters = new Map<Tier, Ratelimit>();
let swarmDailyLimiter: Ratelimit | null = null;

function getBurstLimiter(redis: Redis, tier: Tier, kind: 'user' | 'ip'): Ratelimit {
  const key = `${kind}:${tier}`;
  const cached = burstLimiters.get(key);
  if (cached) return cached;

  const cfg = RATE_LIMITS[tier];
  const capacity = kind === 'ip' ? cfg.maxReq * 3 : cfg.maxReq;
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(capacity, `${cfg.windowSecs} s`),
    analytics: false,
    prefix: `hexical:rl:${kind}`,
  });
  burstLimiters.set(key, limiter);
  return limiter;
}

function getMessageQuotaLimiter(redis: Redis, tier: Tier): Ratelimit {
  const cached = messageQuotaLimiters.get(tier);
  if (cached) return cached;

  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(MESSAGE_QUOTA_LIMITS[tier], `${MESSAGE_QUOTA_WINDOW_SECS} s`),
    analytics: false,
    prefix: 'hexical:msgquota',
  });
  messageQuotaLimiters.set(tier, limiter);
  return limiter;
}

function getSwarmDailyLimiter(redis: Redis): Ratelimit {
  if (swarmDailyLimiter) return swarmDailyLimiter;
  swarmDailyLimiter = new Ratelimit({
    redis,
    limiter: Ratelimit.fixedWindow(DAILY_SWARM_LIMIT, '1 d'),
    analytics: false,
    prefix: 'hexical:swarm',
  });
  return swarmDailyLimiter;
}

export async function checkRateLimit(redis: Redis, userId: string, tier: Tier, ip: string): Promise<RateLimitResult> {
  const cfg = RATE_LIMITS[tier];
  const [userResult, ipResult] = await Promise.all([
    getBurstLimiter(redis, tier, 'user').limit(userId),
    getBurstLimiter(redis, tier, 'ip').limit(ip),
  ]);

  return {
    allowed: userResult.success && ipResult.success,
    remaining: Math.min(userResult.remaining, ipResult.remaining),
    resetMs: Math.max(userResult.reset, ipResult.reset),
    limit: cfg.maxReq,
  };
}

export async function checkMessageQuota(redis: Redis, userId: string, tier: Tier): Promise<MessageQuotaResult> {
  const limit = MESSAGE_QUOTA_LIMITS[tier];
  const result = await getMessageQuotaLimiter(redis, tier).limit(`${userId}:${tier}`);
  const resetSeconds = Math.max(1, Math.ceil((result.reset - Date.now()) / 1_000));

  return {
    allowed: result.success,
    used: limit - result.remaining,
    remaining: Math.max(0, result.remaining),
    limit,
    resetSeconds,
  };
}

export async function checkSwarmDailyLimit(redis: Redis, userId: string): Promise<{ allowed: boolean; remaining: number }> {
  const result = await getSwarmDailyLimiter(redis).limit(userId);
  return { allowed: result.success, remaining: Math.max(0, result.remaining) };
}

export async function consumeNonce(redis: Redis, userId: string, nonce: string, ttlSecs: number): Promise<boolean> {
  const key = `nonce:${userId}:${nonce}`;
  const result = await redis.set(key, '1', { nx: true, ex: ttlSecs });
  return result === 'OK';
}

// ---------------------------------------------------------------------------
// Atomic ledgers (Lua) — monthly token budget + monthly cost budget + daily spend guard
// ---------------------------------------------------------------------------

/** Reserve `amount` against `key`, capped at `cap`. Sets a TTL only the first
 *  time the key is created. Returns [ok(0|1), newTotal, remaining]. Runs as a
 *  single Lua script so concurrent requests can never together push the
 *  ledger past `cap`, unlike a plain "INCR then undo if over" pattern.
 *  Shared by both the token ledger and the cost ledger below — the only
 *  difference between them is which unit (tokens vs paise) gets passed in. */
const RESERVE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if current + amount > cap then
  return {0, current, cap - current}
end
local updated = redis.call('INCRBY', KEYS[1], amount)
if updated == amount then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {1, updated, cap - updated}
`;

/** Adjust `key` by `delta` (may be negative), clamped so it never drops
 *  below zero. Returns the new value. Shared by both ledgers, same reason
 *  as RESERVE_SCRIPT above. */
const RECONCILE_SCRIPT = `
local delta = tonumber(ARGV[1])
local updated = redis.call('INCRBY', KEYS[1], delta)
if updated < 0 then
  redis.call('SET', KEYS[1], 0, 'KEEPTTL')
  return 0
end
return updated
`;

async function reserveAtomic(redis: Redis, key: string, amount: number, cap: number, ttlSecs: number): Promise<[number, number, number]> {
  const result = await redis.eval(RESERVE_SCRIPT, [key], [String(Math.max(1, amount)), String(cap), String(ttlSecs)]);
  const [ok, updated, remaining] = result as [number, number, number];
  return [ok, updated, remaining];
}

async function reconcileAtomic(redis: Redis, key: string, delta: number): Promise<number> {
  if (delta === 0) return asNumber(await redis.get<number | string>(key));
  const result = await redis.eval(RECONCILE_SCRIPT, [key], [String(delta)]);
  return asNumber(result);
}

// --- token ledger ------------------------------------------------------

function monthlyBudgetKey(userId: string, tier: Tier): string {
  return `budget:tokens:${userId}:${tier}:${monthKeyPart()}`;
}

export async function readMonthlyTokenUsage(redis: Redis, userId: string, tier: Tier): Promise<number> {
  return asNumber(await redis.get<number | string>(monthlyBudgetKey(userId, tier)));
}

export async function reserveMonthlyTokens(redis: Redis, userId: string, tier: Tier, estimatedTokens: number): Promise<TokenReservation> {
  const limitTokens = MONTHLY_TOKEN_BUDGETS[tier];
  const safetyBuffer = 1.3;
  const reservedTokens = Math.max(1, Math.ceil(estimatedTokens * safetyBuffer));
  const key = monthlyBudgetKey(userId, tier);

  const [ok, updated, remaining] = await reserveAtomic(redis, key, reservedTokens, limitTokens, secondsUntilNextMonth());

  if (ok === 0) {
    return {
      allowed: false,
      reservedTokens: 0,
      usedTokens: updated,
      remainingTokens: Math.max(0, remaining),
      limitTokens,
    };
  }

  return {
    allowed: true,
    reservedTokens,
    usedTokens: updated,
    remainingTokens: Math.max(0, remaining),
    limitTokens,
  };
}

export async function reconcileMonthlyTokens(
  redis: Redis,
  userId: string,
  tier: Tier,
  reservedTokens: number,
  actualTokens: number,
): Promise<number> {
  const key = monthlyBudgetKey(userId, tier);
  const delta = actualTokens - reservedTokens;
  const usedTokens = await reconcileAtomic(redis, key, delta);
  return Math.max(0, MONTHLY_TOKEN_BUDGETS[tier] - usedTokens);
}

// --- cost ledger ---------------------------------------------------------
// Same reserve-then-reconcile shape as the token ledger above, but keyed on
// paise against MONTHLY_COST_BUDGET_PAISE instead of tokens against
// MONTHLY_TOKEN_BUDGETS. Caller computes the paise amount (via
// estimateCostPaise in lib/hexical/cache.ts, using the request's provider +
// tokensIn/tokensOut) and passes it in — this module doesn't know about
// provider pricing, it just runs the same atomic ledger on a different unit.

function monthlyCostKey(userId: string, tier: Tier): string {
  return `budget:cost:${userId}:${tier}:${monthKeyPart()}`;
}

export async function readMonthlyCostUsage(redis: Redis, userId: string, tier: Tier): Promise<number> {
  return asNumber(await redis.get<number | string>(monthlyCostKey(userId, tier)));
}

export async function reserveMonthlyCost(redis: Redis, userId: string, tier: Tier, estimatedPaise: number): Promise<CostReservation> {
  const limitPaise = MONTHLY_COST_BUDGET_PAISE[tier];
  const safetyBuffer = 1.3;
  const reservedPaise = Math.max(1, Math.ceil(estimatedPaise * safetyBuffer));
  const key = monthlyCostKey(userId, tier);

  const [ok, updated, remaining] = await reserveAtomic(redis, key, reservedPaise, limitPaise, secondsUntilNextMonth());

  if (ok === 0) {
    return {
      allowed: false,
      reservedPaise: 0,
      usedPaise: updated,
      remainingPaise: Math.max(0, remaining),
      limitPaise,
    };
  }

  return {
    allowed: true,
    reservedPaise,
    usedPaise: updated,
    remainingPaise: Math.max(0, remaining),
    limitPaise,
  };
}

export async function reconcileMonthlyCost(
  redis: Redis,
  userId: string,
  tier: Tier,
  reservedPaise: number,
  actualPaise: number,
): Promise<number> {
  const key = monthlyCostKey(userId, tier);
  const delta = actualPaise - reservedPaise;
  const usedPaise = await reconcileAtomic(redis, key, delta);
  return Math.max(0, MONTHLY_COST_BUDGET_PAISE[tier] - usedPaise);
}

// --- daily spend guard (company-wide circuit breaker, not per-user) ------

export async function readDailySpend(redis: Redis): Promise<DailySpendState> {
  const budgetPaise = getDailyBudgetPaise();
  if (!FEATURE_FLAGS.dailySpendGuard) {
    return { budgetPaise, usedPaise: 0, forceCheapModels: false };
  }
  const usedPaise = asNumber(await redis.get<number | string>(`budget:spend:${dayKeyPart()}`));
  return { budgetPaise, usedPaise, forceCheapModels: usedPaise >= budgetPaise };
}

export async function recordDailySpend(redis: Redis, costPaise: number): Promise<DailySpendState> {
  const budgetPaise = getDailyBudgetPaise();
  if (!FEATURE_FLAGS.dailySpendGuard) {
    return { budgetPaise, usedPaise: 0, forceCheapModels: false };
  }

  const key = `budget:spend:${dayKeyPart()}`;
  const usedPaise = costPaise > 0 ? await redis.incrby(key, costPaise) : asNumber(await redis.get(key));
  if (usedPaise === costPaise && costPaise > 0) {
    void redis.expire(key, secondsUntilTomorrow());
  }
  return { budgetPaise, usedPaise, forceCheapModels: usedPaise >= budgetPaise };
}

// ---------------------------------------------------------------------------
// Provider circuit breaker
// ---------------------------------------------------------------------------

function circuitKey(provider: Provider): string {
  return `circuit:provider:${provider}`;
}
function failureKey(provider: Provider): string {
  return `circuit:provider:${provider}:failures`;
}

export async function isProviderCircuitOpen(redis: Redis, provider: Provider): Promise<boolean> {
  return Boolean(await redis.get(circuitKey(provider)));
}

export async function markProviderFailure(redis: Redis, provider: Provider): Promise<void> {
  const failures = await redis.incr(failureKey(provider));
  if (failures === 1) void redis.expire(failureKey(provider), CIRCUIT_BREAKER_TTL_SECS);
  if (failures >= CIRCUIT_FAILURE_THRESHOLD) {
    await redis.set(circuitKey(provider), '1', { ex: CIRCUIT_BREAKER_TTL_SECS });
  }
}

export async function markProviderSuccess(redis: Redis, provider: Provider): Promise<void> {
  await Promise.all([redis.del(failureKey(provider)), redis.del(circuitKey(provider))]);
}