import test from 'node:test'
import assert from 'node:assert/strict'

import type { Redis } from '@upstash/redis'

import { TTYExecutionLeaseManager } from '../../lib/tty/tty-execution-lease'
import { TTYWorkerAudit } from '../../lib/tty/tty-worker-audit'
import { TTYWorkerAuthenticator, issueTTYWorkerToken } from '../../lib/tty/tty-worker-auth'
import { TTYWorkerHeartbeatService } from '../../lib/tty/tty-worker-heartbeat'
import { TTYWorkerLeaseObserver } from '../../lib/tty/tty-worker-observer'
import { TTYWorkerRegistry } from '../../lib/tty/tty-worker-registry'
import { createTTYWorkerId } from '../../lib/tty/tty-worker-types'
import { WorkerRedisMock } from './worker-redis-mock'

const sessionId = '00000000-0000-4000-8000-000000000041'
const executionId = '00000000-0000-4000-8000-000000000042'
const workerId = createTTYWorkerId('integration-worker')
const secret = 'integration-worker-plane-secret-0123456789'

class WorkerLeaseRedisMock extends WorkerRedisMock {
  override async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    const raw = this.values.get(keys[0])
    if (script.includes('tty-lease-claim')) {
      if (!raw) return [0, 'missing_job']
      const job = JSON.parse(raw) as Record<string, unknown>
      if (job.status !== 'queued') return [0, 'not_queued']
      const now = Number(args[2])
      const attempt = Number(job.attempt ?? 0) + 1
      if (attempt > Number(args[3])) return [0, 'attempts_exhausted']
      if (this.values.has(keys[3]) || !this.values.has(keys[1]) || !this.values.has(keys[2])) return [0, 'session_terminated']
      job.status = 'leased'
      job.attempt = attempt
      job.lease = { workerId: args[0], token: args[1], leaseId: args[1], claimedAtMs: now, renewedAtMs: now, expiresAtMs: now + Number(args[4]), maxExpiresAtMs: now + Number(args[5]) }
      this.values.set(keys[0], JSON.stringify(job))
      this.values.set(keys[4], String(Math.max(0, Number(this.values.get(keys[4]) ?? '0') - 1)))
      await this.sadd(keys[5], executionId)
      await this.sadd(keys[6], `${args[0]}|${executionId}`)
      return [1, JSON.stringify(job)]
    }
    if (script.includes('tty-lease-renew')) {
      if (!raw) return [0, 'missing_job']
      const job = JSON.parse(raw) as Record<string, unknown>
      const lease = job.lease as Record<string, unknown> | undefined
      if (job.status !== 'leased' || !lease || lease.workerId !== args[0] || lease.token !== args[1]) return [0, 'not_owner']
      const now = Number(args[2])
      if (Number(lease.expiresAtMs) <= now || Number(lease.maxExpiresAtMs) <= now) return [0, 'lease_expired']
      const nextExpiry = Math.min(now + Number(args[3]), Number(lease.maxExpiresAtMs))
      lease.expiresAtMs = nextExpiry
      lease.renewedAtMs = now
      this.values.set(keys[0], JSON.stringify(job))
      return [1, JSON.stringify(job)]
    }
    if (script.includes('tty-lease-release')) {
      if (!raw) return [0, 'missing_job']
      const job = JSON.parse(raw) as Record<string, unknown>
      const lease = job.lease as Record<string, unknown> | undefined
      if (job.status !== 'leased' || !lease || lease.workerId !== args[0] || lease.token !== args[1]) return [0, 'not_owner']
      if (Number(lease.expiresAtMs) <= Number(args[2])) return [0, 'lease_expired']
      const attempt = Number(job.attempt ?? 0)
      job.status = attempt >= Number(args[5]) ? 'abandoned' : 'queued'
      if (job.status === 'queued') job.attempt = attempt + 1
      delete job.lease
      this.values.set(keys[0], JSON.stringify(job))
      this.values.set(keys[4], String(Math.max(0, Number(this.values.get(keys[4]) ?? '0') + (job.status === 'queued' ? 1 : -1))))
      await this.srem(keys[5], args[4])
      await this.srem(keys[6], `${args[0]}|${args[4]}`)
      return job.status === 'abandoned' ? [0, 'attempts_exhausted'] : [1, JSON.stringify(job)]
    }
    if (script.includes('tty-lease-recover')) {
      if (!raw) return [0, 'missing_job']
      const job = JSON.parse(raw) as Record<string, unknown>
      const lease = job.lease as Record<string, unknown> | undefined
      if (job.status !== 'leased' || !lease) return [0, 'not_leased']
      if (Number(lease.expiresAtMs) > Number(args[2])) return [0, 'not_expired']
      const oldOwner = String(lease.workerId)
      const oldToken = String(lease.token)
      await this.srem(keys[7], `${oldOwner}|${executionId}`)
      job.status = Number(job.attempt ?? 0) >= Number(args[3]) ? 'abandoned' : 'queued'
      delete job.lease
      this.values.set(keys[0], JSON.stringify(job))
      if (job.status === 'queued') this.values.set(keys[4], String(Number(this.values.get(keys[4]) ?? '0') + 1))
      return job.status === 'abandoned' ? [0, 'attempts_exhausted', `${oldOwner}|${executionId}|${oldToken}`] : [1, JSON.stringify(job), `${oldOwner}|${executionId}|${oldToken}`]
    }
    return super.eval(script, keys, args)
  }
}

test('register, authenticate, heartbeat, claim, renew, release, offline, and recover complete without orphaned attribution', async () => {
  const redis = new WorkerLeaseRedisMock()
  const redisAsType = redis as unknown as Redis
  let nowMs = 1_700_000_000_000
  const audit = new TTYWorkerAudit(redisAsType)
  const registry = new TTYWorkerRegistry(redisAsType, { dependencies: { now: () => new Date(nowMs) }, audit })
  const registered = await registry.registerWorker({ workerId, identity: 'integration-host', version: '1.0.0', capabilities: ['claim_lease', 'renew_lease', 'execute'] })
  assert.equal(registered.registered, true)
  const authenticator = new TTYWorkerAuthenticator(registry, secret, { now: () => new Date(nowMs), audit })
  const token = issueTTYWorkerToken(workerId, 'execute', secret, { now: () => nowMs, ttlMs: 60 * 60 * 1000 })
  const authenticated = await authenticator.authenticateWorker(token, 'claim_lease')
  assert.equal(authenticated.authenticated, true)
  if (!authenticated.authenticated) return
  const heartbeat = new TTYWorkerHeartbeatService(redisAsType, registry, { now: () => new Date(nowMs), audit })
  assert.equal((await heartbeat.recordHeartbeat({ workerId, sequence: 1, sentAt: new Date(nowMs).toISOString() })).recorded, true)

  redis.values.set(`tty:session:${sessionId}:core`, '{}')
  redis.values.set(`tty:session:${sessionId}:status`, '{}')
  redis.values.set(`tty:session:${sessionId}:queue-depth`, '1')
  redis.values.set(`tty:session:${sessionId}:active-executions`, '1')
  await redis.sadd(`tty:session:${sessionId}:jobs`, executionId)
  const job = { executionId, sessionId, ownerUserId: 'user-1', kind: 'session_utility', status: 'queued', createdAt: new Date(nowMs).toISOString(), admittedAt: new Date(nowMs).toISOString(), authorizationScopeId: null, resource: { maxExecutionDurationMs: 30_000, maxOutputBytes: 1_024 }, attempt: 0 }
  redis.values.set(`tty:job:${executionId}`, JSON.stringify(job))

  const observer = new TTYWorkerLeaseObserver(redisAsType, { audit })
  const leases = new TTYExecutionLeaseManager(redisAsType, authenticated.context, { now: () => nowMs, token: () => 'integration-lease', observer })
  const claimed = await leases.claim(executionId as never, sessionId as never)
  assert.equal(claimed.claimed, true)
  if (!claimed.claimed) return
  nowMs += 1_000
  const renewed = await leases.renew(executionId as never, sessionId as never, claimed.job.lease.token)
  assert.equal(renewed.renewed, true)
  const observed = await observer.getLeaseObservation(executionId as never)
  assert.equal(observed?.workerId, workerId)
  const released = await leases.release(executionId as never, sessionId as never, claimed.job.lease.token)
  assert.equal(released.released, true)

  const resetForRecovery = JSON.parse(redis.values.get(`tty:job:${executionId}`) ?? '{}') as Record<string, unknown>
  resetForRecovery.attempt = 0
  redis.values.set(`tty:job:${executionId}`, JSON.stringify(resetForRecovery))
  const reclaimed = await leases.claim(executionId as never, sessionId as never)
  assert.equal(reclaimed.claimed, true)
  nowMs += 31_000
  assert.equal((await heartbeat.markWorkerOffline(workerId, new Date(nowMs))).offline, true)
  assert.equal((await authenticator.authenticateWorker(token)).authenticated, false)
  const recovered = await leases.recover(executionId as never, sessionId as never)
  assert.equal(recovered.recovered, true)
  assert.equal((await observer.listWorkerLeases(workerId)).length, 0)
  const events = await audit.replay()
  assert.equal(events.some(event => event.eventType === 'lease_claimed'), true)
  assert.equal(events.some(event => event.eventType === 'lease_renewed'), true)
  assert.equal(events.some(event => event.eventType === 'lease_released'), true)
  assert.equal(events.some(event => event.eventType === 'lease_expired'), true)
  assert.equal(events.some(event => event.eventType === 'worker_offline'), true)
})
