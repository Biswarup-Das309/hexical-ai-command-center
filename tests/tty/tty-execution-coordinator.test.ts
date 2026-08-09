import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { TTYExecutionCoordinator, type TTYExecutionCoordinatorDependencies } from '../../lib/tty/tty-execution-coordinator'
import type { TTYProcessExit, TTYProcessHandle, TTYProcessMetadata, TTYProcessSpec } from '../../lib/tty/tty-process-runtime'
import type { InternalTTYSession, TTYExecutionId, TTYSessionId } from '../../lib/tty/tty-types'
import type { TTYLeasedJob, TTYLeaseCompleteResult, TTYLeaseRenewResult } from '../../lib/tty/tty-execution-lease'
import { TTYOutputStreamManager } from '../../lib/tty/tty-output-stream'
import { TTYResourceGuard } from '../../lib/tty/tty-resource-guard'
import type { TTYWorkerId } from '../../lib/tty/tty-worker-types'
import { WorkerRedisMock } from './worker-redis-mock'

const workerId = 'worker-coordinator-test' as TTYWorkerId
const sessionId = '00000000-0000-4000-8000-000000000501' as TTYSessionId
const executionId = '00000000-0000-4000-8000-000000000502' as TTYExecutionId

const session: InternalTTYSession = {
  sessionId,
  ownerUserId: 'user-coordinator',
  tier: 'pro',
  status: 'active',
  createdAt: '2026-08-08T10:00:00.000Z',
  lastActiveAt: '2026-08-08T10:00:00.000Z',
  limits: {
    maxConcurrentSessions: 3,
    maxConcurrentExecutionsPerSession: 2,
    maxExecutionsPerMinute: 30,
    maxExecutionDurationMs: 200,
    maxSessionIdleMs: 900_000,
    maxSessionDurationMs: 3_600_000,
    maxOutputBytesPerExecution: 100,
    maxQueueDepth: 10
  },
  usage: { activeSessions: 1, activeExecutionsInSession: 0, executionsInLastMinute: 0, queueDepth: 0, capturedAt: '2026-08-08T10:00:00.000Z' }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

class ControlledRuntime {
  readonly started: TTYProcessSpec[] = []
  readonly cleaned: TTYProcessHandle[] = []
  private active: { handle: TTYProcessHandle; resolve: (exit: TTYProcessExit) => void } | null = null
  constructor(private readonly output: { stdout: string; stderr: string } = { stdout: 'hello\n', stderr: 'warning\n' }) {}

  async start(spec: TTYProcessSpec): Promise<TTYProcessHandle> {
    this.started.push(spec)
    const completion = deferred<TTYProcessExit>()
    const handle: TTYProcessHandle = {
      handleId: `handle-${this.started.length}`,
      pid: 45_001 + this.started.length,
      startedAt: '2026-08-08T10:00:00.100Z',
      executionId: spec.executionId,
      sessionId: spec.sessionId,
      workerId: spec.workerId,
      stdout: Readable.from([Buffer.from(this.output.stdout)]),
      stderr: Readable.from([Buffer.from(this.output.stderr)]),
      exit: completion.promise
    }
    this.active = { handle, resolve: completion.resolve }
    if (this.output.stdout === 'hello\n') queueMicrotask(() => this.finish({ code: 0, signal: null }))
    return handle
  }

  async stop(_handle: TTYProcessHandle): Promise<void> {
    this.finish({ code: null, signal: 'SIGTERM' })
  }

  async kill(_handle: TTYProcessHandle): Promise<void> {
    this.finish({ code: null, signal: 'SIGKILL' })
  }

  async cleanup(handle: TTYProcessHandle): Promise<void> {
    this.cleaned.push(handle)
  }

  getMetadata(handle: TTYProcessHandle): TTYProcessMetadata {
    return {
      handleId: handle.handleId,
      pid: handle.pid,
      cwd: `C:/private/${handle.executionId}`,
      executionId: handle.executionId,
      sessionId: handle.sessionId,
      workerId: handle.workerId,
      startedAt: handle.startedAt
    }
  }

  finish(exit: TTYProcessExit): void {
    if (!this.active) return
    const current = this.active
    this.active = null
    current.resolve(exit)
  }
}

class FakeLeases {
  readonly completed: Array<{ token: string; state: string }> = []
  constructor(
    private readonly completion: TTYLeaseCompleteResult = { completed: true, job: undefined as never },
    private readonly jobKind: 'diagnostic' | 'session_utility' = 'diagnostic',
    private readonly jobArgv: readonly string[] = ['debug', '--safe-flag']
  ) {}

  async claim(_executionId: TTYExecutionId, _sessionId: TTYSessionId) {
    return {
      claimed: true as const,
      job: {
        executionId,
        sessionId,
        ownerUserId: session.ownerUserId,
        kind: this.jobKind,
        status: 'leased' as const,
        createdAt: session.createdAt,
        admittedAt: session.createdAt,
        authorizationScopeId: null,
        argv: this.jobArgv,
        resource: { maxExecutionDurationMs: session.limits.maxExecutionDurationMs, maxOutputBytes: session.limits.maxOutputBytesPerExecution },
        attempt: 1,
        lease: { workerId, token: 'secret-renewal-token', leaseId: 'opaque-lease-id' as never, claimedAtMs: 1_000, renewedAtMs: 1_000, expiresAtMs: Date.now() + 60_000, maxExpiresAtMs: Date.now() + 300_000 }
      } as TTYLeasedJob
    }
  }

  async renew(_executionId: TTYExecutionId, _sessionId: TTYSessionId, _token: string): Promise<TTYLeaseRenewResult> {
    return { renewed: true, job: undefined as never }
  }

  async recover(_executionId: TTYExecutionId, _sessionId: TTYSessionId) {
    return { recovered: true as const, job: undefined as never }
  }

  async complete(_executionId: TTYExecutionId, _sessionId: TTYSessionId, token: string, state: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'expired'): Promise<TTYLeaseCompleteResult> {
    this.completed.push({ token, state })
    return this.completion
  }
}

function dependencies(runtime: ControlledRuntime, leases: FakeLeases, overrides: Partial<TTYExecutionCoordinatorDependencies> = {}): TTYExecutionCoordinatorDependencies {
  const redis = new WorkerRedisMock()
  return {
    redis: redis as never,
    workerId,
    sessionStore: {
      getSession: async () => session,
      recordExecutionStarted: async () => undefined,
      recordExecutionFinished: async () => undefined
    },
    leaseManager: leases,
    processRuntime: runtime,
    resourceGuard: new TTYResourceGuard({ maxConcurrentProcesses: 2, maxStdoutBytesPerSecond: 10_000, maxStderrBytesPerSecond: 10_000 }),
    outputStream: new TTYOutputStreamManager(redis as never),
    now: () => new Date('2026-08-08T10:00:01.000Z'),
    leaseRenewIntervalMs: 1_000,
    stopGraceMs: 50,
    commandAllowlist: { diagnostic: ['debug'] },
    ...overrides
  }
}

test('coordinator runs a leased job through streaming to success without persisting the lease token', async () => {
  const runtime = new ControlledRuntime()
  const leases = new FakeLeases()
  const deps = dependencies(runtime, leases)
  const coordinator = new TTYExecutionCoordinator(deps)
  const result = await coordinator.run(executionId, sessionId)

  assert.equal(result.accepted, true)
  if (!result.accepted) return
  assert.equal(result.state.state, 'succeeded')
  assert.equal(result.state.leaseId, 'opaque-lease-id')
  assert.equal(result.state.outputBytes, 14)
  assert.equal(result.state.stdoutBytes, 6)
  assert.equal(result.state.stderrBytes, 8)
  assert.equal(JSON.stringify(result.state).includes('secret-renewal-token'), false)
  assert.deepEqual(leases.completed, [{ token: 'secret-renewal-token', state: 'succeeded' }])
  assert.equal(runtime.started[0]?.file, 'debug')
  assert.deepEqual(runtime.started[0]?.args, ['--safe-flag'])
  assert.equal(runtime.cleaned.length, 1)
})

test('coordinator executes non-process session utilities through a trusted virtual runtime', async () => {
  const runtime = new ControlledRuntime()
  const leases = new FakeLeases({ completed: true, job: undefined as never }, 'session_utility', ['history', '--ignored'])
  const coordinator = new TTYExecutionCoordinator(dependencies(runtime, leases))
  const result = await coordinator.run(executionId, sessionId)

  assert.equal(result.accepted, true)
  if (result.accepted) assert.equal(result.state.state, 'succeeded')
  assert.equal(runtime.started[0]?.file, process.execPath)
  assert.deepEqual(runtime.started[0]?.args.slice(0, 1), ['-e'])
})

test('coordinator cancellation stops the owned process and is idempotent', async () => {
  const runtime = new ControlledRuntime({ stdout: '', stderr: '' })
  const leases = new FakeLeases()
  const deps = dependencies(runtime, leases)
  const coordinator = new TTYExecutionCoordinator(deps)
  const runPromise = coordinator.run(executionId, sessionId)
  while (runtime.started.length === 0) await new Promise(resolve => setTimeout(resolve, 1))

  const cancelled = await coordinator.cancelExecution(executionId)
  const runResult = await runPromise
  const replay = await coordinator.cancelExecution(executionId)

  assert.equal(cancelled.acknowledged, true)
  assert.equal(cancelled.state?.state, 'cancelled')
  assert.equal(runResult.accepted, true)
  if (runResult.accepted) assert.equal(runResult.state.state, 'cancelled')
  assert.equal(replay.acknowledged, true)
  assert.equal(replay.state?.state, 'cancelled')
})

test('coordinator turns an activation abort into a persisted cancellation before starting a process', async () => {
  const runtime = new ControlledRuntime({ stdout: '', stderr: '' })
  const leases = new FakeLeases()
  const controller = new AbortController()
  controller.abort()
  const coordinator = new TTYExecutionCoordinator(dependencies(runtime, leases))

  const result = await coordinator.run(executionId, sessionId, { abortSignal: controller.signal })

  assert.equal(result.accepted, true)
  if (result.accepted) assert.equal(result.state.state, 'cancelled')
  assert.equal(runtime.started.length, 0)
  assert.deepEqual(leases.completed, [])
})

test('coordinator turns a runtime timeout into a hard-stop terminal state', async () => {
  const runtime = new ControlledRuntime({ stdout: '', stderr: '' })
  const leases = new FakeLeases()
  const deps = dependencies(runtime, leases)
  const coordinator = new TTYExecutionCoordinator({
    ...deps,
    resourceGuard: new TTYResourceGuard({ maxConcurrentProcesses: 2, maxStdoutBytesPerSecond: 10_000, maxStderrBytesPerSecond: 10_000 })
  })
  const result = await coordinator.run(executionId, sessionId)
  assert.equal(result.accepted, true)
  if (result.accepted) assert.equal(result.state.state, 'timed_out')
})

test('coordinator stops and fails an execution when its output ceiling is exceeded', async () => {
  const runtime = new ControlledRuntime({ stdout: '0123456789'.repeat(11), stderr: '' })
  const leases = new FakeLeases()
  const deps = dependencies(runtime, leases)
  const coordinator = new TTYExecutionCoordinator({
    ...deps,
    resourceGuard: new TTYResourceGuard({ maxConcurrentProcesses: 2, maxStdoutBytesPerSecond: 10_000, maxStderrBytesPerSecond: 10_000 })
  })
  const result = await coordinator.run(executionId, sessionId)
  assert.equal(result.accepted, true)
  if (result.accepted) {
    assert.equal(result.state.state, 'failed')
    assert.equal(result.state.failureCode, 'OUTPUT_LIMIT_EXCEEDED')
    assert.equal(result.state.outputBytes, 100)
  }
})

test('coordinator fails closed when lease finalization loses ownership', async () => {
  const runtime = new ControlledRuntime()
  const leases = new FakeLeases({ completed: false, reason: 'lease_expired' })
  const coordinator = new TTYExecutionCoordinator(dependencies(runtime, leases))
  const result = await coordinator.run(executionId, sessionId)
  assert.equal(result.accepted, true)
  if (result.accepted) {
    assert.equal(result.state.state, 'expired')
    assert.equal(result.state.failureCode, 'LEASE_COMPLETION_LEASE_EXPIRED')
  }
})
