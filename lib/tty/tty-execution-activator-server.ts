import 'server-only'

import { Redis } from '@upstash/redis'

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
    expiresAt: new Date(now + WORKER_CONTEXT_TTL_MS).toISOString()
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
      maxStdoutBytesPerSecond: positiveInteger(process.env.TTY_MAX_STDOUT_BYTES_PER_SECOND, DEFAULT_MAX_OUTPUT_BYTES_PER_SECOND),
      maxStderrBytesPerSecond: positiveInteger(process.env.TTY_MAX_STDERR_BYTES_PER_SECOND, DEFAULT_MAX_OUTPUT_BYTES_PER_SECOND)
    }),
    outputStream: new TTYOutputStreamManager(redis)
  })
  return { coordinator }
}

function getRuntime(): TTYExecutionActivationRuntime {
  runtime ??= createRuntime()
  return runtime
}

/**
 * Starts a queued execution without holding the HTTP request open for the
 * process lifetime. The promise resolves only after the coordinator has
 * claimed the job and persisted its first accepted state.
 */
export async function activateTTYExecution(rawExecutionId: string, rawSessionId: string): Promise<TTYExecutionActivationResult> {
  const executionId = rawExecutionId as TTYExecutionId
  const sessionId = rawSessionId as TTYSessionId
  const coordinator = getRuntime().coordinator
  const existing = await coordinator.getState(executionId)
  if (existing && existing.state !== 'queued') return { accepted: true, state: existing }

  let resolveAccepted!: (result: TTYExecutionActivationResult) => void
  const accepted = new Promise<TTYExecutionActivationResult>(resolve => { resolveAccepted = resolve })
  let settled = false
  const settle = (result: TTYExecutionActivationResult) => {
    if (settled) return
    settled = true
    resolveAccepted(result)
  }

  const run = coordinator.run(executionId, sessionId, {
    onAccepted: state => settle({ accepted: true, state })
  })
  void run.then(result => {
    if (result.accepted) settle({ accepted: true, state: result.state })
    else settle({ accepted: false, state: result.state, reason: result.reason })
  }).catch(() => {
    settle({ accepted: false, state: null, reason: 'internal_error' })
  })

  return accepted
}
