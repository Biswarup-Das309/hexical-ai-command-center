import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TTYExecutionCoordinator, type TTYExecutionLeaseOperations } from '../lib/tty/tty-execution-coordinator'
import type { TTYLeasedJob } from '../lib/tty/tty-execution-lease'
import { createQueuedTTYExecutionState } from '../lib/tty/tty-execution-state'
import { TTYOutputStreamManager } from '../lib/tty/tty-output-stream'
import { TTYPersistentProcessRuntime } from '../lib/tty/tty-persistent-process-runtime'
import { TTYPersistentRuntime, createNodePtyFactory } from '../lib/tty/tty-persistent-runtime'
import { TTYPersistentSessionManager } from '../lib/tty/tty-persistent-session-manager'
import { TTYResourceGuard } from '../lib/tty/tty-resource-guard'
import { createTTYSessionRuntimeApi } from '../lib/tty/tty-session-runtime-api'
import { TTYSessionTranscriptManager } from '../lib/tty/tty-session-transcript'
import type { InternalTTYSession, TTYExecutionId, TTYSessionId } from '../lib/tty/tty-types'
import { ttyExecutionStateKey, ttyPendingExecutionIndexKey } from '../lib/tty/tty-worker-keys'
import type { TTYLeaseId, TTYWorkerId } from '../lib/tty/tty-worker-types'
import { WorkerRedisMock } from '../tests/tty/worker-redis-mock'

const OWNER = 'local-runtime-os-owner'
const WORKER = 'local-runtime-os-worker' as TTYWorkerId
const SESSION_ID = '00000000-0000-4000-8000-000000009901' as TTYSessionId
const EXECUTION_ID = '00000000-0000-4000-8000-000000009902' as TTYExecutionId
const MARKER = 'HEXICAL_RUNTIME_OS_TEST'

function sessionFixture(): InternalTTYSession {
  const now = new Date().toISOString()
  return {
    sessionId: SESSION_ID,
    ownerUserId: OWNER,
    tier: 'pro',
    status: 'active',
    createdAt: now,
    lastActiveAt: now,
    limits: {
      maxConcurrentSessions: 4,
      maxConcurrentExecutionsPerSession: 1,
      maxExecutionsPerMinute: 30,
      maxExecutionDurationMs: 20_000,
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
      capturedAt: now,
    },
  }
}

function shellConfig(): {
  readonly shell: string
  readonly shellArgs: readonly string[]
  readonly baseEnv: Readonly<Record<string, string>>
} {
  if (process.platform !== 'win32') {
    return {
      shell: '/bin/sh',
      shellArgs: [],
      baseEnv: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'C.UTF-8' },
    }
  }

  const gitRoot = process.env.ProgramFiles ?? 'C:\\Program Files'
  const shell = join(gitRoot, 'Git', 'bin', 'bash.exe')
  return {
    shell,
    shellArgs: ['--noprofile', '--norc'],
    baseEnv: {
      PATH: [
        join(gitRoot, 'Git', 'usr', 'bin'),
        join(gitRoot, 'Git', 'bin'),
        process.env.SystemRoot ?? 'C:\\Windows',
      ].join(';'),
      TERM: 'xterm-256color',
      LANG: 'C.UTF-8',
    },
  }
}

class LocalLeaseManager implements TTYExecutionLeaseOperations {
  readonly claims: TTYExecutionId[] = []
  readonly completed: Array<{ executionId: TTYExecutionId; state: string }> = []

  constructor(
    private readonly redis: WorkerRedisMock,
    private readonly job: TTYLeasedJob,
  ) {}

  async claim(executionId: TTYExecutionId, sessionId: TTYSessionId) {
    assert.equal(executionId, this.job.executionId)
    assert.equal(sessionId, this.job.sessionId)
    this.claims.push(executionId)
    await this.redis.srem(ttyPendingExecutionIndexKey(), executionId)
    return { claimed: true as const, job: this.job }
  }

  async renew() {
    return { renewed: true as const, job: this.job }
  }

  async complete(
    executionId: TTYExecutionId,
    _sessionId: TTYSessionId,
    _leaseToken: string,
    state: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'expired',
  ) {
    this.completed.push({ executionId, state })
    return { completed: true as const, job: this.job }
  }

  async recover(executionId: TTYExecutionId, sessionId: TTYSessionId) {
    assert.equal(executionId, this.job.executionId)
    assert.equal(sessionId, this.job.sessionId)
    return { recovered: true as const, job: { ...this.job, status: 'queued' as const } }
  }
}

function dataContainsText(data: unknown, marker: string): boolean {
  if (typeof data !== 'object' || data === null || !('text' in data)) return false
  const text = data.text
  return typeof text === 'string' && text.includes(marker)
}

async function replayAll(
  api: ReturnType<typeof createTTYSessionRuntimeApi>,
  sessionId: TTYSessionId,
): Promise<readonly { readonly eventId: string; readonly sequence: number; readonly data: Record<string, unknown> }[]> {
  const events: Array<{ eventId: string; sequence: number; data: Record<string, unknown> }> = []
  let after: string | null = null
  for (let page = 0; page < 100; page += 1) {
    const url = new URL(`https://hexical.local/api/tty/sessions/${sessionId}/transcript`)
    url.searchParams.set('limit', '50')
    if (after) url.searchParams.set('after', after)
    const response = await api.replay(new Request(url), sessionId)
    assert.equal(response.status, 200)
    const body = (await response.json()) as {
      readonly events: readonly {
        readonly eventId: string
        readonly sequence: number
        readonly data: Record<string, unknown>
      }[]
      readonly cursor: string | null
      readonly hasMore: boolean
    }
    events.push(...body.events)
    if (!body.hasMore) return events
    assert.ok(body.cursor && body.cursor !== after, 'replay cursor did not advance')
    after = body.cursor
  }
  throw new Error('Replay pagination exceeded the bounded local verification limit.')
}

async function main(): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), 'hexical-runtime-os-e2e-'))
  const redis = new WorkerRedisMock()
  const session = sessionFixture()
  const transcript = new TTYSessionTranscriptManager(redis as never)
  const output = new TTYOutputStreamManager(redis as never)
  const config = shellConfig()
  if (process.platform === 'win32') await access(config.shell)

  let currentSession = session
  let startedCount = 0
  let finishedCount = 0
  let runtime: TTYPersistentRuntime | undefined
  let manager: TTYPersistentSessionManager | undefined

  const store = {
    async getSession(sessionId: TTYSessionId, ownerUserId: string) {
      return sessionId === SESSION_ID && ownerUserId === OWNER ? currentSession : null
    },
    async touchSession(sessionId: TTYSessionId, ownerUserId: string) {
      return sessionId === SESSION_ID && ownerUserId === OWNER && currentSession.status === 'active'
        ? currentSession
        : null
    },
    async recordExecutionStarted() {
      startedCount += 1
    },
    async recordExecutionFinished() {
      finishedCount += 1
    },
    async terminateSession(sessionId: TTYSessionId, ownerUserId: string) {
      if (sessionId !== SESSION_ID || ownerUserId !== OWNER) return { sessionId, acknowledged: false as const }
      currentSession = { ...currentSession, status: 'terminated' }
      return { sessionId, acknowledged: true as const, terminatedAt: new Date().toISOString() }
    },
  }

  const job: TTYLeasedJob = {
    executionId: EXECUTION_ID,
    sessionId: SESSION_ID,
    ownerUserId: OWNER,
    kind: 'session_utility',
    status: 'leased',
    createdAt: session.createdAt,
    admittedAt: session.createdAt,
    authorizationScopeId: null,
    argv: ['echo', MARKER],
    resource: {
      maxExecutionDurationMs: session.limits.maxExecutionDurationMs,
      maxOutputBytes: session.limits.maxOutputBytesPerExecution,
    },
    attempt: 1,
    lease: {
      workerId: WORKER,
      token: 'local-runtime-os-lease-token',
      leaseId: 'local-runtime-os-lease' as TTYLeaseId,
      claimedAtMs: Date.now(),
      renewedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      maxExpiresAtMs: Date.now() + 300_000,
    },
  }

  const leases = new LocalLeaseManager(redis, job)
  const queued = createQueuedTTYExecutionState(EXECUTION_ID, SESSION_ID, session.createdAt, OWNER)
  await redis.set(ttyExecutionStateKey(EXECUTION_ID), JSON.stringify(queued))
  await redis.sadd(ttyPendingExecutionIndexKey(), EXECUTION_ID)

  try {
    runtime = new TTYPersistentRuntime(await createNodePtyFactory(), {
      rootDir,
      shell: config.shell,
      shellArgs: config.shellArgs,
      baseEnv: config.baseEnv,
      defaultColumns: 140,
      defaultRows: 40,
      terminationWaitMs: 10_000,
      useConpty: process.platform === 'win32' ? false : undefined,
    })
    manager = new TTYPersistentSessionManager(redis as never, runtime, store, transcript, WORKER, {
      leaseTtlMs: 5_000,
      heartbeatIntervalMs: 1_000,
      executionOutput: output,
    })
    const coordinator = new TTYExecutionCoordinator({
      redis: redis as never,
      workerId: WORKER,
      sessionStore: store,
      leaseManager: leases,
      processRuntime: new TTYPersistentProcessRuntime(manager),
      resourceGuard: new TTYResourceGuard({
        maxConcurrentProcesses: 1,
        maxStdoutBytesPerSecond: 64_000,
        maxStderrBytesPerSecond: 64_000,
      }),
      outputStream: output,
      commandAllowlist: { session_utility: ['echo'] },
      virtualSessionUtilities: false,
      leaseRenewIntervalMs: 1_000,
      stopGraceMs: 500,
    })
    const api = createTTYSessionRuntimeApi({
      authenticate: async () => OWNER,
      store,
      transcript,
      publish: async () => 'local-1',
    })

    await manager.start()
    const executionStartedAt = Date.now()
    const result = await coordinator.run(EXECUTION_ID, SESSION_ID, {
      correlationId: `local-runtime-os-${randomUUID()}`,
    })
    const executionLatencyMs = Date.now() - executionStartedAt
    assert.equal(result.accepted, true)
    if (!result.accepted) return
    assert.equal(result.state.state, 'succeeded')
    assert.equal(result.state.exitCode, 0)
    assert.equal(leases.claims.length, 1)
    assert.deepEqual(leases.completed, [{ executionId: EXECUTION_ID, state: 'succeeded' }])
    assert.equal(startedCount, 1)
    assert.equal(finishedCount, 1)
    assert.deepEqual(await redis.smembers(ttyPendingExecutionIndexKey()), [])

    await manager.flush(SESSION_ID)
    const transcriptEvents = await transcript.read(SESSION_ID)
    const executionEvents = await output.read(EXECUTION_ID)
    assert.ok(transcriptEvents.some((event) => event.data.event === 'execution_dispatched'))
    assert.ok(transcriptEvents.some((event) => event.type === 'stdout' && dataContainsText(event.data, MARKER)))
    assert.ok(transcriptEvents.some((event) => event.data.event === 'execution_completed'))
    assert.ok(executionEvents.some((event) => event.type === 'stdout' && dataContainsText(event.data, MARKER)))
    assert.ok(executionEvents.some((event) => event.type === 'completion' && event.data.state === 'succeeded'))

    const replayStartedAt = Date.now()
    const replayed = await replayAll(api, SESSION_ID)
    const replayLatencyMs = Date.now() - replayStartedAt
    assert.ok(replayed.some((event) => dataContainsText(event.data, MARKER)))
    assert.equal(new Set(replayed.map((event) => event.eventId)).size, replayed.length)
    for (let index = 1; index < replayed.length; index += 1)
      assert.equal(replayed[index]?.sequence, (replayed[index - 1]?.sequence ?? 0) + 1)

    const stateRaw = await redis.get<string>(ttyExecutionStateKey(EXECUTION_ID))
    assert.ok(stateRaw)
    assert.equal(JSON.parse(stateRaw).state, 'succeeded')

    console.log(
      JSON.stringify({
        ok: true,
        platform: process.platform,
        nodePty: '1.1.0',
        shell: config.shell,
        queuedToCompleted: true,
        workerClaimed: true,
        ptyAttached: transcriptEvents.some((event) => event.data.event === 'pty_attached'),
        stdoutPersisted: true,
        transcriptEvents: transcriptEvents.length,
        executionEvents: executionEvents.length,
        replayEvents: replayed.length,
        duplicateReplayEvents: 0,
        executionLatencyMs,
        replayLatencyMs,
        marker: MARKER,
        completion: result.state.state,
      }),
    )
  } finally {
    if (manager) await manager.stop().catch(() => undefined)
    currentSession = { ...currentSession, status: 'terminated' }
    if (runtime) await runtime.terminateSession(SESSION_ID, OWNER).catch(() => false)
    await rm(rootDir, { recursive: true, force: true })
  }
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error)
    process.exitCode = 1
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode ?? 0), 0)
  })
