import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import test from 'node:test'
import { WorkerRedisMock } from './worker-redis-mock'
import {
  TTYExecutionCoordinator,
  type TTYExecutionCoordinatorRunHooks,
  type TTYExecutionRunResult,
} from '../../lib/tty/tty-execution-coordinator'
import type {
  TTYLeasedJob,
  TTYLeaseClaimResult,
  TTYLeaseCompleteResult,
  TTYLeaseReleaseResult,
  TTYLeaseRenewResult,
} from '../../lib/tty/tty-execution-lease'
import {
  createQueuedTTYExecutionState,
  transitionTTYExecutionState,
  type TTYExecutionStateRecord,
} from '../../lib/tty/tty-execution-state'
import { TTYOutputStreamManager } from '../../lib/tty/tty-output-stream'
import { TTYProcessRuntime } from '../../lib/tty/tty-process-runtime'
import { TTYResourceGuard } from '../../lib/tty/tty-resource-guard'
import { TTYStreamBroker } from '../../lib/tty/tty-stream-broker'
import { TTYStreamingOutputStreamManager } from '../../lib/tty/tty-stream-runtime-bridge'
import type { TTYExecutionId, TTYSessionId, InternalTTYSession } from '../../lib/tty/tty-types'
import {
  TTYWorkerClaimService,
  type TTYWorkerClaimLogger,
  type TTYWorkerCoordinatorClaimResult,
  type TTYWorkerOwnership,
} from '../../lib/tty/tty-worker-claim'
import {
  TTYWorkerExecutor,
  type TTYWorkerExecutorDependencies,
  type TTYWorkerExecutorLogger,
} from '../../lib/tty/tty-worker-executor'
import type { TTYLeaseObservation } from '../../lib/tty/tty-worker-observer'
import { TTYWorkerPoller } from '../../lib/tty/tty-worker-poller'
import { createTTYLeaseId, createTTYWorkerId, type TTYLeaseId, type TTYWorkerId } from '../../lib/tty/tty-worker-types'

const workerId = createTTYWorkerId('executor-test-worker')
const sessionId = '00000000-0000-4000-8000-000000000801' as TTYSessionId
const executionId = '00000000-0000-4000-8000-000000000802' as TTYExecutionId
const secondExecutionId = '00000000-0000-4000-8000-000000000803' as TTYExecutionId

const session: InternalTTYSession = {
  sessionId,
  ownerUserId: 'executor-owner',
  tier: 'pro',
  status: 'active',
  createdAt: '2026-08-09T10:00:00.000Z',
  lastActiveAt: '2026-08-09T10:00:00.000Z',
  limits: {
    maxConcurrentSessions: 1,
    maxConcurrentExecutionsPerSession: 1,
    maxExecutionsPerMinute: 20,
    maxExecutionDurationMs: 5_000,
    maxSessionIdleMs: 900_000,
    maxSessionDurationMs: 3_600_000,
    maxOutputBytesPerExecution: 64_000,
    maxQueueDepth: 10,
  },
  usage: {
    activeSessions: 1,
    activeExecutionsInSession: 0,
    executionsInLastMinute: 0,
    queueDepth: 0,
    capturedAt: '2026-08-09T10:00:00.000Z',
  },
}

class PollerStub {
  startCalls = 0
  stopCalls = 0

  async startPolling(): Promise<void> {
    this.startCalls += 1
  }
  async stopPolling(): Promise<void> {
    this.stopCalls += 1
  }
}

class CaptureLogger implements TTYWorkerExecutorLogger, TTYWorkerClaimLogger {
  readonly entries: Array<{
    readonly level: string
    readonly event: string
    readonly fields: Readonly<Record<string, unknown>> | undefined
  }> = []

  info(event: string, fields?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: 'info', event, fields })
  }
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: 'warn', event, fields })
  }
  error(event: string, fields?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: 'error', event, fields })
  }
}

function leasedJob(id: TTYExecutionId = executionId): TTYLeasedJob {
  return {
    executionId: id,
    sessionId,
    ownerUserId: session.ownerUserId,
    kind: 'diagnostic',
    status: 'leased',
    createdAt: session.createdAt,
    admittedAt: session.createdAt,
    authorizationScopeId: null,
    argv: [process.execPath, '-e', "process.stdout.write('worker-out'); process.stderr.write('worker-err')"],
    resource: {
      maxExecutionDurationMs: session.limits.maxExecutionDurationMs,
      maxOutputBytes: session.limits.maxOutputBytesPerExecution,
    },
    attempt: 1,
    lease: {
      workerId,
      token: 'executor-secret-token',
      leaseId: createTTYLeaseId('executor-safe-lease'),
      claimedAtMs: Date.parse('2026-08-09T10:00:00.000Z'),
      renewedAtMs: Date.parse('2026-08-09T10:00:00.000Z'),
      expiresAtMs: Date.parse('2026-08-09T10:01:00.000Z'),
      maxExpiresAtMs: Date.parse('2026-08-09T10:05:00.000Z'),
    },
  }
}

function ownershipFor(job: TTYLeasedJob = leasedJob()): TTYWorkerOwnership {
  return {
    executionId: job.executionId,
    sessionId: job.sessionId,
    workerId: job.lease.workerId,
    leaseId: job.lease.leaseId,
    claimedAt: new Date(job.lease.claimedAtMs).toISOString(),
    renewedAt: new Date(job.lease.renewedAtMs).toISOString(),
    expiresAt: new Date(job.lease.expiresAtMs).toISOString(),
  }
}

function terminalState(
  id: TTYExecutionId,
  state: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'expired',
): TTYExecutionStateRecord {
  const queued = createQueuedTTYExecutionState(id, sessionId, '2026-08-09T10:00:00.000Z')
  const leased = transitionTTYExecutionState(queued, 'leased', '2026-08-09T10:00:00.001Z', {
    workerId,
    leaseId: createTTYLeaseId('executor-safe-lease'),
  })
  const running = transitionTTYExecutionState(leased, 'starting', '2026-08-09T10:00:00.002Z')
  const active = transitionTTYExecutionState(running, 'running', '2026-08-09T10:00:00.003Z')
  return transitionTTYExecutionState(active, state, '2026-08-09T10:00:00.100Z', { completionReason: state })
}

function createFakeClaim(
  options: {
    readonly job?: TTYLeasedJob
    readonly jobForExecutionId?: (executionId: TTYExecutionId) => TTYLeasedJob
    readonly claimResult?: TTYWorkerCoordinatorClaimResult
    readonly logger?: CaptureLogger
  } = {},
): TTYWorkerExecutorDependencies['claim'] & {
  readonly logger: CaptureLogger
  readonly ownership: TTYWorkerOwnership
  readonly claimCalls: number
  readonly releaseCalls: number
  readonly forgetCalls: number
} {
  const job = options.job ?? leasedJob()
  const ownership = ownershipFor(job)
  const logger = options.logger ?? new CaptureLogger()
  let claimCalls = 0
  let releaseCalls = 0
  let forgetCalls = 0
  return {
    logger,
    ownership,
    get claimCalls() {
      return claimCalls
    },
    get releaseCalls() {
      return releaseCalls
    },
    get forgetCalls() {
      return forgetCalls
    },
    claimExecutionForCoordinator: async (_id: TTYExecutionId) => {
      claimCalls += 1
      if (options.claimResult) return options.claimResult
      const currentJob = options.jobForExecutionId?.(_id) ?? job
      return { claimed: true as const, ownership: ownershipFor(currentJob), job: currentJob }
    },
    releaseOwnership: async (_current: TTYWorkerOwnership): Promise<TTYLeaseReleaseResult> => {
      releaseCalls += 1
      return { released: true, job: { ...job, status: 'queued' } as never }
    },
    forgetOwnership: (_current: TTYWorkerOwnership) => {
      forgetCalls += 1
    },
  }
}

function createFakeCoordinator(
  options: {
    readonly result?: TTYExecutionRunResult
    readonly throwError?: boolean
    readonly gate?: Promise<void>
    readonly onCancel?: () => void
  } = {},
): TTYWorkerExecutorDependencies['coordinator'] & {
  readonly runCalls: number
  readonly cancelCalls: number
} {
  let runCalls = 0
  let cancelCalls = 0
  return {
    get runCalls() {
      return runCalls
    },
    get cancelCalls() {
      return cancelCalls
    },
    runClaimed: async (job: TTYLeasedJob, hooks: TTYExecutionCoordinatorRunHooks) => {
      runCalls += 1
      hooks.onLeaseRenewed?.(job.executionId, job.sessionId)
      if (options.gate) await options.gate
      if (options.throwError) throw new Error('coordinator failure')
      return options.result ?? { accepted: true as const, state: terminalState(job.executionId, 'succeeded') }
    },
    cancelExecution: async (id: TTYExecutionId) => {
      cancelCalls += 1
      options.onCancel?.()
      return { acknowledged: true, state: terminalState(id, 'cancelled') }
    },
  }
}

function createExecutor(
  options: {
    readonly claim?: ReturnType<typeof createFakeClaim>
    readonly coordinator?: ReturnType<typeof createFakeCoordinator>
    readonly poller?: PollerStub
    readonly recovery?: { recoverNow: () => Promise<unknown> }
    readonly logger?: CaptureLogger
    readonly now?: () => number
  } = {},
) {
  const claim = options.claim ?? createFakeClaim()
  const coordinator = options.coordinator ?? createFakeCoordinator()
  const poller = options.poller ?? new PollerStub()
  const logger = options.logger ?? new CaptureLogger()
  const executor = new TTYWorkerExecutor({
    workerId,
    poller,
    claim,
    coordinator,
    recovery: options.recovery,
    now: options.now ?? (() => Date.parse('2026-08-09T10:00:00.100Z')),
    logger,
  })
  return { executor, claim, coordinator, poller, logger }
}

test('executes one claimed job, records renewal metrics, and releases local ownership', async () => {
  const harness = createExecutor()
  await harness.executor.start()
  const result = await harness.executor.executeExecution(executionId)

  assert.equal(result.status, 'completed')
  assert.equal(harness.claim.claimCalls, 1)
  assert.equal(harness.claim.releaseCalls, 1)
  assert.equal(harness.claim.forgetCalls, 1)
  assert.equal(harness.coordinator.runCalls, 1)
  assert.deepEqual(harness.executor.getStatus().metrics, {
    executionsStarted: 1,
    executionsCompleted: 1,
    executionsFailed: 0,
    executionsCancelled: 0,
    averageDurationMs: 0,
    leaseRenewals: 1,
    leaseLosses: 0,
    recoveriesDuringExecution: 0,
  })
  await harness.executor.stop()
  assert.equal(harness.poller.stopCalls, 1)
})

test('poller callback drives sequential execution and prevents duplicate or parallel ownership', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const poller = new PollerStub()
  const harness = createExecutor({
    poller,
    claim: createFakeClaim({ jobForExecutionId: (id) => leasedJob(id) }),
    coordinator: createFakeCoordinator({ gate }),
  })
  await harness.executor.start()

  const first = harness.executor.executeExecution(executionId)
  const duplicate = harness.executor.executeExecution(executionId)
  const competing = await harness.executor.executeExecution(secondExecutionId)
  assert.equal(competing.status, 'skipped')
  if (competing.status === 'skipped') assert.equal(competing.reason, 'worker_busy')
  assert.equal(harness.claim.claimCalls, 1)

  release()
  assert.equal((await first).status, 'completed')
  assert.equal((await duplicate).status, 'completed')
  assert.equal((await harness.executor.executeExecution(secondExecutionId)).status, 'completed')
  assert.equal(harness.coordinator.runCalls, 2)
  assert.equal(harness.claim.claimCalls, 2)
  await harness.executor.stop()
})

test('runtime/coordinator failure releases ownership and invokes recovery without leaking secrets', async () => {
  let recoveryCalls = 0
  const logger = new CaptureLogger()
  const harness = createExecutor({
    logger,
    coordinator: createFakeCoordinator({ throwError: true }),
    recovery: {
      recoverNow: async () => {
        recoveryCalls += 1
      },
    },
  })
  await harness.executor.start()
  const result = await harness.executor.executeExecution(executionId)

  assert.equal(result.status, 'failed')
  assert.equal(recoveryCalls, 2)
  assert.equal(harness.claim.releaseCalls, 1)
  assert.equal(harness.executor.getStatus().metrics.executionsFailed, 1)
  assert.equal(harness.executor.getStatus().metrics.recoveriesDuringExecution, 1)
  assert.equal(JSON.stringify(logger.entries).includes('executor-secret-token'), false)
  await harness.executor.stop()
})

test('timeout, cancellation, and lease loss remain explicit and idempotent', async () => {
  const timeout = createExecutor({
    coordinator: createFakeCoordinator({ result: { accepted: true, state: terminalState(executionId, 'timed_out') } }),
  })
  await timeout.executor.start()
  assert.equal((await timeout.executor.executeExecution(executionId)).status, 'failed')
  await timeout.executor.stop()

  const cancelled = createExecutor({
    coordinator: createFakeCoordinator({ result: { accepted: true, state: terminalState(executionId, 'cancelled') } }),
  })
  await cancelled.executor.start()
  assert.equal((await cancelled.executor.executeExecution(executionId)).status, 'cancelled')
  await cancelled.executor.stop()

  let recoveryCalls = 0
  const leaseLoss = createExecutor({
    coordinator: {
      runCalls: 0,
      cancelCalls: 0,
      runClaimed: async (_job: TTYLeasedJob, hooks: TTYExecutionCoordinatorRunHooks) => {
        hooks.onLeaseLost?.(executionId, sessionId, 'lease_expired')
        return { accepted: true as const, state: terminalState(executionId, 'expired') }
      },
      cancelExecution: async () => ({ acknowledged: true, state: terminalState(executionId, 'cancelled') }),
    },
    recovery: {
      recoverNow: async () => {
        recoveryCalls += 1
      },
    },
  })
  await leaseLoss.executor.start()
  const expired = await leaseLoss.executor.executeExecution(executionId)
  assert.equal(expired.status, 'expired')
  assert.equal(leaseLoss.executor.getStatus().metrics.leaseLosses, 1)
  assert.equal(recoveryCalls, 2)
  await leaseLoss.executor.stop()
})

test('worker shutdown cancels the active execution and stops polling exactly once', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const coordinator = createFakeCoordinator({ gate })
  const harness = createExecutor({ coordinator })
  await harness.executor.start()
  const running = harness.executor.executeExecution(executionId)
  await new Promise<void>((resolve) => setImmediate(resolve))

  const stopping = harness.executor.stop()
  assert.equal(harness.coordinator.cancelCalls, 1)
  release()
  const status = await stopping
  await running
  assert.equal(status.state, 'stopped')
  assert.equal(harness.poller.stopCalls, 1)
})

test('restart during an active execution runs recovery before the replacement polls', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let initialRecoveryCalls = 0
  const first = createExecutor({
    coordinator: createFakeCoordinator({ gate }),
    recovery: {
      recoverNow: async () => {
        initialRecoveryCalls += 1
      },
    },
  })
  await first.executor.start()
  const running = first.executor.executeExecution(executionId)
  await new Promise<void>((resolve) => setImmediate(resolve))
  const stopping = first.executor.stop()
  assert.equal(first.coordinator.cancelCalls, 1)
  release()
  await stopping
  await running
  assert.equal(initialRecoveryCalls, 1)

  let restartRecoveryCalls = 0
  const restarted = createExecutor({
    recovery: {
      recoverNow: async () => {
        restartRecoveryCalls += 1
      },
    },
  })
  const status = await restarted.executor.start()
  assert.equal(status.state, 'running')
  assert.equal(restartRecoveryCalls, 1)
  assert.equal(restarted.poller.startCalls, 1)
  await restarted.executor.stop()
})

test('poll, claim, execute, stream, complete, and recovery compose through the real coordinator and stream bridge', async () => {
  const redis = new WorkerRedisMock()
  const rootDir = join(process.cwd(), `.tmp-tty-worker-executor-${process.pid}`)
  const runtime = new TTYProcessRuntime({ rootDir })
  const job = leasedJob()
  const leases = {
    claim: async (): Promise<TTYLeaseClaimResult> => ({ claimed: true, job }),
    renew: async (): Promise<TTYLeaseRenewResult> => ({ renewed: true, job }),
    complete: async (): Promise<TTYLeaseCompleteResult> => ({ completed: true, job }),
    recover: async () => ({ recovered: true as const, job: { ...job, status: 'queued' } as never }),
    release: async (): Promise<TTYLeaseReleaseResult> => ({
      released: true,
      job: { ...job, status: 'queued' } as never,
    }),
  }
  const claim = new TTYWorkerClaimService({
    workerId,
    leaseManager: leases,
    observer: { getLeaseObservation: async (): Promise<TTYLeaseObservation | null> => null },
    resolveSessionId: async () => sessionId,
    logger: new CaptureLogger(),
  })
  const broker = new TTYStreamBroker(redis as never)
  const outputStream = new TTYStreamingOutputStreamManager(redis as never, broker)
  const coordinator = new TTYExecutionCoordinator({
    redis: redis as never,
    workerId,
    sessionStore: {
      getSession: async () => session,
      recordExecutionStarted: async () => undefined,
      recordExecutionFinished: async () => undefined,
    },
    leaseManager: leases,
    processRuntime: runtime,
    resourceGuard: new TTYResourceGuard({
      maxConcurrentProcesses: 1,
      maxStdoutBytesPerSecond: 64_000,
      maxStderrBytesPerSecond: 64_000,
    }),
    outputStream,
    commandAllowlist: {
      diagnostic: [
        basename(process.execPath)
          .toLowerCase()
          .replace(/\.exe$/, ''),
      ],
    },
    leaseRenewIntervalMs: 100,
  })
  let executor!: TTYWorkerExecutor
  let scheduled: (() => void) | null = null
  const poller = new TTYWorkerPoller({
    queue: { listPendingExecutionIds: async () => [executionId] },
    jitterMs: 0,
    setTimeout: (callback) => {
      scheduled = callback
      return 1
    },
    clearTimeout: () => {
      scheduled = null
    },
    onPendingExecutionIds: (ids) => executor.handlePendingExecutionIds(ids),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  })
  let recoveryCalls = 0
  executor = new TTYWorkerExecutor({
    workerId,
    poller,
    claim,
    coordinator,
    recovery: {
      recoverNow: async () => {
        recoveryCalls += 1
      },
    },
    now: () => Date.parse('2026-08-09T10:00:00.200Z'),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  })

  try {
    const status = await executor.start()
    assert.equal(status.state, 'running')
    assert.equal(status.metrics.executionsCompleted, 1)
    assert.equal(recoveryCalls, 1)
    assert.equal(scheduled !== null, true)
    const output = await new TTYOutputStreamManager(redis as never).read(executionId)
    assert.equal(
      output.some((event) => event.type === 'stdout' && event.data.text === 'worker-out'),
      true,
    )
    assert.equal(
      output.some((event) => event.type === 'stderr' && event.data.text === 'worker-err'),
      true,
    )
    assert.equal(
      output.some((event) => event.type === 'completion'),
      true,
    )
    const live = await broker.replay(executionId)
    assert.equal(
      live.events.some((event) => event.type === 'stdout'),
      true,
    )
    assert.equal(
      live.events.some((event) => event.type === 'stderr'),
      true,
    )
    await executor.stop()
  } finally {
    broker.close()
    await rm(rootDir, { recursive: true, force: true })
  }
})
