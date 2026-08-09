import test from 'node:test'
import assert from 'node:assert/strict'

import { createQueuedTTYExecutionState, recoverTTYExecutionState, transitionTTYExecutionState, type TTYExecutionStateRecord } from '../../lib/tty/tty-execution-state'
import { TTYRecoveryManager, type TTYRecoveryReconcileResult } from '../../lib/tty/tty-recovery'
import { TTYWorkerRecoveryService, type TTYWorkerRecoveryLogger } from '../../lib/tty/tty-worker-recovery'
import { ttyExecutionActiveIndexKey, ttyExecutionRuntimeKey, ttyExecutionStateKey, ttyWorkerActiveLeaseIndexKey } from '../../lib/tty/tty-worker-keys'
import { createTTYLeaseId, createTTYWorkerId, type TTYWorkerId } from '../../lib/tty/tty-worker-types'
import type { TTYExecutionId, TTYSessionId } from '../../lib/tty/tty-types'
import type { TTYLeaseObservation } from '../../lib/tty/tty-worker-observer'
import { WorkerRedisMock } from './worker-redis-mock'

const oldWorkerId = createTTYWorkerId('old-worker')
const executionId = '00000000-0000-4000-8000-000000000701' as TTYExecutionId
const secondExecutionId = '00000000-0000-4000-8000-000000000702' as TTYExecutionId
const sessionId = '00000000-0000-4000-8000-000000000703' as TTYSessionId
const nowMs = Date.parse('2026-08-09T10:00:00.000Z')

class ManualTimer {
  callback: (() => void) | null = null
  delayMs: number | null = null
  cleared = false
  private readonly handle = {}

  setTimeout(callback: () => void, delayMs: number): unknown {
    this.callback = callback
    this.delayMs = delayMs
    this.cleared = false
    return this.handle
  }

  clearTimeout(handle: unknown): void {
    if (handle === this.handle) this.cleared = true
  }

  async tick(): Promise<void> {
    this.callback?.()
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

class CaptureLogger implements TTYWorkerRecoveryLogger {
  readonly entries: Array<{ readonly level: string; readonly event: string; readonly fields: Readonly<Record<string, unknown>> | undefined }> = []

  info(event: string, fields?: Readonly<Record<string, unknown>>): void { this.entries.push({ level: 'info', event, fields }) }
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void { this.entries.push({ level: 'warn', event, fields }) }
  error(event: string, fields?: Readonly<Record<string, unknown>>): void { this.entries.push({ level: 'error', event, fields }) }
}

function leasedState(id: TTYExecutionId = executionId, owner: TTYWorkerId = oldWorkerId): TTYExecutionStateRecord {
  const queued = createQueuedTTYExecutionState(id, sessionId, '2026-08-09T09:59:00.000Z')
  return transitionTTYExecutionState(queued, 'leased', '2026-08-09T09:59:01.000Z', { workerId: owner, leaseId: createTTYLeaseId('safe-lease-id') })
}

function staleObservation(id: TTYExecutionId = executionId): TTYLeaseObservation {
  return {
    executionId: id,
    sessionId,
    workerId: oldWorkerId,
    leaseId: createTTYLeaseId('safe-lease-id'),
    claimedAt: '2026-08-09T09:59:01.000Z',
    renewedAt: '2026-08-09T09:59:01.000Z',
    leaseAgeMs: 59_000,
    executionState: 'leased',
    expiresAt: '2026-08-09T09:59:30.000Z'
  }
}

function emptyReconcile(): TTYRecoveryReconcileResult {
  return { scanned: 0, cleaned: 0, recovered: 0, failed: 0 }
}

function createService(options: {
  readonly redis?: WorkerRedisMock
  readonly state?: TTYExecutionStateRecord | null
  readonly observation?: TTYLeaseObservation | null
  readonly recoverState?: TTYExecutionStateRecord | null
  readonly reconcile?: (recover: (id: TTYExecutionId, session: TTYSessionId) => Promise<TTYExecutionStateRecord | null>) => Promise<TTYRecoveryReconcileResult>
  readonly timer?: ManualTimer
  readonly logger?: CaptureLogger
  readonly now?: () => number
} = {}) {
  const redis = options.redis ?? new WorkerRedisMock()
  const timer = options.timer ?? new ManualTimer()
  const logger = options.logger ?? new CaptureLogger()
  const coordinatorCalls: TTYExecutionId[] = []
  const service = new TTYWorkerRecoveryService({
    redis,
    orphanRecovery: {
      reconcile: async recover => {
        return options.reconcile?.(recover) ?? emptyReconcile()
      }
    },
    coordinator: {
      getState: async () => options.state ?? leasedState(),
      recoverExecution: async id => {
        coordinatorCalls.push(id)
        return options.recoverState ?? recoverTTYExecutionState(leasedState(id), '2026-08-09T10:00:00.010Z', { workerId: null, leaseId: null, completionReason: 'worker_crash_recovered' })
      }
    },
    observer: { getLeaseObservation: async () => options.observation ?? null },
    intervalMs: 1_000,
    now: options.now ?? (() => nowMs),
    setTimeout: (callback, delayMs) => timer.setTimeout(callback, delayMs),
    clearTimeout: handle => timer.clearTimeout(handle),
    logger
  })
  return { service, redis, timer, logger, coordinatorCalls }
}

test('restart recovery reconciles orphan processes before scheduling the next scan', async () => {
  const redis = new WorkerRedisMock()
  const running = transitionTTYExecutionState(leasedState(), 'starting', '2026-08-09T09:59:02.000Z')
  await redis.set(ttyExecutionStateKey(executionId), JSON.stringify(running))
  await redis.sadd(ttyExecutionActiveIndexKey(), executionId)
  await redis.set(ttyExecutionRuntimeKey(executionId), JSON.stringify({ pid: 12_345, cwd: 'C:/runtime/orphan' }))
  const cleaned: Array<{ readonly pid: number; readonly cwd: string }> = []
  const orphanRecovery = new TTYRecoveryManager(redis as never, { cleanupOrphan: async orphan => { cleaned.push(orphan); return true } })
  const timer = new ManualTimer()
  const service = new TTYWorkerRecoveryService({
    redis,
    orphanRecovery,
    coordinator: {
      getState: async () => running,
      recoverExecution: async () => recoverTTYExecutionState(running, '2026-08-09T10:00:00.010Z', { workerId: null, leaseId: null, completionReason: 'worker_crash_recovered' })
    },
    observer: { getLeaseObservation: async () => null },
    intervalMs: 1_000,
    now: () => nowMs,
    setTimeout: (callback, delayMs) => timer.setTimeout(callback, delayMs),
    clearTimeout: handle => timer.clearTimeout(handle)
  })

  const status = await service.start()
  assert.equal(status.state, 'running')
  assert.deepEqual(status.metrics, {
    recoveryRuns: 1,
    orphanCandidatesScanned: 1,
    orphanProcessesCleaned: 1,
    executionsRecovered: 1,
    recoveryFailures: 0,
    leaseIndexMembersScanned: 0,
    expiredLeasesObserved: 0,
    expiredLeasesRecovered: 0,
    expiredLeasesFinalized: 0,
    expiredLeaseFailures: 0,
    expiredLeasesDeferred: 0,
    malformedLeaseIndexMembers: 0,
    lastRunAt: '2026-08-09T10:00:00.000Z',
    lastRunDurationMs: 0,
    lastError: null
  })
  assert.deepEqual(cleaned, [{ pid: 12_345, cwd: 'C:/runtime/orphan' }])
  assert.equal(timer.delayMs, 1_000)
  await service.stop()
  assert.equal(timer.cleared, true)
})

test('expired leased work is recovered atomically and only once', async () => {
  const redis = new WorkerRedisMock()
  await redis.sadd(ttyWorkerActiveLeaseIndexKey(), `${oldWorkerId}|${executionId}`, `${oldWorkerId}|${executionId}`)
  const harness = createService({ redis, state: leasedState(), observation: staleObservation() })
  const result = await harness.service.recoverNow()

  assert.equal(result.expiredLeasesObserved, 1)
  assert.equal(result.expiredLeasesRecovered, 1)
  assert.equal(result.failures, 0)
  assert.deepEqual(harness.coordinatorCalls, [executionId])
  assert.equal(harness.service.getStatus().metrics.expiredLeasesRecovered, 1)
})

test('active execution recovery is deferred when the runtime ownership state is not safely leased', async () => {
  const redis = new WorkerRedisMock()
  await redis.sadd(ttyWorkerActiveLeaseIndexKey(), `${oldWorkerId}|${executionId}`)
  const running = transitionTTYExecutionState(leasedState(), 'starting', '2026-08-09T09:59:02.000Z')
  const harness = createService({ redis, state: running, observation: staleObservation() })
  const result = await harness.service.recoverNow()

  assert.equal(result.expiredLeasesObserved, 1)
  assert.equal(result.expiredLeasesDeferred, 1)
  assert.deepEqual(harness.coordinatorCalls, [])
})

test('malformed lease attribution is ignored without exposing or mutating lease secrets', async () => {
  const redis = new WorkerRedisMock()
  await redis.sadd(ttyWorkerActiveLeaseIndexKey(), 'invalid|member|with-extra-part')
  const logger = new CaptureLogger()
  const harness = createService({ redis, logger, observation: { ...staleObservation(), leaseId: createTTYLeaseId('never-a-secret-token') } })
  const result = await harness.service.recoverNow()

  assert.equal(result.malformedLeaseIndexMembers, 1)
  assert.equal(harness.coordinatorCalls.length, 0)
  assert.equal(JSON.stringify(logger.entries).includes('never-a-secret-token'), false)
})

test('concurrent recovery calls share one scan and transient failures remain retryable', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const harness = createService({ reconcile: async () => {
    calls += 1
    await gate
    return emptyReconcile()
  } })
  const first = harness.service.recoverNow()
  const second = harness.service.recoverNow()
  release()
  await Promise.all([first, second])

  assert.equal(calls, 1)
  assert.equal(harness.service.getStatus().metrics.recoveryRuns, 1)

  let fail = true
  const retryHarness = createService({ reconcile: async () => {
    if (fail) {
      fail = false
      throw new Error('temporary failure')
    }
    return emptyReconcile()
  } })
  const failed = await retryHarness.service.recoverNow()
  const recovered = await retryHarness.service.recoverNow()
  assert.equal(failed.failures, 1)
  assert.equal(recovered.failures, 0)
  assert.equal(retryHarness.service.getStatus().metrics.recoveryRuns, 2)
})

test('start and stop are idempotent and wait for an in-flight recovery', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const timer = new ManualTimer()
  const harness = createService({ timer, reconcile: async () => { await gate; return emptyReconcile() } })
  const starting = harness.service.start()
  const startingAgain = harness.service.start()
  const stopping = harness.service.stop()
  release()

  const statuses = await Promise.all([starting, startingAgain, stopping])
  assert.equal(statuses[0]?.state, 'stopped')
  assert.equal(statuses[1]?.state, 'stopped')
  assert.equal(statuses[2]?.state, 'stopped')
  assert.equal(timer.cleared, false)
  assert.equal(harness.service.getStatus().running, false)
})

test('stress scan is deterministic for one hundred lease index members', async () => {
  const redis = new WorkerRedisMock()
  const ids = Array.from({ length: 100 }, (_, index) => `00000000-0000-4000-8000-${String(index + 800).padStart(12, '0')}` as TTYExecutionId)
  await redis.sadd(ttyWorkerActiveLeaseIndexKey(), ...ids.map(id => `${oldWorkerId}|${id}`))
  const recovered: TTYExecutionId[] = []
  const logger = new CaptureLogger()
  const service = new TTYWorkerRecoveryService({
    redis,
    orphanRecovery: { reconcile: async () => emptyReconcile() },
    coordinator: {
      getState: async id => leasedState(id),
      recoverExecution: async id => {
        recovered.push(id)
        return recoverTTYExecutionState(leasedState(id), '2026-08-09T10:00:00.010Z', { workerId: null, leaseId: null, completionReason: 'worker_crash_recovered' })
      }
    },
    observer: { getLeaseObservation: async id => staleObservation(id) },
    now: () => nowMs,
    logger
  })
  const result = await service.recoverNow()

  assert.equal(result.leaseIndexMembersScanned, 100)
  assert.equal(result.expiredLeasesRecovered, 100)
  assert.deepEqual(recovered, [...ids].sort())
})
