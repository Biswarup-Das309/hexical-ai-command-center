import 'server-only'

import { Redis } from '@upstash/redis'
import { log } from '@/lib/hexical/telemetry'
import { recordActivationLatency, recordActivationTimeout } from './tty-activation-metrics'
import { TTYExecutionCoordinator, type TTYExecutionCoordinatorFailureReason } from './tty-execution-coordinator'
import { TTYExecutionLeaseManager } from './tty-execution-lease'
import { TTYOutputStreamManager } from './tty-output-stream'
import { createDefaultTTYProcessRuntime } from './tty-process-runtime'
import { TTYResourceGuard } from './tty-resource-guard'
import { createTTYSessionStore } from './tty-session-store'
import type { TTYExecutionId, TTYSessionId } from './tty-types'
import { createTTYWorkerId, type TTYWorkerAuthContext } from './tty-worker-types'

const WORKER_CONTEXT_TTL_MS = 365 * 24 * 60 * 60 * 1_000
const DEFAULT_MAX_OUTPUT_BYTES_PER_SECOND = 1_048_576

/**
 * Hard ceiling on how long activateTTYExecution() will wait for the coordinator
 * to either accept (transition to 'leased') or fail fast (resource_denied,
 * session_terminated, invalid_job, etc.). This exists because every step
 * between here and 'leased' is a single Upstash REST round trip with no
 * client-side timeout of its own — if one of those calls stalls on the
 * network, the coordinator's promise never settles, and without this bound
 * the caller would block until an upstream platform/gateway timeout kills
 * the request with a bare, undiagnosable 503. This turns that failure mode
 * into a deterministic, logged one instead.
 */
const DEFAULT_ACTIVATION_TIMEOUT_MS = 8_000

export interface TTYExecutionActivationResult {
  readonly accepted: boolean
  readonly state: Awaited<ReturnType<TTYExecutionCoordinator['getState']>>
  readonly reason?: TTYExecutionCoordinatorFailureReason
}

interface TTYExecutionActivationRuntime {
  readonly coordinator: TTYExecutionCoordinator
}

let runtime: TTYExecutionActivationRuntime | null = null

function requiredRedis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('TTY execution Redis configuration is missing.')
  return new Redis({ url, token })
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function workerContext(): TTYWorkerAuthContext {
  const workerId = createTTYWorkerId(process.env.TTY_EXECUTION_WORKER_ID ?? `web-execution-${process.pid}`)
  const now = Date.now()
  return {
    workerId,
    capability: 'execute',
    tokenId: `web-execution:${workerId}`,
    authenticatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + WORKER_CONTEXT_TTL_MS).toISOString(),
  }
}

function createRuntime(): TTYExecutionActivationRuntime {
  const redis = requiredRedis()
  const sessionStore = createTTYSessionStore(redis)
  const context = workerContext()
  const coordinator = new TTYExecutionCoordinator({
    redis,
    workerId: context.workerId,
    sessionStore,
    leaseManager: new TTYExecutionLeaseManager(redis, context),
    processRuntime: createDefaultTTYProcessRuntime({ rootDir: process.env.TTY_RUNTIME_ROOT }),
    resourceGuard: new TTYResourceGuard({
      maxConcurrentProcesses: positiveInteger(process.env.TTY_MAX_CONCURRENT_PROCESSES, 1),
      maxStdoutBytesPerSecond: positiveInteger(
        process.env.TTY_MAX_STDOUT_BYTES_PER_SECOND,
        DEFAULT_MAX_OUTPUT_BYTES_PER_SECOND,
      ),
      maxStderrBytesPerSecond: positiveInteger(
        process.env.TTY_MAX_STDERR_BYTES_PER_SECOND,
        DEFAULT_MAX_OUTPUT_BYTES_PER_SECOND,
      ),
    }),
    outputStream: new TTYOutputStreamManager(redis),
  })
  return { coordinator }
}

function getRuntime(): TTYExecutionActivationRuntime {
  runtime ??= createRuntime()
  return runtime
}

/**
 * Starts a queued execution without holding the HTTP request open for the
 * process lifetime. The promise resolves as soon as one of three things
 * happens, whichever comes first:
 *  - the coordinator claims the job and persists its first accepted state
 *    ('leased'), or
 *  - the coordinator fails fast (resource_denied, session_terminated,
 *    invalid_job, unauthorized_worker, etc.), or
 *  - DEFAULT_ACTIVATION_TIMEOUT_MS elapses with neither of the above having
 *    happened, in which case this resolves with accepted:false,
 *    reason:'internal_error' and the underlying run() is left to continue
 *    and settle on its own — it is not cancelled, since a spawned process
 *    must not be abandoned mid-flight, but the caller is no longer blocked
 *    waiting on it.
 * Every phase is logged with executionId/sessionId and elapsed time so a
 * stall can be attributed to "claim never returned" vs. "claimed but never
 * transitioned" vs. "transitioned but activator never observed it" instead
 * of showing up as an opaque timeout with no diagnostic value.
 */
export async function activateTTYExecution(
  rawExecutionId: string,
  rawSessionId: string,
): Promise<TTYExecutionActivationResult> {
  const executionId = rawExecutionId as TTYExecutionId
  const sessionId = rawSessionId as TTYSessionId
  const startedAt = Date.now()
  const elapsed = () => Date.now() - startedAt
  log.info('tty.activation.requested', { executionId, sessionId })

  const coordinator = getRuntime().coordinator
  const existing = await coordinator.getState(executionId)
  if (existing && existing.state !== 'queued') {
    log.info('tty.activation.already_settled', { executionId, sessionId, state: existing.state, elapsedMs: elapsed() })
    return { accepted: true, state: existing }
  }

  let resolveAccepted!: (result: TTYExecutionActivationResult) => void
  const accepted = new Promise<TTYExecutionActivationResult>((resolve) => {
    resolveAccepted = resolve
  })
  let settled = false
  const settle = (result: TTYExecutionActivationResult, phase: string) => {
    if (settled) return
    settled = true
    const elapsedMs = elapsed()
    log.info('tty.activation.settled', {
      executionId,
      sessionId,
      phase,
      accepted: result.accepted,
      reason: result.reason,
      state: result.state?.state ?? null,
      elapsedMs,
    })
    recordActivationLatency(elapsedMs)
    resolveAccepted(result)
  }

  const run = coordinator.run(executionId, sessionId, {
    onAccepted: (state) => {
      log.info('tty.activation.leased', { executionId, sessionId, elapsedMs: elapsed() })
      settle({ accepted: true, state }, 'leased')
    },
  })
  void run
    .then((result) => {
      if (result.accepted) settle({ accepted: true, state: result.state }, 'run_completed')
      else settle({ accepted: false, state: result.state, reason: result.reason }, 'run_rejected')
    })
    .catch((error) => {
      log.error('tty.activation.run_threw', {
        executionId,
        sessionId,
        elapsedMs: elapsed(),
        message: error instanceof Error ? error.message : String(error),
      })
      settle({ accepted: false, state: null, reason: 'internal_error' }, 'run_threw')
    })

  const timeout = new Promise<TTYExecutionActivationResult>((resolve) => {
    setTimeout(() => {
      if (settled) return
      log.warn('tty.activation.timeout', {
        executionId,
        sessionId,
        elapsedMs: elapsed(),
        timeoutMs: DEFAULT_ACTIVATION_TIMEOUT_MS,
      })
      recordActivationTimeout()
      resolve({ accepted: false, state: null, reason: 'internal_error' })
    }, DEFAULT_ACTIVATION_TIMEOUT_MS)
  })

  return Promise.race([accepted, timeout])
}

/** Owner-authorized repair hook for a stale running/leased execution. It is
 * deliberately conservative: queued and terminal executions are returned as
 * is, while only an active execution is handed to the coordinator's fenced
 * lease recovery path. */
export async function repairTTYExecution(
  rawExecutionId: string,
  rawSessionId: string,
): Promise<{ readonly repaired: boolean; readonly state: Awaited<ReturnType<TTYExecutionCoordinator['getState']>> }> {
  const executionId = rawExecutionId as TTYExecutionId
  const sessionId = rawSessionId as TTYSessionId
  const coordinator = getRuntime().coordinator
  const current = await coordinator.getState(executionId)
  if (
    current === null ||
    current.sessionId !== sessionId ||
    current.state === 'queued' ||
    current.state === 'succeeded' ||
    current.state === 'failed' ||
    current.state === 'cancelled' ||
    current.state === 'timed_out' ||
    current.state === 'expired'
  ) {
    return { repaired: false, state: current }
  }
  const recovered = await coordinator.recoverExecution(executionId, sessionId)
  return { repaired: recovered?.state === 'queued', state: recovered }
}
