import { createSupabaseRuntimeStore } from '../lib/tty/supabase-runtime-store'
import { TTYExecutionCoordinator } from '../lib/tty/tty-execution-coordinator'
import { TTYExecutionLeaseManager } from '../lib/tty/tty-execution-lease'
import { TTYPersistentProcessRuntime } from '../lib/tty/tty-persistent-process-runtime'
import { TTYPersistentRecoveryService } from '../lib/tty/tty-persistent-recovery-service'
import { TTYPersistentSessionManager } from '../lib/tty/tty-persistent-session-manager'
import { normalizeTTYRedisStreamEntries, normalizeTTYRedisStreamFields } from '../lib/tty/tty-redis-stream'
import { TTYResourceGuard } from '../lib/tty/tty-resource-guard'
import type { TTYRuntimeStore } from '../lib/tty/tty-runtime-store'
import { TTYSessionControlConsumer } from '../lib/tty/tty-session-control'
import { TTYSessionControlRouter } from '../lib/tty/tty-session-control-router'
import { createTTYSessionStore } from '../lib/tty/tty-session-store'
import { TTYSessionTranscriptManager } from '../lib/tty/tty-session-transcript'
import { TTYStreamBroker, type TTYStreamRedis } from '../lib/tty/tty-stream-broker'
import { TTYStreamingOutputStreamManager } from '../lib/tty/tty-stream-runtime-bridge'
import { createNodePtyTmuxAdapter, TTYTmuxRuntime } from '../lib/tty/tty-tmux-runtime'
import type { TTYExecutionId, TTYSessionId } from '../lib/tty/tty-types'
import { TTYWorkerAudit } from '../lib/tty/tty-worker-audit'
import { TTYWorkerAuthenticator, issueTTYWorkerToken, verifyWorkerToken } from '../lib/tty/tty-worker-auth'
import { createTTYWorkerClaimService } from '../lib/tty/tty-worker-claim'
import { TTYWorkerDaemon } from '../lib/tty/tty-worker-daemon'
import { TTYWorkerExecutor } from '../lib/tty/tty-worker-executor'
import { TTYWorkerHeartbeatService } from '../lib/tty/tty-worker-heartbeat'
import {
  ttyExecutionJobKey,
  ttyPendingExecutionIndexKey,
  ttyPendingExecutionStreamKey,
  ttyWorkerSessionControlGroup,
  ttyWorkerSessionControlStreamKey,
} from '../lib/tty/tty-worker-keys'
import { TTYWorkerLeaseObserver } from '../lib/tty/tty-worker-observer'
import { createTTYWorkerPoller, type PendingExecutionQueue } from '../lib/tty/tty-worker-poller'
import { TTYWorkerRegistry } from '../lib/tty/tty-worker-registry'
import { createTTYWorkerId, type TTYWorkerAuthContext } from '../lib/tty/tty-worker-types'

const DEFAULT_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1_000
// Worker registration requires a semantic version so deployments can be
// identified and upgraded deterministically.
const DEFAULT_VERSION = '1.0.0'

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required worker environment variable: ${name}`)
  return value
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`)
  return parsed
}

function requiredTrue(name: string): void {
  const value = requiredEnv(name).toLowerCase()
  if (value !== 'true') throw new Error(`${name} must be true for the authoritative persistent PTY worker.`)
}

function workerLogger(level: 'info' | 'warn' | 'error', event: string, fields: Readonly<Record<string, unknown>> = {}) {
  const entry = JSON.stringify({ component: 'hexical-tty-worker', level, event, ...fields })
  if (level === 'error') console.error(entry)
  else if (level === 'warn') console.warn(entry)
  else console.info(entry)
}

class SupabasePendingExecutionQueue implements PendingExecutionQueue {
  private readonly pending = new Set<string>()
  private readonly seenCursors = new Set<string>()
  private initialized = false

  constructor(private readonly redis: TTYRuntimeStore) {}

  async listPendingExecutionIds(limit: number): Promise<readonly string[]> {
    const requestedLimit = Math.max(0, Math.floor(limit))
    if (requestedLimit === 0) return []
    if (!this.initialized) {
      this.initialized = true
      const initialIds = [
        ...new Set((await this.redis.smembers(ttyPendingExecutionIndexKey())).map((id) => String(id).trim())),
      ]
      for (const id of initialIds) this.pending.add(id)
    }
    const ids = [...this.pending]
      .filter(Boolean)
      // Reconcile a bounded window on every poll. This prevents an unbounded
      // stale Redis set from turning the worker into a hot loop while still
      // allowing a large queue to drain over subsequent polls.
      .slice(0, Math.max(requestedLimit, 100))

    const queued: string[] = []
    const stale: string[] = []
    await Promise.all(
      ids.map(async (executionId) => {
        const raw = await this.redis.get<unknown>(ttyExecutionJobKey(executionId as TTYExecutionId))
        let parsed: unknown
        try {
          parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
        } catch {
          parsed = null
        }
        const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
        const job =
          record && typeof record.job === 'object' && record.job !== null
            ? (record.job as Record<string, unknown>)
            : record
        if (job && job.status === 'queued' && typeof job.sessionId === 'string' && job.sessionId.length > 0)
          queued.push(executionId)
        else stale.push(executionId)
      }),
    )
    if (stale.length > 0) {
      await this.redis.srem(ttyPendingExecutionIndexKey(), ...stale)
      for (const executionId of stale) this.pending.delete(executionId)
      workerLogger('info', 'stale_pending_executions_pruned', { count: stale.length })
    }
    return queued.slice(0, requestedLimit)
  }

  async subscribe(
    onPendingExecutionIds: (executionIds: readonly string[]) => Promise<void> | void,
  ): Promise<() => void> {
    if (!this.redis.subscribeToStream) return () => undefined
    const deliver = (cursor: string, fields: unknown) => {
      if (this.seenCursors.has(cursor)) return
      this.seenCursors.add(cursor)
      const parsed = normalizeTTYRedisStreamFields(fields)
      const executionId = typeof parsed?.executionId === 'string' ? parsed.executionId : null
      if (!executionId) return
      this.pending.add(executionId)
      void onPendingExecutionIds([executionId])
    }
    const cleanup = await this.redis.subscribeToStream(ttyPendingExecutionStreamKey(), (payload) => {
      deliver(payload.streamId, payload.fields)
    })
    const historical = normalizeTTYRedisStreamEntries(
      await this.redis.xrange(ttyPendingExecutionStreamKey(), '-', '+', 10_000),
    )
    for (const entry of historical) {
      if (typeof entry[0] === 'string') deliver(entry[0], entry[1])
    }
    return cleanup
  }
}

async function resolveSessionId(redis: TTYRuntimeStore, executionId: TTYExecutionId): Promise<TTYSessionId | null> {
  try {
    const raw = await redis.get<unknown>(ttyExecutionJobKey(executionId))
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    // Jobs admitted before the queue-contract fix were stored as
    // { job, fingerprint }. Accept that shape once so they can be claimed and
    // normalized to the canonical top-level job record by the lease script.
    const job = typeof record.job === 'object' && record.job !== null ? (record.job as Record<string, unknown>) : record
    const sessionId = job.sessionId
    return typeof sessionId === 'string' && sessionId.length > 0 ? (sessionId as TTYSessionId) : null
  } catch {
    return null
  }
}

function workerContext(
  token: string,
  secret: string,
  workerId: ReturnType<typeof createTTYWorkerId>,
): TTYWorkerAuthContext {
  const verification = verifyWorkerToken(token, secret)
  if (!verification.valid) throw new Error(`Worker token could not be verified: ${verification.reason}`)
  return {
    workerId,
    capability: 'execute',
    tokenId: verification.tokenId,
    authenticatedAt: new Date(verification.issuedAtMs).toISOString(),
    expiresAt: new Date(verification.expiresAtMs).toISOString(),
  }
}

async function main(): Promise<void> {
  const redis = createSupabaseRuntimeStore()
  const workerId = createTTYWorkerId(requiredEnv('TTY_EXECUTION_WORKER_ID'))
  const secret = requiredEnv('TTY_WORKER_AUTH_SECRET')
  const version = process.env.HEXICAL_WORKER_VERSION?.trim() || DEFAULT_VERSION
  const token = issueTTYWorkerToken(workerId, 'execute', secret, {
    ttlMs: positiveInteger('TTY_WORKER_TOKEN_TTL_MS', DEFAULT_TOKEN_TTL_MS),
  })
  const context = workerContext(token, secret, workerId)
  const audit = new TTYWorkerAudit(redis)
  const registry = new TTYWorkerRegistry(redis, { audit })
  const authenticator = new TTYWorkerAuthenticator(registry, secret, { audit })
  const heartbeat = new TTYWorkerHeartbeatService(redis, registry, { audit })
  const observer = new TTYWorkerLeaseObserver(redis, { audit })
  const sessionStore = createTTYSessionStore(redis)
  requiredTrue('TTY_PERSISTENT_PTY_ENABLED')
  if (requiredEnv('TTY_RUNTIME_BACKEND') !== 'tmux')
    throw new Error('TTY_RUNTIME_BACKEND must be tmux; the worker has no subprocess fallback.')
  const ptyEnvironment = {
    PATH: requiredEnv('TTY_PTY_PATH'),
    TERM: 'xterm-256color',
    LANG: process.env.TTY_PTY_LANG?.trim() || 'C.UTF-8',
  }
  const tmuxAdapter = await createNodePtyTmuxAdapter({ adminEnv: ptyEnvironment })
  const tmuxRuntime = new TTYTmuxRuntime(tmuxAdapter, {
    rootDir: requiredEnv('TTY_PTY_WORKSPACE_ROOT'),
    baseEnv: ptyEnvironment,
  })
  const streamBroker = new TTYStreamBroker(redis as unknown as TTYStreamRedis)
  const executionOutput = new TTYStreamingOutputStreamManager(redis, streamBroker)
  const sessionTranscript = new TTYSessionTranscriptManager(redis)
  const persistentSessionManager = new TTYPersistentSessionManager(
    redis,
    tmuxRuntime,
    sessionStore,
    sessionTranscript,
    workerId,
    {
      leaseTtlMs: positiveInteger('TTY_PTY_LEASE_TTL_MS', 30_000),
      heartbeatIntervalMs: positiveInteger('TTY_PTY_HEARTBEAT_INTERVAL_MS', 5_000),
      journalPollIntervalMs: positiveInteger('TTY_PTY_JOURNAL_POLL_INTERVAL_MS', 100),
      telemetryIntervalMs: positiveInteger('TTY_PTY_TELEMETRY_INTERVAL_MS', 5_000),
      executionOutput,
    },
  )
  const sessionControlRouter = new TTYSessionControlRouter(redis, workerId, persistentSessionManager)
  const globalSessionControl = new TTYSessionControlConsumer(
    redis,
    `${workerId}:global-session-control`,
    sessionControlRouter,
  )
  const workerSessionControl = new TTYSessionControlConsumer(
    redis,
    `${workerId}:target-session-control`,
    sessionControlRouter,
    {
      streamKey: ttyWorkerSessionControlStreamKey(workerId),
      group: ttyWorkerSessionControlGroup(),
    },
  )
  // This is intentionally not TTYProcessRuntime. Every admitted argv is
  // written into the manager-owned tmux shell, so cwd/env/history/process
  // state survives commands and worker attachment changes.
  const processRuntime = new TTYPersistentProcessRuntime(persistentSessionManager)
  // The durable output stream is authoritative, but the browser subscribes to
  // the separate live stream. The bridge writes both in order so an execution
  // is observable while it runs and remains replayable after completion.
  const leaseManager = new TTYExecutionLeaseManager(redis, context, { observer })
  const coordinator = new TTYExecutionCoordinator({
    redis,
    workerId,
    sessionStore,
    leaseManager,
    processRuntime,
    resourceGuard: new TTYResourceGuard({
      maxConcurrentProcesses: positiveInteger('TTY_MAX_CONCURRENT_PROCESSES', 1),
      maxStdoutBytesPerSecond: positiveInteger('TTY_MAX_STDOUT_BYTES_PER_SECOND', 1_048_576),
      maxStderrBytesPerSecond: positiveInteger('TTY_MAX_STDERR_BYTES_PER_SECOND', 1_048_576),
    }),
    outputStream: executionOutput,
    audit,
    virtualSessionUtilities: false,
  })
  const persistentRecovery = new TTYPersistentRecoveryService(workerId, persistentSessionManager, leaseManager, {
    scanIntervalMs: positiveInteger('TTY_PERSISTENT_RECOVERY_SCAN_INTERVAL_MS', 5_000),
    coordinator,
    processRuntime,
    logger: {
      info: (event, fields) => workerLogger('info', event, fields),
      warn: (event, fields) => workerLogger('warn', event, fields),
      error: (event, fields) => workerLogger('error', event, fields),
    },
  })
  const claim = createTTYWorkerClaimService({
    workerId,
    leaseManager,
    observer,
    resolveSessionId: (executionId) => resolveSessionId(redis, executionId),
  })
  const poller = createTTYWorkerPoller({
    queue: new SupabasePendingExecutionQueue(redis),
    onPendingExecutionIds: (executionIds) => executor.handlePendingExecutionIds(executionIds),
    baseIntervalMs: positiveInteger('TTY_WORKER_POLL_INTERVAL_MS', 1_000),
    maxIntervalMs: positiveInteger('TTY_WORKER_MAX_POLL_INTERVAL_MS', 15_000),
  })
  // Legacy orphan-process recovery is deliberately not wired here: its
  // contract kills a process and requeues work, which would duplicate a live
  // tmux command. Persistent recovery adopts expired leases using the durable
  // PTY command record and reattaches the existing tmux session.
  const executor = new TTYWorkerExecutor({ workerId, poller, claim, coordinator })
  const daemon = new TTYWorkerDaemon({
    registry,
    authenticator,
    heartbeat,
    token,
    registration: {
      workerId,
      identity: workerId,
      version,
      capabilities: ['execute', 'persistent_pty'],
      metadata: { runtime: 'node', platform: process.platform, ptyBackend: 'tmux' },
    },
    requiredCapability: 'execute',
    recovery: persistentRecovery,
  })

  await persistentSessionManager.start()
  await daemon.start()
  await globalSessionControl.start()
  await workerSessionControl.start()
  await executor.start()
  workerLogger('info', 'worker_ready', { workerId, version, ptyBackend: 'tmux' })

  let shuttingDown = false
  const shutdown = async (signal: 'SIGINT' | 'SIGTERM') => {
    if (shuttingDown) return
    shuttingDown = true
    workerLogger('info', 'worker_shutdown_started', { workerId, signal })
    await globalSessionControl.stop()
    await workerSessionControl.stop()
    await executor.stop()
    await daemon.stop(signal)
    await persistentSessionManager.stop()
    workerLogger('info', 'worker_shutdown_completed', { workerId, signal })
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  workerLogger('error', 'worker_start_failed', {
    message: error instanceof Error ? error.message : String(error),
  })
  process.exitCode = 1
})
