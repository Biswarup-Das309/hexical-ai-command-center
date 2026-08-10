import assert from 'node:assert/strict'
import test from 'node:test'
import type { Redis } from '@upstash/redis'
import { WorkerRedisMock } from './worker-redis-mock'
import type { TTYLeasedJob } from '../../lib/tty/tty-execution-lease'
import { TTYWorkerAudit, createTTYWorkerAuditEvent } from '../../lib/tty/tty-worker-audit'
import { TTYWorkerAuthenticator, issueTTYWorkerToken, verifyWorkerToken } from '../../lib/tty/tty-worker-auth'
import { TTYWorkerHeartbeatService } from '../../lib/tty/tty-worker-heartbeat'
import { ttyWorkerActiveLeasesKey } from '../../lib/tty/tty-worker-keys'
import { createTTYWorkerMiddleware } from '../../lib/tty/tty-worker-middleware'
import { TTYWorkerLeaseObserver, computeLeaseAge, detectStaleLease } from '../../lib/tty/tty-worker-observer'
import { TTYWorkerRegistry } from '../../lib/tty/tty-worker-registry'
import { createTTYLeaseId, createTTYWorkerId, type TTYWorkerId } from '../../lib/tty/tty-worker-types'

const redisAsType = (redis: WorkerRedisMock): Redis => redis as unknown as Redis
const workerId = createTTYWorkerId('worker-a')
const secret = 'worker-plane-secret-0123456789012345'
const registration = {
  workerId,
  identity: 'host-a/tty-runtime',
  version: '1.2.3',
  capabilities: ['claim_lease', 'renew_lease', 'execute'] as const,
  metadata: { region: 'test', runtime: 'node' },
}

test('worker registry enforces uniqueness, immutable registration, validation, and state transitions', async () => {
  const redis = new WorkerRedisMock()
  let nowMs = 1_700_000_000_000
  const registry = new TTYWorkerRegistry(redisAsType(redis), { dependencies: { now: () => new Date(nowMs) } })
  const results = await Promise.all([registry.registerWorker(registration), registry.registerWorker(registration)])
  assert.equal(results.filter((result) => result.registered).length, 1)
  const registered = results.find((result) => result.registered)
  assert.ok(registered?.registered)
  const registeredAt = registered.worker.registeredAt
  assert.equal((await registry.registerWorker({ ...registration, version: 'bad' })).registered, false)
  const updated = await registry.updateWorker(workerId, { version: '1.2.4', metadata: { region: 'test-2' } })
  assert.equal(updated.updated, true)
  if (updated.updated) {
    assert.equal(updated.worker.identity, registration.identity)
    assert.equal(updated.worker.registeredAt, registeredAt)
    assert.equal(updated.worker.version, '1.2.4')
  }
  nowMs += 1_000
  const deactivated = await registry.deactivateWorker(workerId)
  assert.equal(deactivated.changed, true)
  if (deactivated.changed) assert.equal(deactivated.worker.status, 'inactive')
  const reactivated = await registry.reactivateWorker(workerId)
  assert.equal(reactivated.changed, true)
  assert.equal((await registry.listWorkers()).length, 1)
})

test('worker authentication verifies integrity, expiry, registration, status, and capability', async () => {
  const redis = new WorkerRedisMock()
  let nowMs = 1_700_000_000_000
  const registry = new TTYWorkerRegistry(redisAsType(redis), { dependencies: { now: () => new Date(nowMs) } })
  assert.equal((await registry.registerWorker(registration)).registered, true)
  const token = issueTTYWorkerToken(workerId, 'execute', secret, {
    now: () => nowMs,
    ttlMs: 10_000,
    tokenId: 'token-1',
  })
  const valid = verifyWorkerToken(token, secret, () => nowMs)
  assert.equal(valid.valid, true)
  assert.equal(verifyWorkerToken(`${token}tampered`, secret, () => nowMs).valid, false)
  const authenticator = new TTYWorkerAuthenticator(registry, secret, { now: () => new Date(nowMs) })
  const authenticated = await authenticator.authenticateWorker(token, 'claim_lease')
  assert.equal(authenticated.authenticated, true)
  nowMs += 11_000
  assert.deepEqual(await authenticator.authenticateWorker(token), { authenticated: false, reason: 'expired_token' })

  nowMs = 1_700_000_000_000
  const freshToken = issueTTYWorkerToken(workerId, 'claim_lease', secret, {
    now: () => nowMs,
    ttlMs: 10_000,
    tokenId: 'token-2',
  })
  await registry.deactivateWorker(workerId)
  assert.deepEqual(await authenticator.authenticateWorker(freshToken), {
    authenticated: false,
    reason: 'inactive_worker',
  })
  const unknown = createTTYWorkerId('worker-unknown')
  const unknownToken = issueTTYWorkerToken(unknown, 'execute', secret, { now: () => nowMs, ttlMs: 10_000 })
  await registry.reactivateWorker(workerId)
  assert.deepEqual(await authenticator.authenticateWorker(unknownToken), {
    authenticated: false,
    reason: 'unknown_worker',
  })
})

test('worker middleware rejects anonymous requests and forwards verified context', async () => {
  const redis = new WorkerRedisMock()
  const nowMs = 1_700_000_000_000
  const registry = new TTYWorkerRegistry(redisAsType(redis), { dependencies: { now: () => new Date(nowMs) } })
  await registry.registerWorker(registration)
  const authenticator = new TTYWorkerAuthenticator(registry, secret, { now: () => new Date(nowMs) })
  const middleware = createTTYWorkerMiddleware(authenticator)
  const missing = await middleware.authenticate(new Request('http://localhost'))
  assert.equal(missing.authorized, false)
  if (!missing.authorized) assert.equal(missing.response.status, 401)
  const token = issueTTYWorkerToken(workerId, 'execute', secret, { now: () => nowMs, ttlMs: 10_000 })
  const authorized = await middleware.authenticate(
    new Request('http://localhost', { headers: { authorization: `Bearer ${token}` } }),
    'claim_lease',
  )
  assert.equal(authorized.authorized, true)
})

test('heartbeat recording is monotonic, health is deterministic, offline transition recovers', async () => {
  const redis = new WorkerRedisMock()
  let nowMs = 1_700_000_000_000
  const registry = new TTYWorkerRegistry(redisAsType(redis), { dependencies: { now: () => new Date(nowMs) } })
  await registry.registerWorker(registration)
  const heartbeat = new TTYWorkerHeartbeatService(redisAsType(redis), registry, { now: () => new Date(nowMs) })
  const first = await heartbeat.recordHeartbeat({ workerId, sequence: 1, sentAt: new Date(nowMs - 500).toISOString() })
  assert.equal(first.recorded, true)
  assert.deepEqual(
    await heartbeat.recordHeartbeat({ workerId, sequence: 1, sentAt: new Date(nowMs - 500).toISOString() }),
    { recorded: false, reason: 'duplicate_heartbeat' },
  )
  nowMs += 31_000
  const stale = await heartbeat.computeWorkerHealth(workerId, new Date(nowMs))
  assert.equal(stale?.state, 'offline')
  const offline = await heartbeat.markWorkerOffline(workerId, new Date(nowMs))
  assert.equal(offline.offline, true)
  const recovered = await heartbeat.recordHeartbeat({ workerId, sequence: 2, sentAt: new Date(nowMs).toISOString() })
  assert.equal(recovered.recorded, true)
  if (recovered.recorded) assert.equal(recovered.health.state, 'online')
})

test('audit stream is append-only and replay preserves Redis ordering', async () => {
  const redis = new WorkerRedisMock()
  const audit = new TTYWorkerAudit(redisAsType(redis))
  const first = createTTYWorkerAuditEvent({
    eventType: 'worker_registered',
    workerId,
    timestamp: new Date(1_700_000_000_000).toISOString(),
  })
  await Promise.all([
    audit.appendEvent(first),
    audit.record({ eventType: 'worker_authenticated', workerId, timestamp: new Date(1_700_000_000_001).toISOString() }),
    audit.record({ eventType: 'worker_heartbeat', workerId, timestamp: new Date(1_700_000_000_002).toISOString() }),
  ])
  const replay = await audit.replay()
  assert.equal(replay.length, 3)
  assert.equal(replay[0].eventId, first.eventId)
  assert.equal(
    replay.every(
      (event) =>
        Object.hasOwn(event, 'sessionId') && Object.hasOwn(event, 'executionId') && Object.hasOwn(event, 'leaseId'),
    ),
    true,
  )
})

test('lease observer attributes, measures, reconciles, and detects stale leases', async () => {
  const redis = new WorkerRedisMock()
  const observer = new TTYWorkerLeaseObserver(redisAsType(redis))
  const sessionId = '00000000-0000-4000-8000-000000000031' as TTYLeasedJob['sessionId']
  const executionId = '00000000-0000-4000-8000-000000000032' as TTYLeasedJob['executionId']
  const job: TTYLeasedJob = {
    executionId,
    sessionId,
    ownerUserId: 'user-1',
    kind: 'session_utility',
    status: 'leased',
    createdAt: new Date(0).toISOString(),
    admittedAt: new Date(0).toISOString(),
    authorizationScopeId: null,
    resource: { maxExecutionDurationMs: 30_000, maxOutputBytes: 1_024 },
    attempt: 1,
    lease: {
      workerId,
      token: 'lease-token',
      leaseId: createTTYLeaseId('lease-token'),
      claimedAtMs: 1_000,
      renewedAtMs: 2_000,
      expiresAtMs: 50_000,
      maxExpiresAtMs: 60_000,
    },
  }
  await redis.set(`tty:job:${executionId}`, JSON.stringify(job))
  await observer.observeLeaseClaimed(job)
  const observation = await observer.getLeaseObservation(executionId)
  assert.ok(observation)
  assert.equal(observation?.workerId, workerId)
  assert.equal(computeLeaseAge(1_000, 2_500), 1_500)
  assert.equal(detectStaleLease(observation!, 25_000, 30_000), false)
  assert.equal(detectStaleLease(observation!, 60_000), true)
  assert.equal((await observer.listWorkerLeases(workerId)).length, 1)
  await redis.sadd(ttyWorkerActiveLeasesKey(workerId), 'stale-execution')
  assert.equal((await observer.listWorkerLeases(workerId)).length, 1)
})

test('invalid worker IDs are rejected before they can reach Redis', () => {
  assert.throws(() => createTTYWorkerId('worker id with spaces'))
  assert.equal(typeof workerId, 'string')
})
