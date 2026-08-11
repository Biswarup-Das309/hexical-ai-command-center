import { Redis } from '@upstash/redis'
import { TTYExecutionCoordinator } from '../lib/tty/tty-execution-coordinator'
import { TTYExecutionLeaseManager } from '../lib/tty/tty-execution-lease'
import { createDefaultTTYProcessRuntime } from '../lib/tty/tty-process-runtime'
import { TTYRecoveryManager } from '../lib/tty/tty-recovery'
import { TTYResourceGuard } from '../lib/tty/tty-resource-guard'
import { createTTYSessionStore } from '../lib/tty/tty-session-store'
import { TTYStreamBroker, type TTYStreamRedis } from '../lib/tty/tty-stream-broker'
import { TTYStreamingOutputStreamManager } from '../lib/tty/tty-stream-runtime-bridge'
import type { TTYExecutionId, TTYSessionId } from '../lib/tty/tty-types'
import { TTYWorkerAudit } from '../lib/tty/tty-worker-audit'
import { TTYWorkerAuthenticator, issueTTYWorkerToken, verifyWorkerToken } from '../lib/tty/tty-worker-auth'
import { createTTYWorkerClaimService } from '../lib/tty/tty-worker-claim'
import { TTYWorkerDaemon } from '../lib/tty/tty-worker-daemon'
import { TTYWorkerExecutor } from '../lib/tty/tty-worker-executor'
import { TTYWorkerHeartbeatService } from '../lib/tty/tty-worker-heartbeat'
import { ttyExecutionJobKey, ttyPendingExecutionIndexKey } from '../lib/tty/tty-worker-keys'
import { TTYWorkerLeaseObserver } from '../lib/tty/tty-worker-observer'
import { createTTYWorkerPoller, type PendingExecutionQueue } from '../lib/tty/tty-worker-poller'
import { createTTYWorkerRecoveryService } from '../lib/tty/tty-worker-recovery'
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

function workerLogger(level: 'info' | 'warn' | 'error', event: string, fields: Readonly<Record<string, unknown>> = {}) {
  const entry = JSON.stringify({ component: 'hexical-tty-worker', level, event, ...fields })
  if (level === 'error') console.error(entry)
  else if (level === 'warn') console.warn(entry)
  else console.info(entry)
}

class RedisPendingExecutionQueue implements PendingExecutionQueue {
  constructor(private readonly redis: Redis) {}

  async listPendingExecutionIds(limit: number): Promise<readonly string[]> {
    const ids = await this.redis.smembers(ttyPendingExecutionIndexKey())
    return [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))].slice(0, Math.max(0, Math.floor(limit)))
  }
}

async function resolveSessionId(redis: Redis, executionId: TTYExecutionId): Promise<TTYSessionId | null> {
  const raw = await redis.get<unknown>(ttyExecutionJobKey(executionId))
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (typeof parsed !== 'object' || parsed === null) return null
  const sessionId = (parsed as Record<string, unknown>).sessionId
  return typeof sessionId === 'string' && sessionId.length > 0 ? (sessionId as TTYSessionId) : null
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
  const redis = new Redis({
    url: requiredEnv('UPSTASH_REDIS_REST_URL'),
    token: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
  })
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
  const processRuntime = createDefaultTTYProcessRuntime({ rootDir: process.env.TTY_RUNTIME_ROOT })
  // The durable output stream is authoritative, but the browser subscribes to
  // the separate live stream. The bridge writes both in order so an execution
  // is observable while it runs and remains replayable after completion.
  const streamBroker = new TTYStreamBroker(redis as unknown as TTYStreamRedis)
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
    outputStream: new TTYStreamingOutputStreamManager(redis, streamBroker),
    audit,
  })
  const recoveryManager = new TTYRecoveryManager(redis, processRuntime)
  const recovery = createTTYWorkerRecoveryService({
    redis: {
      smembers: async (key) => (await redis.smembers(key)).map((value) => String(value)),
    },
    orphanRecovery: recoveryManager,
    coordinator,
    observer,
  })
  const claim = createTTYWorkerClaimService({
    workerId,
    leaseManager,
    observer,
    resolveSessionId: (executionId) => resolveSessionId(redis, executionId),
  })
  const poller = createTTYWorkerPoller({
    queue: new RedisPendingExecutionQueue(redis),
    onPendingExecutionIds: (executionIds) => executor.handlePendingExecutionIds(executionIds),
    baseIntervalMs: positiveInteger('TTY_WORKER_POLL_INTERVAL_MS', 1_000),
    maxIntervalMs: positiveInteger('TTY_WORKER_MAX_POLL_INTERVAL_MS', 15_000),
  })
  const executor = new TTYWorkerExecutor({ workerId, poller, claim, coordinator, recovery })
  const daemon = new TTYWorkerDaemon({
    registry,
    authenticator,
    heartbeat,
    token,
    registration: {
      workerId,
      identity: workerId,
      version,
      capabilities: ['execute'],
      metadata: { runtime: 'node', platform: process.platform },
    },
    requiredCapability: 'execute',
  })

  await daemon.start()
  await executor.start()
  workerLogger('info', 'worker_ready', { workerId, version })

  let shuttingDown = false
  const shutdown = async (signal: 'SIGINT' | 'SIGTERM') => {
    if (shuttingDown) return
    shuttingDown = true
    workerLogger('info', 'worker_shutdown_started', { workerId, signal })
    await executor.stop()
    await daemon.stop(signal)
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
