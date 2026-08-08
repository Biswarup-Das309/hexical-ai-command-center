import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TTYExecutionLeaseManager, TTY_MAX_LEASE_ATTEMPTS, TTY_LEASE_DURATION_MS } from '../../lib/tty/tty-execution-lease'
import type { TTYExecutionId, TTYSessionId } from '../../lib/tty/tty-types'
import type { TTYWorkerAuthContext, TTYWorkerId } from '../../lib/tty/tty-worker-types'
import type { Redis } from '@upstash/redis'

const sessionId = '00000000-0000-4000-8000-000000000021' as TTYSessionId
const executionId = '00000000-0000-4000-8000-000000000022' as TTYExecutionId

interface MockLease {
  workerId: string
  token: string
  claimedAtMs: number
  expiresAtMs: number
  maxExpiresAtMs: number
}

interface MockJob {
  executionId: TTYExecutionId
  sessionId: TTYSessionId
  ownerUserId: string
  kind: string
  status: 'queued' | 'leased' | 'abandoned'
  createdAt: string
  admittedAt: string
  authorizationScopeId: string | null
  resource: { maxExecutionDurationMs: number; maxOutputBytes: number }
  attempt?: number
  lease?: MockLease
}

class LeaseRedisContractMock {
  job: MockJob | null = {
    executionId,
    sessionId,
    ownerUserId: 'user-1',
    kind: 'session_utility',
    status: 'queued',
    createdAt: new Date(0).toISOString(),
    admittedAt: new Date(0).toISOString(),
    authorizationScopeId: null,
    resource: { maxExecutionDurationMs: 30_000, maxOutputBytes: 262_144 },
    attempt: 0
  }
  sessionLive = true
  terminal = false
  queue = 1
  active = 1

  async eval(_script: string, _keys: string[], args: string[]): Promise<unknown> {
    if (!this.job) return [0, 'missing_job']
    const job = this.job
    const now = Number(args[2])
    const suppliedSessionId = _script.includes('job.attempt = attempt + 1') ? (args.length === 7 ? args[6] : args[4]) : args[args.length - 1]
    if (job.sessionId !== suppliedSessionId) return [0, 'session_terminated']

    if (args.length === 5 && _script.includes('tty-lease-complete')) {
      if (job.status !== 'leased' || !job.lease || job.lease.workerId !== args[0] || job.lease.token !== args[1]) return [0, 'not_owner']
      if (job.lease.expiresAtMs <= now) return [0, 'lease_expired']
      if (!this.sessionLive || this.terminal) return [0, 'session_terminated']
      const completed = JSON.stringify(job)
      this.active = Math.max(0, this.active - 1)
      this.job = null
      return [1, completed]
    }

    if (args.length === 8) {
      if (job.status !== 'queued') return [0, 'not_queued']
      if (!this.sessionLive || this.terminal) return [0, 'session_terminated']
      const attempt = (job.attempt ?? 0) + 1
      if (attempt > Number(args[3])) return [0, 'attempts_exhausted']
      this.queue = Math.max(0, this.queue - 1)
      job.status = 'leased'
      job.attempt = attempt
      job.lease = { workerId: args[0], token: args[1], claimedAtMs: now, expiresAtMs: now + Number(args[4]), maxExpiresAtMs: now + Number(args[5]) }
      return [1, JSON.stringify(job)]
    }

    if (args.length === 6 && job.status === 'leased' && _script.includes('local nextExpiry')) {
      if (!job.lease || job.lease.workerId !== args[0] || job.lease.token !== args[1]) return [0, 'not_owner']
      if (job.lease.expiresAtMs <= now || job.lease.maxExpiresAtMs <= now) return [0, 'lease_expired']
      if (!this.sessionLive || this.terminal) return [0, 'session_terminated']
      job.lease.expiresAtMs = Math.min(now + Number(args[3]), job.lease.maxExpiresAtMs)
      return [1, JSON.stringify(job)]
    }

    if (args.length === 7 && _script.includes('job.attempt = attempt + 1')) {
      if (job.status !== 'leased' || !job.lease || job.lease.workerId !== args[0] || job.lease.token !== args[1]) return [0, 'not_owner']
      if (job.lease.expiresAtMs <= now) return [0, 'lease_expired']
      if (!this.sessionLive || this.terminal) return [0, 'session_terminated']
      if ((job.attempt ?? 0) >= Number(args[5])) {
        this.active = Math.max(0, this.active - 1)
        job.status = 'abandoned'
        delete job.lease
        return [0, 'attempts_exhausted']
      }
      job.status = 'queued'
      job.attempt = (job.attempt ?? 0) + 1
      delete job.lease
      this.queue += 1
      return [1, JSON.stringify(job)]
    }

    if (args.length === 6) {
      if (job.status !== 'leased' || !job.lease) return [0, 'not_leased']
      if (job.lease.expiresAtMs > now) return [0, 'not_expired']
      if (!this.sessionLive || this.terminal) {
        this.active = Math.max(0, this.active - 1)
        this.job = null
        return [0, 'session_terminated']
      }
      if ((job.attempt ?? 0) >= Number(args[3])) {
        this.active = Math.max(0, this.active - 1)
        job.status = 'abandoned'
        delete job.lease
        return [0, 'attempts_exhausted']
      }
      job.status = 'queued'
      delete job.lease
      this.queue += 1
      return [1, JSON.stringify(job)]
    }

    return [0, 'internal_error']
  }
}

function workerContext(workerId: string): TTYWorkerAuthContext {
  return { workerId: workerId as TTYWorkerId, capability: 'execute', tokenId: `${workerId}-token-id`, authenticatedAt: new Date(0).toISOString(), expiresAt: new Date(4_000_000_000).toISOString() }
}

function manager(redis: LeaseRedisContractMock, workerId: string, now: () => number = () => 1_000): TTYExecutionLeaseManager {
  return new TTYExecutionLeaseManager(redis as unknown as Redis, workerContext(workerId), { now, token: () => `${workerId}-token` })
}

test('queued job can be claimed and exactly one of two racing workers wins', async () => {
  const redis = new LeaseRedisContractMock()
  const [first, second] = await Promise.all([manager(redis, 'worker-a').claim(executionId, sessionId), manager(redis, 'worker-b').claim(executionId, sessionId)])
  assert.equal([first, second].filter(result => result.claimed).length, 1)
  assert.equal(redis.queue, 0)
  assert.equal(redis.active, 1)
})

test('missing, already leased, wrong session, and terminated jobs fail closed', async () => {
  const missing = new LeaseRedisContractMock()
  missing.job = null
  assert.deepEqual(await manager(missing, 'worker-a').claim(executionId, sessionId), { claimed: false, reason: 'missing_job' })

  const leased = new LeaseRedisContractMock()
  assert.equal((await manager(leased, 'worker-a').claim(executionId, sessionId)).claimed, true)
  assert.deepEqual(await manager(leased, 'worker-b').claim(executionId, sessionId), { claimed: false, reason: 'not_queued' })

  const wrongSession = new LeaseRedisContractMock()
  assert.deepEqual(await manager(wrongSession, 'worker-a').claim(executionId, '00000000-0000-4000-8000-000000000099' as TTYSessionId), { claimed: false, reason: 'session_terminated' })

  const terminated = new LeaseRedisContractMock()
  terminated.terminal = true
  assert.deepEqual(await manager(terminated, 'worker-a').claim(executionId, sessionId), { claimed: false, reason: 'session_terminated' })
})

test('only the matching worker and lease token can renew or release', async () => {
  const redis = new LeaseRedisContractMock()
  const claimed = await manager(redis, 'worker-a').claim(executionId, sessionId)
  assert.equal(claimed.claimed, true)
  if (!claimed.claimed) return
  const wrongWorker = await manager(redis, 'worker-b').renew(executionId, sessionId, claimed.job.lease.token)
  assert.deepEqual(wrongWorker, { renewed: false, reason: 'not_owner' })
  const wrongToken = await manager(redis, 'worker-a').release(executionId, sessionId, 'wrong-token')
  assert.deepEqual(wrongToken, { released: false, reason: 'not_owner' })
  const released = await manager(redis, 'worker-a').release(executionId, sessionId, claimed.job.lease.token)
  assert.equal(released.released, true)
  assert.equal(redis.queue, 1)
  assert.equal(redis.active, 1)
})

test('renewal is bounded, expiry recovery requeues once, and retry ceiling releases concurrency', async () => {
  let now = 1_000
  const redis = new LeaseRedisContractMock()
  const worker = manager(redis, 'worker-a', () => now)
  const claimed = await worker.claim(executionId, sessionId)
  assert.equal(claimed.claimed, true)
  if (!claimed.claimed) return
  now += TTY_LEASE_DURATION_MS - 1
  const renewed = await worker.renew(executionId, sessionId, claimed.job.lease.token)
  assert.equal(renewed.renewed, true)
  if (renewed.renewed) assert.equal(renewed.job.lease.expiresAtMs <= 301_000, true)

  now = 400_000
  assert.deepEqual(await worker.renew(executionId, sessionId, claimed.job.lease.token), { renewed: false, reason: 'lease_expired' })
  const recovered = await worker.recover(executionId, sessionId)
  assert.equal(recovered.recovered, true)
  if (recovered.recovered) assert.equal(recovered.job.attempt, 1)
  assert.equal(redis.queue, 1)
  assert.equal(redis.active, 1)
  const reclaimed = await manager(redis, 'worker-b', () => now).claim(executionId, sessionId)
  assert.equal(reclaimed.claimed, true)
  if (reclaimed.claimed) assert.equal(reclaimed.job.attempt, 2)
  assert.deepEqual(await manager(redis, 'worker-c', () => now).recover(executionId, sessionId), { recovered: false, reason: 'not_expired' })

  redis.job = { ...redis.job as MockJob, status: 'leased', attempt: TTY_MAX_LEASE_ATTEMPTS, lease: { workerId: 'worker-a', token: 'worker-a-token', claimedAtMs: 1, expiresAtMs: 2, maxExpiresAtMs: 3 } }
  const exhausted = await worker.recover(executionId, sessionId)
  assert.deepEqual(exhausted, { recovered: false, reason: 'attempts_exhausted' })
  assert.equal(redis.active, 0)
})

test('termination blocks renewal and recovery cannot resurrect terminated work', async () => {
  const redis = new LeaseRedisContractMock()
  const claimed = await manager(redis, 'worker-a').claim(executionId, sessionId)
  assert.equal(claimed.claimed, true)
  if (!claimed.claimed) return
  redis.terminal = true
  assert.deepEqual(await manager(redis, 'worker-a').renew(executionId, sessionId, claimed.job.lease.token), { renewed: false, reason: 'session_terminated' })
  const recovery = await manager(redis, 'worker-a', () => 100_000).recover(executionId, sessionId)
  assert.deepEqual(recovery, { recovered: false, reason: 'session_terminated' })
  assert.equal(redis.job, null)
  assert.equal(redis.active, 0)
})

test('matching worker can complete a lease atomically and completion removes active ownership', async () => {
  const redis = new LeaseRedisContractMock()
  const worker = manager(redis, 'worker-a')
  const claimed = await worker.claim(executionId, sessionId)
  assert.equal(claimed.claimed, true)
  if (!claimed.claimed) return
  const completed = await worker.complete(executionId, sessionId, claimed.job.lease.token, 'succeeded')
  assert.equal(completed.completed, true)
  assert.equal(redis.active, 0)
  const replay = await worker.complete(executionId, sessionId, claimed.job.lease.token, 'succeeded')
  assert.deepEqual(replay, { completed: false, reason: 'missing_job' })
})
