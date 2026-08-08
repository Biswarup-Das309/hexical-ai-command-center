import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TTYWorkerClaimService,
  type TTYWorkerClaimLogger,
  type TTYWorkerOwnership
} from '../../lib/tty/tty-worker-claim'
import type {
  TTYLeaseClaimResult,
  TTYLeaseReleaseResult,
  TTYLeaseRecoveryResult,
  TTYLeasedJob,
  TTYRecoverableJob
} from '../../lib/tty/tty-execution-lease'
import { TTYWorkerPoller, type PendingExecutionQueue } from '../../lib/tty/tty-worker-poller'
import type { TTYLeaseObservation } from '../../lib/tty/tty-worker-observer'
import type { TTYExecutionId, TTYSessionId } from '../../lib/tty/tty-types'
import { createTTYWorkerId, type TTYLeaseId, type TTYWorkerId } from '../../lib/tty/tty-worker-types'

const executionId = '00000000-0000-4000-8000-000000000301' as TTYExecutionId
const sessionId = '00000000-0000-4000-8000-000000000302' as TTYSessionId

interface SharedLeaseState {
  status: 'queued' | 'leased'
  attempt: number
  lease: {
    workerId: TTYWorkerId
    token: string
    leaseId: TTYLeaseId
    claimedAtMs: number
    renewedAtMs: number
    expiresAtMs: number
    maxExpiresAtMs: number
  } | null
}

class AtomicLeaseStore {
  readonly state: SharedLeaseState = { status: 'queued', attempt: 0, lease: null }
  nowMs = 1_000

  async claim(workerId: TTYWorkerId): Promise<TTYLeaseClaimResult> {
    await Promise.resolve()
    if (this.state.status !== 'queued') return { claimed: false, reason: 'not_queued' }
    this.state.attempt += 1
    const token = `${workerId}-secret-token-${this.state.attempt}`
    const leaseId = `${workerId}-opaque-lease-${this.state.attempt}` as TTYLeaseId
    this.state.status = 'leased'
    this.state.lease = {
      workerId,
      token,
      leaseId,
      claimedAtMs: this.nowMs,
      renewedAtMs: this.nowMs,
      expiresAtMs: this.nowMs + 30_000,
      maxExpiresAtMs: this.nowMs + 300_000
    }
    return { claimed: true, job: this.leasedJob() }
  }

  async recover(): Promise<TTYLeaseRecoveryResult> {
    if (this.state.status !== 'leased' || this.state.lease === null) return { recovered: false, reason: 'not_leased' }
    if (this.state.lease.expiresAtMs > this.nowMs) return { recovered: false, reason: 'not_expired' }
    this.state.status = 'queued'
    this.state.lease = null
    return { recovered: true, job: this.recoverableJob() }
  }

  async release(workerId: TTYWorkerId, token: string): Promise<TTYLeaseReleaseResult> {
    if (this.state.status !== 'leased' || this.state.lease === null) return { released: false, reason: 'not_owner' }
    if (this.state.lease.workerId !== workerId || this.state.lease.token !== token) return { released: false, reason: 'not_owner' }
    if (this.state.lease.expiresAtMs <= this.nowMs) return { released: false, reason: 'lease_expired' }
    this.state.status = 'queued'
    this.state.lease = null
    return { released: true, job: this.recoverableJob() }
  }

  observation(): TTYLeaseObservation | null {
    if (this.state.status !== 'leased' || this.state.lease === null) return null
    const lease = this.state.lease
    return {
      executionId,
      sessionId,
      workerId: lease.workerId,
      leaseId: lease.leaseId,
      claimedAt: new Date(lease.claimedAtMs).toISOString(),
      renewedAt: new Date(lease.renewedAtMs).toISOString(),
      leaseAgeMs: Math.max(0, this.nowMs - lease.claimedAtMs),
      executionState: 'leased',
      expiresAt: new Date(lease.expiresAtMs).toISOString()
    }
  }

  private leasedJob(): TTYLeasedJob {
    if (this.state.lease === null) throw new Error('Expected a lease.')
    return {
      executionId,
      sessionId,
      ownerUserId: 'test-user',
      kind: 'diagnostic',
      status: 'leased',
      createdAt: new Date(0).toISOString(),
      admittedAt: new Date(0).toISOString(),
      authorizationScopeId: null,
      resource: { maxExecutionDurationMs: 30_000, maxOutputBytes: 1_024 },
      attempt: this.state.attempt,
      lease: this.state.lease
    }
  }

  private recoverableJob(): TTYRecoverableJob {
    return {
      executionId,
      sessionId,
      ownerUserId: 'test-user',
      kind: 'diagnostic',
      status: 'queued',
      createdAt: new Date(0).toISOString(),
      admittedAt: new Date(0).toISOString(),
      authorizationScopeId: null,
      resource: { maxExecutionDurationMs: 30_000, maxOutputBytes: 1_024 },
      attempt: this.state.attempt
    }
  }
}

class FakeLeaseManager {
  constructor(private readonly store: AtomicLeaseStore, private readonly workerId: TTYWorkerId) {}

  claim(_executionId: TTYExecutionId, _sessionId: TTYSessionId): Promise<TTYLeaseClaimResult> {
    return this.store.claim(this.workerId)
  }

  recover(_executionId: TTYExecutionId, _sessionId: TTYSessionId): Promise<TTYLeaseRecoveryResult> {
    return this.store.recover()
  }

  release(_executionId: TTYExecutionId, _sessionId: TTYSessionId, token: string): Promise<TTYLeaseReleaseResult> {
    return this.store.release(this.workerId, token)
  }
}

class CaptureLogger implements TTYWorkerClaimLogger {
  readonly entries: Array<{ readonly level: string; readonly message: string; readonly fields: Readonly<Record<string, unknown>> | undefined }> = []

  info(message: string, fields?: Readonly<Record<string, unknown>>): void { this.entries.push({ level: 'info', message, fields }) }
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void { this.entries.push({ level: 'warn', message, fields }) }
  error(message: string, fields?: Readonly<Record<string, unknown>>): void { this.entries.push({ level: 'error', message, fields }) }
}

function service(store: AtomicLeaseStore, workerName: string, logger = new CaptureLogger()): { readonly claim: TTYWorkerClaimService; readonly logger: CaptureLogger } {
  const workerId = createTTYWorkerId(workerName)
  return {
    logger,
    claim: new TTYWorkerClaimService({
      workerId,
      leaseManager: new FakeLeaseManager(store, workerId),
      observer: { getLeaseObservation: async () => store.observation() },
      resolveSessionId: async () => sessionId,
      now: () => store.nowMs,
      logger
    })
  }
}

test('successfully claims a queued execution and returns browser-safe ownership metadata', async () => {
  const store = new AtomicLeaseStore()
  const harness = service(store, 'claim-worker-a')
  const result = await harness.claim.claimPendingExecutionIds([executionId])

  assert.equal(result.length, 1)
  const ownership = result[0]!
  assert.equal(ownership.executionId, executionId)
  assert.equal(ownership.workerId, createTTYWorkerId('claim-worker-a'))
  assert.equal(ownership.leaseId, 'claim-worker-a-opaque-lease-1')
  assert.equal(Object.hasOwn(ownership, 'token'), false)
  assert.equal(harness.claim.getStatus().claimSuccesses, 1)
  assert.ok(harness.logger.entries.some(entry => entry.message === 'lease_claimed'))
})

test('duplicate claim becomes a conflict and leaves exactly one active ownership', async () => {
  const store = new AtomicLeaseStore()
  const first = service(store, 'claim-worker-a')
  const second = service(store, 'claim-worker-b')
  assert.equal((await first.claim.claimExecution(executionId)).claimed, true)

  const conflict = await second.claim.claimExecution(executionId)
  assert.deepEqual(conflict, { claimed: false, reason: 'not_queued' })
  assert.equal(first.claim.getStatus().activeOwnerships.length, 1)
  assert.equal(second.claim.getStatus().claimConflicts, 1)
  assert.ok(second.logger.entries.some(entry => entry.message === 'lease_conflict'))
})

test('concurrent simulated workers produce one successful claim and no duplicate ownership', async () => {
  const store = new AtomicLeaseStore()
  const workers = Array.from({ length: 32 }, (_, index) => service(store, `race-worker-${index}`))
  const results = await Promise.all(workers.map(worker => worker.claim.claimExecution(executionId)))

  assert.equal(results.filter(result => result.claimed).length, 1)
  assert.equal(results.filter(result => !result.claimed).length, 31)
  assert.equal(store.state.status, 'leased')
  assert.ok(store.state.lease)
})

test('detects and recovers an expired lease without retrying in the same claim attempt', async () => {
  const store = new AtomicLeaseStore()
  const owner = service(store, 'expiry-worker-a')
  const contender = service(store, 'expiry-worker-b')
  assert.equal((await owner.claim.claimExecution(executionId)).claimed, true)

  store.nowMs = 40_000
  const expired = await contender.claim.claimExecution(executionId)
  assert.deepEqual(expired, { claimed: false, reason: 'lease_expired' })
  assert.equal(contender.claim.getStatus().leaseExpirationsObserved, 1)
  assert.equal(store.state.status, 'queued')
  assert.ok(contender.logger.entries.some(entry => entry.message === 'stale_lease_observed'))
})

test('retries successfully on the next claim after expiration recovery', async () => {
  const store = new AtomicLeaseStore()
  const owner = service(store, 'retry-worker-a')
  const contender = service(store, 'retry-worker-b')
  assert.equal((await owner.claim.claimExecution(executionId)).claimed, true)
  store.nowMs = 40_000

  assert.equal((await contender.claim.claimExecution(executionId)).claimed, false)
  const retried = await contender.claim.claimExecution(executionId)
  assert.equal(retried.claimed, true)
  assert.equal(contender.claim.getStatus().claimAttempts, 2)
  assert.equal(contender.claim.getStatus().claimSuccesses, 1)
  assert.equal(store.state.lease?.workerId, createTTYWorkerId('retry-worker-b'))
})

test('release removes private ownership while logging no lease secret', async () => {
  const store = new AtomicLeaseStore()
  const harness = service(store, 'release-worker')
  const result = await harness.claim.claimExecution(executionId)
  assert.equal(result.claimed, true)
  if (!result.claimed) return

  assert.deepEqual(await harness.claim.releaseOwnership(result.ownership), { released: true })
  assert.equal(harness.claim.getStatus().activeOwnerships.length, 0)
  assert.equal(store.state.status, 'queued')
  const releaseLog = harness.logger.entries.find(entry => entry.message === 'lease_released')
  assert.ok(releaseLog)
  assert.equal(JSON.stringify(releaseLog?.fields).includes('secret-token'), false)
})

test('poller discovery callback claims IDs without executing jobs', async () => {
  const store = new AtomicLeaseStore()
  const harness = service(store, 'poller-claim-worker')
  const queue: PendingExecutionQueue = { listPendingExecutionIds: async () => [executionId] }
  let timer: (() => void) | null = null
  const poller = new TTYWorkerPoller({
    queue,
    jitterMs: 0,
    setTimeout: callback => { timer = callback; return 1 },
    clearTimeout: () => { timer = null },
    onPendingExecutionIds: ids => harness.claim.claimPendingExecutionIds(ids),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined }
  })

  await poller.startPolling()
  assert.equal(harness.claim.getStatus().claimSuccesses, 1)
  assert.equal(store.state.status, 'leased')
  assert.equal(timer !== null, true)
  await poller.stopPolling()
})
