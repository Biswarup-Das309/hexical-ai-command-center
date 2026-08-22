import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { checkMessageQuota, checkRateLimit, reconcileMonthlyTokens, reserveMonthlyTokens } from '@/lib/hexical/limits'
import { REQUIRED_ENV } from '@/lib/hexical/types'

class FakeInvestigationRuntime {
  readonly windows: Array<{ key: string; capacity: number; windowSecs: number }> = []
  readonly budgets: Array<{ key: string; amount: number; cap: number; ttlSecs: number }> = []

  async get<T = unknown>(_key: string): Promise<T | null> {
    return null
  }

  async set<T = unknown>(_key: string, _value: T): Promise<string> {
    return 'OK'
  }

  async del(..._keys: string[]): Promise<number> {
    return 0
  }

  async incr(_key: string): Promise<number> {
    return 1
  }

  async incrby(_key: string, _delta: number): Promise<number> {
    return 1
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    return 1
  }

  async rateLimit(key: string, capacity: number, windowSecs: number) {
    this.windows.push({ key, capacity, windowSecs })
    return { allowed: true, remaining: capacity - 1, resetMs: Date.now() + windowSecs * 1_000 }
  }

  async reserveBudget(key: string, amount: number, cap: number, ttlSecs: number): Promise<[number, number, number]> {
    this.budgets.push({ key, amount, cap, ttlSecs })
    return [1, amount, cap - amount]
  }

  async reconcileBudget(_key: string, _delta: number): Promise<number> {
    return 1
  }
}

test('Investigation limits use the Supabase runtime contract', async () => {
  const runtime = new FakeInvestigationRuntime()

  const burst = await checkRateLimit(runtime, 'user-1', 'free', '127.0.0.1')
  assert.equal(burst.allowed, true)
  assert.equal(runtime.windows.length, 2)
  assert.match(runtime.windows[0]?.key ?? '', /^hexical:rl:user:free:user-1$/)
  assert.match(runtime.windows[1]?.key ?? '', /^hexical:rl:ip:free:127\.0\.0\.1$/)

  const quota = await checkMessageQuota(runtime, 'user-1', 'free')
  assert.equal(quota.allowed, true)
  assert.equal(quota.remaining, quota.limit - 1)
  assert.match(runtime.windows[2]?.key ?? '', /^hexical:msgquota:free:user-1$/)

  const reservation = await reserveMonthlyTokens(runtime, 'user-1', 'free', 100)
  assert.equal(reservation.allowed, true)
  assert.equal(runtime.budgets.length, 1)
  await reconcileMonthlyTokens(runtime, 'user-1', 'free', reservation.reservedTokens, 90)
})

test('the normal Investigation API no longer requires Upstash configuration', () => {
  assert.equal(REQUIRED_ENV.includes('UPSTASH_REDIS_REST_URL' as never), false)
  assert.equal(REQUIRED_ENV.includes('UPSTASH_REDIS_REST_TOKEN' as never), false)

  const route = readFileSync(new URL('../../app/api/verify/route.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(route, /@upstash\/redis|redisClient\(\)/)

  const legacyGateway = readFileSync(new URL('../../lib/ai-gateway.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(legacyGateway, /@upstash\/redis|new Redis|UPSTASH_REDIS/)
})
