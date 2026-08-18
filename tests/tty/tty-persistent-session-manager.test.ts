import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { WorkerRedisMock } from './worker-redis-mock'
import {
  TTYPersistentRuntime,
  type TTYPersistentPty,
  type TTYPersistentPtyFactory,
} from '../../lib/tty/tty-persistent-runtime'
import {
  TTYPersistentSessionManager,
  type TTYPersistentRuntimeBackend,
  type TTYPersistentRuntimeHandle,
  type TTYPersistentSessionLifecycleStore,
} from '../../lib/tty/tty-persistent-session-manager'
import type { TTYSessionControlEntry } from '../../lib/tty/tty-session-control'
import { TTYSessionTranscriptManager } from '../../lib/tty/tty-session-transcript'
import type { InternalTTYSession, TTYExecutionId, TTYSessionId, TTYTerminationResult } from '../../lib/tty/tty-types'
import {
  ttySessionActiveExecutionKey,
  ttySessionRuntimeHistoryKey,
  ttySessionRuntimeKey,
  ttySessionRuntimeOutputOffsetKey,
  ttyPersistentSessionIndexKey,
} from '../../lib/tty/tty-worker-keys'
import type { TTYWorkerId } from '../../lib/tty/tty-worker-types'

const sessionId = '00000000-0000-4000-8000-000000009301' as TTYSessionId
const workerId = 'worker-persistent-manager-test' as TTYWorkerId

class FakePty implements TTYPersistentPty {
  readonly pid: number
  readonly writes: string[] = []
  readonly resizes: Array<{ columns: number; rows: number }> = []
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>()

  constructor(pid: number) {
    this.pid = pid
  }

  onData(callback: (data: string) => void) {
    this.dataListeners.add(callback)
    return { dispose: () => this.dataListeners.delete(callback) }
  }

  onExit(callback: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(callback)
    return { dispose: () => this.exitListeners.delete(callback) }
  }

  write(data: string): void {
    this.writes.push(data)
    this.emitData(`echo:${data}`)
  }

  resize(columns: number, rows: number): void {
    this.resizes.push({ columns, rows })
  }

  kill(): void {
    this.emitExit()
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data)
  }

  emitExit(): void {
    for (const listener of this.exitListeners) listener({ exitCode: 0 })
  }
}

class FakeFactory implements TTYPersistentPtyFactory {
  readonly ptys: FakePty[] = []

  spawn(_file: string, _args: readonly string[], _options: unknown): TTYPersistentPty {
    const pty = new FakePty(this.ptys.length + 1)
    this.ptys.push(pty)
    return pty
  }
}

class FramedFakePty extends FakePty {
  override write(data: string): void {
    this.writes.push(data)
    const token = data.match(/START;([a-f0-9]{32})/)?.[1]
    if (!token) {
      this.emitData(`echo:${data}`)
      return
    }
    // Simulate the terminal echo, then the shell's private frame and command
    // output arriving across arbitrary PTY chunks.
    this.emitData(`echo:${data.slice(0, 24)}\r\n\u001b]9;HEXICAL;START;${token.slice(0, 12)}`)
    this.emitData(`${token.slice(12)}\u0007persistent-shell-output\n`)
    this.emitData(`\u001b]9;HEXICAL;END;${token};0\u0007prompt$ `)
  }
}

class FramedFactory implements TTYPersistentPtyFactory {
  readonly ptys: FramedFakePty[] = []

  spawn(_file: string, _args: readonly string[], _options: unknown): TTYPersistentPty {
    const pty = new FramedFakePty(this.ptys.length + 1)
    this.ptys.push(pty)
    return pty
  }
}

class FakeLifecycleStore implements TTYPersistentSessionLifecycleStore {
  session: InternalTTYSession
  readonly terminationReasons: string[] = []

  constructor(maxOutputBytesPerExecution = 1_024) {
    this.session = {
      sessionId,
      ownerUserId: 'user-one',
      tier: 'pro',
      status: 'active',
      createdAt: '2026-08-11T00:00:00.000Z',
      lastActiveAt: '2026-08-11T00:00:00.000Z',
      limits: {
        maxConcurrentSessions: 1,
        maxConcurrentExecutionsPerSession: 1,
        maxExecutionsPerMinute: 60,
        maxExecutionDurationMs: 30_000,
        maxSessionIdleMs: 60_000,
        maxSessionDurationMs: 300_000,
        maxOutputBytesPerExecution,
        maxQueueDepth: 8,
      },
      usage: {
        activeSessions: 1,
        activeExecutionsInSession: 0,
        executionsInLastMinute: 0,
        queueDepth: 0,
        capturedAt: '2026-08-11T00:00:00.000Z',
      },
    }
  }

  async getSession(id: TTYSessionId, ownerUserId: string): Promise<InternalTTYSession | null> {
    return id === this.session.sessionId && ownerUserId === this.session.ownerUserId ? this.session : null
  }

  async touchSession(id: TTYSessionId, ownerUserId: string): Promise<InternalTTYSession | null> {
    const session = await this.getSession(id, ownerUserId)
    return session?.status === 'active' ? session : null
  }

  async terminateSession(
    id: TTYSessionId,
    ownerUserId: string,
    reason: 'resource_limit_exceeded' | 'runtime_exited' | 'system_shutdown',
  ): Promise<TTYTerminationResult> {
    if (id !== this.session.sessionId || ownerUserId !== this.session.ownerUserId)
      return { sessionId: id, acknowledged: false }
    this.terminationReasons.push(reason)
    this.session = { ...this.session, status: 'terminated' }
    return { sessionId: id, acknowledged: true, terminatedAt: '2026-08-11T00:00:01.000Z' }
  }
}

function command(
  type: TTYSessionControlEntry['type'],
  extra: Partial<TTYSessionControlEntry> = {},
): TTYSessionControlEntry {
  return {
    streamId: '1-0',
    commandId: `command-${type}-${Math.random().toString(16).slice(2)}`,
    sessionId,
    ownerUserId: 'user-one',
    type,
    timestamp: '2026-08-11T10:00:00.000Z',
    ...extra,
  }
}

function createFixture(maxOutputBytesPerExecution?: number) {
  const redis = new WorkerRedisMock()
  const factory = new FakeFactory()
  const runtime = new TTYPersistentRuntime(factory, {
    rootDir: join(tmpdir(), `hexical-persistent-manager-${Math.random().toString(16).slice(2)}`),
  })
  const store = new FakeLifecycleStore(maxOutputBytesPerExecution)
  const transcript = new TTYSessionTranscriptManager(redis as never)
  const manager = new TTYPersistentSessionManager(redis as never, runtime, store, transcript, workerId, {
    leaseTtlMs: 1_000,
    heartbeatIntervalMs: 100,
  })
  return { redis, factory, store, transcript, manager }
}

test('persistent session manager binds durable control to one PTY and transcript without persisting stdin', async () => {
  const fixture = createFixture()
  await fixture.manager.start()
  const open = command('open', { commandId: 'open-1' })
  const write = command('write', { commandId: 'write-1', data: 'echo durable\n' })
  const resize = command('resize', { commandId: 'resize-1', columns: 140, rows: 42 })

  await fixture.manager.handle(open)
  await fixture.manager.handle(write)
  await fixture.manager.handle(write)
  await fixture.manager.handle(resize)
  await fixture.manager.flush(sessionId)

  assert.deepEqual(fixture.factory.ptys[0]?.writes, ['echo durable\n'])
  assert.deepEqual(fixture.factory.ptys[0]?.resizes, [{ columns: 140, rows: 42 }])
  assert.equal(fixture.manager.activeSessionIds().length, 1)
  const replay = await fixture.transcript.read(sessionId)
  assert.equal(
    replay.some((event) => event.data.event === 'pty_attached'),
    true,
  )
  assert.equal(
    replay.some((event) => event.data.event === 'stdin_dispatching'),
    true,
  )
  assert.equal(
    replay.some((event) => event.type === 'stdout' && event.data.text === 'echo:echo durable\n'),
    true,
  )
  assert.equal(
    replay.some((event) => event.type === 'system' && event.data.text === 'echo durable\n'),
    false,
  )
  assert.equal(fixture.redis.values.has(ttySessionRuntimeKey(sessionId)), true)

  await fixture.manager.stop()
})

test('persistent session manager writes interactive stdin before durable session touch', async () => {
  const fixture = createFixture()
  await fixture.manager.start()
  await fixture.manager.handle(command('open', { commandId: 'open-fast-path' }))

  let releaseTouch!: () => void
  let touchStarted!: () => void
  const touchGate = new Promise<void>((resolve) => {
    releaseTouch = resolve
  })
  const touchStartedSignal = new Promise<void>((resolve) => {
    touchStarted = resolve
  })
  const originalTouch = fixture.store.touchSession.bind(fixture.store)
  fixture.store.touchSession = async (...args) => {
    touchStarted()
    await touchGate
    return originalTouch(...args)
  }

  const writePromise = fixture.manager.handle(command('write', { commandId: 'write-fast-path', data: 'pwd\r' }))
  await touchStartedSignal
  assert.deepEqual(fixture.factory.ptys[0]?.writes, ['pwd\r'])
  releaseTouch()
  await writePromise
  await fixture.manager.flush(sessionId)
  await fixture.manager.stop()
})

test('interactive stdin telemetry is sampled without delaying lossless PTY writes', async () => {
  const fixture = createFixture()
  await fixture.manager.start()
  await fixture.manager.handle(command('open', { commandId: 'open-telemetry-sampling' }))

  await fixture.manager.handle(command('write', { commandId: 'write-telemetry-a', data: 'a' }))
  await fixture.manager.handle(command('write', { commandId: 'write-telemetry-b', data: 'b' }))
  await fixture.manager.flush(sessionId)

  assert.deepEqual(fixture.factory.ptys[0]?.writes, ['a', 'b'])
  const replay = await fixture.transcript.read(sessionId)
  assert.equal(replay.filter((event) => event.data.event === 'stdin_dispatching').length, 1)
  assert.equal(
    replay.filter((event) => event.type === 'stdout').some((event) => event.data.text === 'echo:a'),
    true,
  )
  assert.equal(
    replay.filter((event) => event.type === 'stdout').some((event) => event.data.text === 'echo:b'),
    true,
  )

  await fixture.manager.stop()
})

test('interactive PTY output is not blocked by sampled stdin telemetry', async () => {
  const fixture = createFixture()
  await fixture.manager.start()
  await fixture.manager.handle(command('open', { commandId: 'open-telemetry-tail' }))

  let releaseTouch!: () => void
  const touchGate = new Promise<void>((resolve) => {
    releaseTouch = resolve
  })
  const originalTouch = fixture.store.touchSession.bind(fixture.store)
  fixture.store.touchSession = async (...args) => {
    await touchGate
    return originalTouch(...args)
  }

  await fixture.manager.handle(command('write', { commandId: 'write-telemetry-tail', data: 'echo-tail\r' }))
  await new Promise((resolve) => setTimeout(resolve, 10))

  const replayBeforeTelemetryCompletes = await fixture.transcript.read(sessionId)
  assert.equal(
    replayBeforeTelemetryCompletes.some((event) => event.type === 'stdout' && event.data.text === 'echo:echo-tail\r'),
    true,
  )

  releaseTouch()
  await fixture.manager.flush(sessionId)
  await fixture.manager.stop()
})

test('persistent session manager fences the PTY when output exceeds the session budget', async () => {
  const fixture = createFixture(8)
  await fixture.manager.start()
  await fixture.manager.handle(command('open'))
  fixture.factory.ptys[0]?.emitData('output-too-large')
  await fixture.manager.flush(sessionId)

  assert.equal(fixture.store.terminationReasons.includes('resource_limit_exceeded'), true)
  assert.equal(fixture.manager.activeSessionIds().length, 0)
  const replay = await fixture.transcript.read(sessionId)
  assert.equal(
    replay.some((event) => event.data.event === 'output_limit_exceeded'),
    true,
  )

  await fixture.manager.stop()
})

test('persistent session manager fails closed instead of silently replacing a lost PTY', async () => {
  const fixture = createFixture()
  fixture.redis.values.set(
    ttySessionRuntimeHistoryKey(sessionId),
    JSON.stringify({
      version: 1,
      sessionId,
      ownerUserId: 'user-one',
      workerId: 'lost-worker',
      runtimeId: 'lost-runtime',
      attachedAt: '2026-08-11T10:00:00.000Z',
    }),
  )
  await fixture.manager.start()
  await fixture.manager.handle(command('open'))

  assert.equal(fixture.factory.ptys.length, 0)
  assert.equal(fixture.store.terminationReasons.includes('system_shutdown'), true)
  const replay = await fixture.transcript.read(sessionId)
  assert.equal(
    replay.some((event) => event.data.event === 'runtime_recovery_unavailable'),
    true,
  )

  await fixture.manager.stop()
})

test('persistent session manager fences an active PTY when its Redis lease disappears', async () => {
  const fixture = createFixture()
  await fixture.manager.start()
  await fixture.manager.handle(command('open'))
  await fixture.redis.del(ttySessionRuntimeKey(sessionId))
  await fixture.manager.heartbeatOnce()

  assert.equal(fixture.store.terminationReasons.includes('system_shutdown'), false)
  assert.equal(fixture.store.session.status, 'active')
  assert.equal(fixture.manager.activeSessionIds().length, 0)
  const replay = await fixture.transcript.read(sessionId)
  assert.equal(
    replay.some((event) => event.data.event === 'runtime_lease_lost'),
    true,
  )

  await fixture.manager.stop()
})

test('persistent session manager fences a locally attached session before dispatch when tmux disappears', async () => {
  const fixture = createFixture()
  await fixture.manager.start()
  await fixture.manager.handle(command('open'))

  const runtime = (
    fixture.manager as unknown as { runtime: { hasPersistentSession?: (id: TTYSessionId) => Promise<boolean> } }
  ).runtime
  runtime.hasPersistentSession = async () => false

  await assert.rejects(
    fixture.manager.startExecution({
      executionId: '00000000-0000-4000-8000-000000009305' as TTYExecutionId,
      sessionId,
      ownerUserId: 'user-one',
      argv: ['echo', 'stale-shell'],
    }),
    /Persistent TTY shell could not be attached/,
  )
  assert.equal(fixture.store.terminationReasons.includes('resource_limit_exceeded'), true)
  assert.equal(fixture.manager.activeSessionIds().length, 0)
  const replay = await fixture.transcript.read(sessionId)
  assert.equal(
    replay.some((event) => event.type === 'system' && event.data.event === 'runtime_shell_unavailable'),
    true,
  )

  await fixture.manager.stop()
})

test('persistent session manager demultiplexes one admitted command from shell echo and keeps the PTY reusable', async () => {
  const redis = new WorkerRedisMock()
  const factory = new FramedFactory()
  const runtime = new TTYPersistentRuntime(factory, {
    rootDir: join(tmpdir(), `hexical-persistent-execution-${Math.random().toString(16).slice(2)}`),
  })
  const store = new FakeLifecycleStore()
  const transcript = new TTYSessionTranscriptManager(redis as never)
  const manager = new TTYPersistentSessionManager(redis as never, runtime, store, transcript, workerId, {
    leaseTtlMs: 1_000,
    heartbeatIntervalMs: 100,
  })
  await manager.start()

  const first = await manager.startExecution({
    executionId: '00000000-0000-4000-8000-000000009311' as TTYExecutionId,
    sessionId,
    ownerUserId: 'user-one',
    argv: ['pwd'],
  })
  const output: string[] = []
  first.onData((data) => output.push(Buffer.from(data).toString('utf8')))
  assert.equal((await first.exit).code, 0)
  const completedRaw = fixtureValue(redis, ttySessionActiveExecutionKey(sessionId))
  const completedRecord = JSON.parse(completedRaw)
  assert.equal(completedRecord.executionId, '00000000-0000-4000-8000-000000009311')
  assert.equal(completedRecord.state, 'completed')

  const second = await manager.startExecution({
    executionId: '00000000-0000-4000-8000-000000009312' as TTYExecutionId,
    sessionId,
    ownerUserId: 'user-one',
    argv: ['echo', 'same-shell'],
  })
  await second.exit
  await manager.flush(sessionId)

  assert.deepEqual(output, ['persistent-shell-output\n'])
  assert.equal(factory.ptys.length, 1)
  const replay = await transcript.read(sessionId)
  assert.equal(
    replay.some((event) => event.type === 'stdout' && event.data.text === 'persistent-shell-output\n'),
    true,
  )
  assert.equal(
    replay.some((event) => JSON.stringify(event.data).includes('HEXICAL')),
    false,
  )
  assert.equal(
    replay.some((event) => event.data.event === 'execution_completed'),
    true,
  )
  await manager.stop()
})

test('persistent session manager keeps a completed execution record until coordinator cleanup finalizes it', async () => {
  const redis = new WorkerRedisMock()
  const factory = new FramedFactory()
  const runtime = new TTYPersistentRuntime(factory, {
    rootDir: join(tmpdir(), `hexical-persistent-finalize-${Math.random().toString(16).slice(2)}`),
  })
  const store = new FakeLifecycleStore()
  const transcript = new TTYSessionTranscriptManager(redis as never)
  const manager = new TTYPersistentSessionManager(redis as never, runtime, store, transcript, workerId, {
    leaseTtlMs: 1_000,
    heartbeatIntervalMs: 100,
  })
  await manager.start()

  const handle = await manager.startExecution({
    executionId: '00000000-0000-4000-8000-000000009321' as TTYExecutionId,
    sessionId,
    ownerUserId: 'user-one',
    argv: ['pwd'],
  })
  assert.equal((await handle.exit).code, 0)
  const completedRecord = JSON.parse(fixtureValue(redis, ttySessionActiveExecutionKey(sessionId)))
  assert.equal(completedRecord.state, 'completed')
  assert.equal(completedRecord.exitCode, 0)

  await handle.finalize?.()
  assert.equal(redis.values.has(ttySessionActiveExecutionKey(sessionId)), false)

  await manager.stop()
})

test('persistent session manager preserves active execution state when only the PTY attachment is lost', async () => {
  const fixture = createFixture()
  await fixture.manager.start()

  const handle = await fixture.manager.startExecution({
    executionId: '00000000-0000-4000-8000-000000009331' as TTYExecutionId,
    sessionId,
    ownerUserId: 'user-one',
    argv: ['sleep', '30'],
  })
  const runtime = (
    fixture.manager as unknown as { runtime: { hasPersistentSession?: (id: TTYSessionId) => Promise<boolean> } }
  ).runtime
  runtime.hasPersistentSession = async () => true
  fixture.factory.ptys[0]?.emitExit()
  await waitFor(() => fixture.manager.activeSessionIds().length === 0)
  await fixture.manager.flush(sessionId)

  const activeRecord = JSON.parse(fixtureValue(fixture.redis, ttySessionActiveExecutionKey(sessionId)))
  assert.equal(activeRecord.executionId, handle.metadata.executionId)
  assert.equal(activeRecord.state, 'dispatched')
  assert.equal(fixture.manager.activeSessionIds().length, 0)
  const replay = await fixture.transcript.read(sessionId)
  assert.equal(
    replay.some((event) => event.data.event === 'pty_attachment_lost'),
    true,
  )

  await fixture.manager.stop()
})

test('persistent session manager checkpoints journal replay after durable output and deduplicates a cursor retry', async () => {
  const redis = new WorkerRedisMock()
  const store = new FakeLifecycleStore()
  const transcript = new TTYSessionTranscriptManager(redis as never)
  const journal = 'journal-output-✓\n'
  const metadata = {
    sessionId,
    ownerUserId: 'user-one',
    workerId,
    pid: 9911,
    shell: '/bin/bash',
    cwd: join(tmpdir(), 'hexical-journal-session'),
    startedAt: '2026-08-11T10:00:00.000Z',
    columns: 120,
    rows: 40,
    state: 'active' as const,
  }
  const handle: TTYPersistentRuntimeHandle = {
    metadata,
    write: () => {},
    resize: () => {},
    onData: () => () => {},
    onExit: () => () => {},
    terminate: async () => {},
    detach: async () => {},
    replayOutput: async (afterOffset = 0) => ({
      data: afterOffset < Buffer.byteLength(journal, 'utf8') ? journal : '',
      nextOffset: Buffer.byteLength(journal, 'utf8'),
    }),
  }
  const runtime: TTYPersistentRuntimeBackend = {
    createSession: async () => handle,
    recoverSession: async () => handle,
    getSession: () => handle,
    hasPersistentSession: async () => true,
  }
  const timers: Array<() => void> = []
  const manager = new TTYPersistentSessionManager(redis as never, runtime, store, transcript, workerId, {
    leaseTtlMs: 1_000,
    heartbeatIntervalMs: 100,
    journalPollIntervalMs: 100,
    setInterval: (callback) => {
      timers.push(callback)
      return callback
    },
    clearInterval: () => {},
  })
  await manager.start()
  await manager.handle(command('open', { commandId: 'journal-open' }))
  await manager.flush(sessionId)

  const firstReplay = await transcript.read(sessionId)
  assert.equal(firstReplay.filter((event) => event.type === 'stdout').length, 1)
  assert.equal(
    redis.values.get(ttySessionRuntimeOutputOffsetKey(sessionId)),
    String(Buffer.byteLength(journal, 'utf8')),
  )

  await redis.del(ttySessionRuntimeOutputOffsetKey(sessionId))
  timers[1]?.()
  await new Promise((resolve) => setTimeout(resolve, 5))
  await manager.flush(sessionId)
  const retriedReplay = await transcript.read(sessionId)
  assert.equal(retriedReplay.filter((event) => event.type === 'stdout').length, 1)

  await manager.stop()
})

test('persistent session manager reattaches indexed tmux state after a worker process restart', async () => {
  const redis = new WorkerRedisMock()
  const store = new FakeLifecycleStore()
  const transcript = new TTYSessionTranscriptManager(redis as never)
  let created = 0
  let recovered = 0
  const runtime: TTYPersistentRuntimeBackend = {
    createSession: async (input) => {
      created += 1
      return recoverableHandle(input)
    },
    recoverSession: async (input) => {
      recovered += 1
      return recoverableHandle(input)
    },
    getSession: () => null,
    hasPersistentSession: async () => true,
  }

  const firstWorker = new TTYPersistentSessionManager(redis as never, runtime, store, transcript, workerId, {
    leaseTtlMs: 1_000,
    heartbeatIntervalMs: 100,
  })
  await firstWorker.start()
  await firstWorker.handle(command('open', { commandId: 'restart-open' }))
  assert.equal(created, 1)
  assert.deepEqual(await redis.smembers(ttyPersistentSessionIndexKey()), [sessionId])

  // A normal worker shutdown detaches node-pty but intentionally leaves the
  // tmux shell and durable session index alive for the next process.
  await firstWorker.stop()

  const restartedWorker = new TTYPersistentSessionManager(redis as never, runtime, store, transcript, workerId, {
    leaseTtlMs: 1_000,
    heartbeatIntervalMs: 100,
  })
  await restartedWorker.start()

  assert.equal(recovered, 1)
  assert.deepEqual(restartedWorker.activeSessionIds(), [sessionId])
  const replay = await transcript.read(sessionId)
  assert.equal(
    replay.some((event) => event.data.event === 'pty_recovered'),
    true,
  )
  await restartedWorker.stop()
})

function recoverableHandle(
  input: Parameters<NonNullable<TTYPersistentRuntimeBackend['createSession']>>[0],
): TTYPersistentRuntimeHandle {
  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(event: { readonly exitCode: number; readonly signal?: number }) => void>()
  return {
    metadata: {
      sessionId: input.sessionId,
      ownerUserId: input.ownerUserId,
      workerId: input.workerId,
      pid: 9_901,
      shell: '/bin/bash',
      cwd: '/tmp/hexical-recovery-test',
      startedAt: input.startedAt ?? '2026-08-11T10:00:00.000Z',
      columns: 120,
      rows: 40,
      state: 'active',
    },
    write: () => {},
    resize: () => {},
    onData: (callback) => {
      dataListeners.add(callback)
      return () => dataListeners.delete(callback)
    },
    onExit: (callback) => {
      exitListeners.add(callback)
      return () => exitListeners.delete(callback)
    },
    terminate: async () => {
      for (const callback of exitListeners) callback({ exitCode: 0 })
    },
    detach: async () => {},
  }
}

function fixtureValue(redis: WorkerRedisMock, key: string): string {
  const value = redis.values.get(key)
  assert.ok(value !== undefined)
  return value
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 250
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(predicate(), true)
}
