import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'

import type { Redis } from '@upstash/redis'

import {
  createTTYExecutionId,
  type InternalTTYSession,
  type TTYResourceLimits,
  type TTYSessionId,
  type TTYTerminationReason
} from '../../lib/tty/tty-types'
import { TTYSessionStore, toBrowserSafeSession } from '../../lib/tty/tty-session-store'

const TEST_NOW = Date.parse('2026-08-04T00:00:00.000Z')
const COUNTER_TTL_SECONDS = 24 * 60 * 60

interface FakeSetOptions {
  readonly ex?: number
  readonly nx?: boolean
}

interface FakeSetMemberCollection {
  readonly kind: 'set'
  readonly members: Set<string>
}

interface FakeSortedCollection {
  readonly kind: 'sorted'
  readonly members: Map<string, number>
}

type FakeScalar = string | number | boolean
type FakeValue = FakeScalar | FakeSetMemberCollection | FakeSortedCollection

interface FakeEntry {
  value: FakeValue
  expiresAt: number | null
}

interface TerminalReadGate {
  readonly entered: Promise<void>
  readonly release: () => void
}

/**
 * Deterministic Redis contract double. It models the Upstash behaviors this
 * store relies on: command-level atomicity, SET NX, EXPIRE, numeric INCR/DECR,
 * JSON auto-deserialization, sets, and sorted sets. It intentionally does not
 * claim to model distributed scheduling or network behavior.
 */
class FakeRedis {
  private readonly entries = new Map<string, FakeEntry>()
  private terminalReadGate: {
    readonly entered: () => void
    readonly release: Promise<void>
  } | null = null

  private serialize(value: unknown): FakeScalar {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value
    }

    const serialized = JSON.stringify(value)
    if (serialized === undefined) {
      throw new Error('Fake Redis cannot serialize undefined.')
    }
    return serialized
  }

  private entryFor(key: string): FakeEntry | null {
    const entry = this.entries.get(key)
    if (entry === undefined) return null

    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      this.entries.delete(key)
      return null
    }

    return entry
  }

  private requireCollection<T extends FakeSetMemberCollection | FakeSortedCollection>(
    key: string,
    kind: T['kind']
  ): T | null {
    const entry = this.entryFor(key)
    if (entry === null) return null
    if (typeof entry.value !== 'object' || entry.value.kind !== kind) {
      throw new Error(`Fake Redis key '${key}' has the wrong collection type.`)
    }
    return entry.value as T
  }

  private scalarNumberFor(key: string): number {
    const entry = this.entryFor(key)
    if (entry === null) return 0
    if (typeof entry.value === 'number') return entry.value
    if (typeof entry.value === 'string' && /^-?\d+$/.test(entry.value)) {
      return Number(entry.value)
    }
    throw new Error(`Fake Redis key '${key}' is not numeric.`)
  }

  blockNextTerminalRead(): TerminalReadGate {
    let entered = () => {}
    let releasePromiseResolve = () => {}
    const enteredPromise = new Promise<void>(resolve => {
      entered = resolve
    })
    const releasePromise = new Promise<void>(resolve => {
      releasePromiseResolve = resolve
    })

    this.terminalReadGate = { entered, release: releasePromise }
    return { entered: enteredPromise, release: releasePromiseResolve }
  }

  async get<T>(key: string): Promise<T | null> {
    let entry: FakeEntry | null
    if (key.endsWith(':terminal') && this.terminalReadGate !== null) {
      const gate = this.terminalReadGate
      this.terminalReadGate = null
      entry = this.entryFor(key)
      gate.entered()
      await gate.release
    } else {
      entry = this.entryFor(key)
    }

    if (entry === null) return null
    if (typeof entry.value !== 'string' && typeof entry.value !== 'number' && typeof entry.value !== 'boolean') {
      throw new Error(`Fake Redis GET cannot read collection key '${key}'.`)
    }

    if (typeof entry.value !== 'string') return entry.value as T

    try {
      return JSON.parse(entry.value) as T
    } catch {
      return entry.value as T
    }
  }

  async set(key: string, value: unknown, options?: FakeSetOptions): Promise<string | null> {
    if (options?.nx && this.entryFor(key) !== null) return null

    this.entries.set(key, {
      value: this.serialize(value),
      expiresAt: options?.ex === undefined ? null : Date.now() + options.ex * 1000
    })
    return 'OK'
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0
    for (const key of keys) {
      if (this.entryFor(key) !== null) {
        this.entries.delete(key)
        deleted += 1
      }
    }
    return deleted
  }

  async expire(key: string, seconds: number): Promise<0 | 1> {
    const entry = this.entryFor(key)
    if (entry === null) return 0
    entry.expiresAt = Date.now() + seconds * 1000
    return 1
  }

  async incr(key: string): Promise<number> {
    const value = this.scalarNumberFor(key) + 1
    const entry = this.entryFor(key)
    if (entry === null) {
      this.entries.set(key, { value, expiresAt: null })
    } else {
      entry.value = value
    }
    return value
  }

  async decr(key: string): Promise<number> {
    const value = this.scalarNumberFor(key) - 1
    const entry = this.entryFor(key)
    if (entry === null) {
      this.entries.set(key, { value, expiresAt: null })
    } else {
      entry.value = value
    }
    return value
  }

  async sadd(key: string, member: unknown, ...members: unknown[]): Promise<number> {
    let collection = this.requireCollection<FakeSetMemberCollection>(key, 'set')
    if (collection === null) {
      collection = { kind: 'set', members: new Set<string>() }
      this.entries.set(key, { value: collection, expiresAt: null })
    }

    const values = [member, ...members].map(value => String(value))
    const before = collection.members.size
    for (const value of values) collection.members.add(value)
    return collection.members.size - before
  }

  async smembers(key: string): Promise<string[]> {
    const collection = this.requireCollection<FakeSetMemberCollection>(key, 'set')
    return collection === null ? [] : [...collection.members]
  }

  async srem(key: string, ...members: unknown[]): Promise<number> {
    const collection = this.requireCollection<FakeSetMemberCollection>(key, 'set')
    if (collection === null) return 0

    let removed = 0
    for (const member of members) {
      if (collection.members.delete(String(member))) removed += 1
    }
    return removed
  }

  async zadd(
    key: string,
    scoreMember: { readonly score: number; readonly member: unknown }
  ): Promise<number | null> {
    let collection = this.requireCollection<FakeSortedCollection>(key, 'sorted')
    if (collection === null) {
      collection = { kind: 'sorted', members: new Map<string, number>() }
      this.entries.set(key, { value: collection, expiresAt: null })
    }

    const member = String(scoreMember.member)
    const existed = collection.members.has(member)
    collection.members.set(member, scoreMember.score)
    return existed ? 0 : 1
  }

  async zremrangebyscore(key: string, min: number, max: number): Promise<number> {
    const collection = this.requireCollection<FakeSortedCollection>(key, 'sorted')
    if (collection === null) return 0

    let removed = 0
    for (const [member, score] of collection.members) {
      if (score >= min && score <= max) {
        collection.members.delete(member)
        removed += 1
      }
    }
    return removed
  }

  async zcard(key: string): Promise<number> {
    return this.requireCollection<FakeSortedCollection>(key, 'sorted')?.members.size ?? 0
  }

  ttlSeconds(key: string): number {
    const entry = this.entryFor(key)
    if (entry === null) return -2
    if (entry.expiresAt === null) return -1
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000))
  }

  rawValue(key: string): FakeValue | null {
    return this.entryFor(key)?.value ?? null
  }
}

const limits = (overrides: Partial<TTYResourceLimits> = {}): TTYResourceLimits => ({
  maxConcurrentSessions: 3,
  maxConcurrentExecutionsPerSession: 50,
  maxExecutionsPerMinute: 100,
  maxExecutionDurationMs: 5_000,
  maxSessionIdleMs: 4_001,
  maxSessionDurationMs: 8_001,
  maxOutputBytesPerExecution: 10_000,
  maxQueueDepth: 50,
  ...overrides
})

function keySet(sessionId: TTYSessionId): Record<'core' | 'status' | 'terminal' | 'active' | 'queue' | 'window', string> {
  return {
    core: `tty:session:${sessionId}:core`,
    status: `tty:session:${sessionId}:status`,
    terminal: `tty:session:${sessionId}:terminal`,
    active: `tty:session:${sessionId}:active-executions`,
    queue: `tty:session:${sessionId}:queue-depth`,
    window: `tty:session:${sessionId}:exec-window`
  }
}

function userIndexKey(userId: string): string {
  return `tty:user:${userId}:sessions`
}

function startFixture(overrides: Partial<TTYResourceLimits> = {}) {
  mock.timers.enable({ apis: ['Date'], now: TEST_NOW })
  const redis = new FakeRedis()
  const store = new TTYSessionStore(redis as unknown as Redis)
  const principal = { userId: 'user-1', tier: 'pro' as const }
  return { redis, store, principal, sessionLimits: limits(overrides) }
}

async function createFixture(overrides: Partial<TTYResourceLimits> = {}): Promise<{
  readonly redis: FakeRedis
  readonly store: TTYSessionStore
  readonly principal: { readonly userId: string; readonly tier: 'pro' }
  readonly sessionLimits: TTYResourceLimits
  readonly session: InternalTTYSession
}> {
  const fixture = startFixture(overrides)
  const session = await fixture.store.createSession({ principal: fixture.principal, limits: fixture.sessionLimits })
  return { ...fixture, session }
}

afterEach(() => {
  mock.timers.reset()
})

test('creates trusted state with expected Redis TTLs and typed round-trip', async () => {
  const { redis, store, principal, sessionLimits, session } = await createFixture({
    maxSessionIdleMs: 4_001,
    maxSessionDurationMs: 8_001
  })
  const keys = keySet(session.sessionId)

  assert.equal(session.ownerUserId, principal.userId)
  assert.equal(session.tier, principal.tier)
  assert.equal(session.status, 'active')
  assert.deepEqual(session.limits, sessionLimits)
  assert.deepEqual(session.usage, {
    activeSessions: 1,
    activeExecutionsInSession: 0,
    queueDepth: 0,
    executionsInLastMinute: 0,
    capturedAt: new Date(TEST_NOW).toISOString()
  })
  assert.equal(redis.ttlSeconds(keys.core), 9)
  assert.equal(redis.ttlSeconds(keys.status), 5)
  assert.equal(redis.ttlSeconds(userIndexKey(principal.userId)), -1)

  const rawCore = redis.rawValue(keys.core)
  assert.equal(typeof rawCore, 'string')
  const typedCore = await redis.get<Record<string, unknown>>(keys.core)
  assert.equal(typeof typedCore, 'object')
  assert.equal(typedCore?.ownerUserId, principal.userId)

  const loaded = await store.getSession(session.sessionId, principal.userId)
  assert.deepEqual(loaded, session)
})

test('isolates owner-bound reads and lifecycle mutations', async () => {
  const { store, session } = await createFixture()
  const otherUserId = 'user-2'

  await store.recordExecutionQueued(session.sessionId)
  await store.recordExecutionStarted(session.sessionId, createTTYExecutionId())

  assert.equal(await store.getSession(session.sessionId, otherUserId), null)
  assert.equal(await store.touchSession(session.sessionId, otherUserId), null)
  assert.deepEqual(await store.terminateSession(session.sessionId, otherUserId, 'user_requested'), {
    sessionId: session.sessionId,
    acknowledged: false
  })

  const ownerView = await store.getSession(session.sessionId, session.ownerUserId)
  assert.equal(ownerView?.status, 'active')
  assert.equal(ownerView?.usage.queueDepth, 1)
})

test('fails closed for a non-owner usage snapshot request', async () => {
  const { store, session } = await createFixture()
  await store.recordExecutionStarted(session.sessionId, createTTYExecutionId())

  const unauthorizedSnapshot = await store.getUsageSnapshot(session.sessionId, 'user-2')
  assert.equal(unauthorizedSnapshot.activeSessions, 0)
  assert.equal(unauthorizedSnapshot.activeExecutionsInSession, 0)
  assert.equal(unauthorizedSnapshot.queueDepth, 0)
  assert.equal(unauthorizedSnapshot.executionsInLastMinute, 0)
})

test('keeps execution and queue accounting numeric across typed Redis reads', async () => {
  const { redis, store, session } = await createFixture()
  const ids = [createTTYExecutionId(), createTTYExecutionId()]

  await Promise.all([store.recordExecutionQueued(session.sessionId), store.recordExecutionQueued(session.sessionId)])
  await store.recordExecutionDequeued(session.sessionId)
  await Promise.all(ids.map(executionId => store.recordExecutionStarted(session.sessionId, executionId)))

  let current = await store.getSession(session.sessionId, session.ownerUserId)
  assert.equal(typeof current?.usage.activeExecutionsInSession, 'number')
  assert.equal(typeof current?.usage.queueDepth, 'number')
  assert.equal(typeof current?.usage.executionsInLastMinute, 'number')
  assert.equal(current?.usage.activeExecutionsInSession, 2)
  assert.equal(current?.usage.queueDepth, 1)
  assert.equal(current?.usage.executionsInLastMinute, 2)
  assert.equal(await redis.get<number>(keySet(session.sessionId).active), 2)
  assert.equal(await redis.get<number>(keySet(session.sessionId).queue), 1)

  await store.recordExecutionFinished(session.sessionId)
  current = await store.getSession(session.sessionId, session.ownerUserId)
  assert.equal(current?.usage.activeExecutionsInSession, 1)
  assert.equal(current?.usage.executionsInLastMinute, 2)
})

test('floors decrements at zero and refreshes the counter TTL', async () => {
  const { redis, store, session } = await createFixture()
  const keys = keySet(session.sessionId)

  await store.recordExecutionDequeued(session.sessionId)
  assert.equal(await redis.get<number>(keys.queue), 0)
  assert.equal(redis.ttlSeconds(keys.queue), COUNTER_TTL_SECONDS)

  mock.timers.tick(10_000)
  await store.recordExecutionQueued(session.sessionId)
  assert.equal(await redis.get<number>(keys.queue), 1)
  assert.equal(redis.ttlSeconds(keys.queue), COUNTER_TTL_SECONDS)

  mock.timers.tick(10_000)
  await store.recordExecutionDequeued(session.sessionId)
  await store.recordExecutionDequeued(session.sessionId)
  assert.equal(await redis.get<number>(keys.queue), 0)
  assert.equal(redis.ttlSeconds(keys.queue), COUNTER_TTL_SECONDS)
})

test('discovers idle expiration lazily and prevents revival', async () => {
  const { redis, store, session } = await createFixture({
    maxSessionIdleMs: 1_000,
    maxSessionDurationMs: 60_000
  })
  const keys = keySet(session.sessionId)

  mock.timers.tick(1_001)
  const expired = await store.getSession(session.sessionId, session.ownerUserId)
  assert.equal(expired?.status, 'expired')
  assert.equal((await redis.get<{ reason: string }>(keys.terminal))?.reason, 'idle_timeout')
  assert.equal(await store.touchSession(session.sessionId, session.ownerUserId), null)

  await store.recordExecutionQueued(session.sessionId)
  const afterAttemptedRevival = await store.getSession(session.sessionId, session.ownerUserId)
  assert.equal(afterAttemptedRevival?.status, 'expired')
  assert.equal(afterAttemptedRevival?.usage.queueDepth, 0)
})

test('enforces absolute expiration before the buffered core TTL disappears', async () => {
  const { redis, store, session } = await createFixture({
    maxSessionIdleMs: 60_000,
    maxSessionDurationMs: 1_500
  })
  const keys = keySet(session.sessionId)

  mock.timers.tick(1_501)
  assert.notEqual(redis.ttlSeconds(keys.core), -2)
  const expired = await store.getSession(session.sessionId, session.ownerUserId)
  assert.equal(expired?.status, 'expired')
  assert.equal((await redis.get<{ reason: string }>(keys.terminal))?.reason, 'duration_limit_exceeded')
  assert.equal(await store.touchSession(session.sessionId, session.ownerUserId), null)

  mock.timers.tick(499)
  assert.equal(await store.getSession(session.sessionId, session.ownerUserId), null)
})

test('uses an atomic NX latch for competing termination attempts', async () => {
  const { redis, store, session } = await createFixture()
  const reasons: readonly TTYTerminationReason[] = [
    'user_requested',
    'system_shutdown',
    'policy_violation',
    'resource_limit_exceeded'
  ]

  const results = await Promise.all(
    Array.from({ length: 20 }, (_unused, index) =>
      store.terminateSession(session.sessionId, session.ownerUserId, reasons[index % reasons.length])
    )
  )
  const terminationTimes = new Set(results.map(result => result.terminatedAt))
  const terminal = await redis.get<{ status: string; reason: string; terminatedAt: string }>(keySet(session.sessionId).terminal)

  assert.ok(results.every(result => result.acknowledged))
  assert.equal(terminationTimes.size, 1)
  assert.equal(terminal?.status, 'terminated')
  assert.ok(reasons.includes(terminal?.reason as TTYTerminationReason))
  assert.equal(terminal?.terminatedAt, results[0].terminatedAt)
})

test('preserves terminal state during concurrent increments and decrements', async () => {
  const { store, session } = await createFixture()
  const executionIds = Array.from({ length: 40 }, () => createTTYExecutionId())

  await Promise.all(executionIds.map(executionId => store.recordExecutionStarted(session.sessionId, executionId)))
  let current = await store.getSession(session.sessionId, session.ownerUserId)
  assert.equal(current?.usage.activeExecutionsInSession, 40)
  assert.equal(current?.usage.executionsInLastMinute, 40)

  await Promise.all(executionIds.map(() => store.recordExecutionFinished(session.sessionId)))
  current = await store.getSession(session.sessionId, session.ownerUserId)
  assert.equal(current?.usage.activeExecutionsInSession, 0)
  assert.equal(current?.status, 'active')

  await store.terminateSession(session.sessionId, session.ownerUserId, 'user_requested')
  await Promise.all([
    store.recordExecutionQueued(session.sessionId),
    store.recordExecutionStarted(session.sessionId, createTTYExecutionId()),
    store.recordExecutionQueued(session.sessionId)
  ])

  current = await store.getSession(session.sessionId, session.ownerUserId)
  assert.equal(current?.status, 'terminated')
  assert.equal(current?.usage.activeExecutionsInSession, 0)
})

test('keeps the session terminal when termination races a counter mutation', async () => {
  const { redis, store, session } = await createFixture()
  const keys = keySet(session.sessionId)
  const gate = redis.blockNextTerminalRead()

  const lateQueueMutation = store.recordExecutionQueued(session.sessionId)
  await gate.entered

  const termination = store.terminateSession(session.sessionId, session.ownerUserId, 'system_shutdown')
  await termination
  gate.release()
  await lateQueueMutation

  const afterRace = await store.getSession(session.sessionId, session.ownerUserId)
  assert.equal(afterRace?.status, 'terminated')
  assert.equal(await store.touchSession(session.sessionId, session.ownerUserId), null)
  assert.equal(redis.ttlSeconds(keys.queue), COUNTER_TTL_SECONDS)
})

test('refreshes counter and execution-window TTLs while leaving the durable index unexpired', async () => {
  const { redis, store, principal, session } = await createFixture()
  const keys = keySet(session.sessionId)
  const indexKey = userIndexKey(principal.userId)

  await store.recordExecutionQueued(session.sessionId)
  assert.equal(redis.ttlSeconds(keys.queue), COUNTER_TTL_SECONDS)
  mock.timers.tick(500)
  await store.recordExecutionQueued(session.sessionId)
  assert.equal(redis.ttlSeconds(keys.queue), COUNTER_TTL_SECONDS)

  await store.recordExecutionStarted(session.sessionId, createTTYExecutionId())
  assert.equal(redis.ttlSeconds(keys.active), COUNTER_TTL_SECONDS)
  assert.equal(redis.ttlSeconds(keys.window), COUNTER_TTL_SECONDS)
  assert.equal(redis.ttlSeconds(indexKey), -1)
})

test('terminal cleanup removes only the session-indexed admission jobs and idempotency records', async () => {
  const { redis, store, session } = await createFixture()
  const jobsKey = `tty:session:${session.sessionId}:jobs`
  const idempotenciesKey = `tty:session:${session.sessionId}:idempotencies`
  const jobKey = 'tty:job:job-1'
  const idempotencyKey = `tty:admission:idempotency:${session.ownerUserId}:${session.sessionId}:key-1`

  await redis.sadd(jobsKey, 'job-1')
  await redis.sadd(idempotenciesKey, idempotencyKey)
  await redis.set(jobKey, '{"status":"queued"}')
  await redis.set(idempotencyKey, '{"job":"job-1"}')
  await store.terminateSession(session.sessionId, session.ownerUserId, 'user_requested')

  assert.equal(await redis.get(jobKey), null)
  assert.equal(await redis.get(idempotencyKey), null)
  assert.deepEqual(await redis.smembers(jobsKey), [])
  assert.deepEqual(await redis.smembers(idempotenciesKey), [])
})

test('prunes stale index members after core storage expiration', async () => {
  const { redis, store, principal, session } = await createFixture({
    maxSessionDurationMs: 1_500,
    maxSessionIdleMs: 60_000
  })
  const indexKey = userIndexKey(principal.userId)

  mock.timers.tick(2_000)
  assert.equal(await store.countActiveSessionsForUser(principal.userId), 0)
  assert.deepEqual(await redis.smembers(indexKey), [])
  assert.equal(await store.getSession(session.sessionId, principal.userId), null)
})

test('browser-safe projection excludes trusted owner and usage fields', async () => {
  const { store, session } = await createFixture()
  const browserSafe = toBrowserSafeSession(session)
  const serialized = JSON.stringify(browserSafe)

  assert.equal('ownerUserId' in browserSafe, false)
  assert.equal('usage' in browserSafe, false)
  assert.equal(serialized.includes(session.ownerUserId), false)
  assert.equal(serialized.includes('activeExecutionsInSession'), false)
  assert.deepEqual(browserSafe, {
    sessionId: session.sessionId,
    status: 'active',
    tier: 'pro',
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    limits: session.limits
  })
})

test('worker-aware execution metadata exposes attribution without lease secrets', async () => {
  const { redis, store, principal, session } = await createFixture()
  const executionId = createTTYExecutionId()
  const workerId = 'worker-a'
  await redis.sadd(`tty:session:${session.sessionId}:jobs`, executionId)
  await redis.set(`tty:job:${executionId}`, JSON.stringify({
    executionId,
    sessionId: session.sessionId,
    ownerUserId: principal.userId,
    status: 'leased',
    lease: {
      workerId,
      token: 'do-not-return',
      leaseId: 'lease-1',
      claimedAtMs: TEST_NOW,
      renewedAtMs: TEST_NOW + 500,
      expiresAtMs: TEST_NOW + 30_000,
      maxExpiresAtMs: TEST_NOW + 300_000
    }
  }))
  const metadata = await store.getWorkerExecutionMetadata(session.sessionId, principal.userId)
  assert.equal(metadata.length, 1)
  assert.equal(metadata[0].workerId, workerId)
  assert.equal(metadata[0].leaseId, 'lease-1')
  assert.equal(JSON.stringify(metadata).includes('do-not-return'), false)
})
