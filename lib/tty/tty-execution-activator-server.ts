import 'server-only'

import { Redis } from '@upstash/redis'

import { log } from '@/lib/hexical/telemetry'

import { TTYExecutionCoordinator } from './tty-execution-coordinator'
import { TTYExecutionActivator, type TTYExecutionActivationResult } from './tty-execution-activator'
import { TTYExecutionLeaseManager } from './tty-execution-lease'
import { createDefaultTTYProcessRuntime } from './tty-process-runtime'
import { TTYResourceGuard } from './tty-resource-guard'
import { createTTYSessionStore } from './tty-session-store'
import { TTYStreamBroker, type TTYStreamRedis } from './tty-stream-broker'
import { TTYStreamingOutputStreamManager } from './tty-stream-runtime-bridge'
import { createTTYWorkerId, type TTYWorkerAuthContext } from './tty-worker-types'

const WORKER_CONTEXT_TTL_MS = 365 * 24 * 60 * 60 * 1_000
const DEFAULT_MAX_OUTPUT_BYTES_PER_SECOND = 1_048_576
interface TTYExecutionActivationRuntime {
  readonly activator: TTYExecutionActivator
}
export { TTYExecutionActivator, type TTYExecutionActivationResult, type TTYExecutionActivatorDependencies } from './tty-execution-activator'

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
  const broker = new TTYStreamBroker(redis as unknown as TTYStreamRedis)
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
    outputStream: new TTYStreamingOutputStreamManager(redis, broker)
  })
  return {
    activator: new TTYExecutionActivator({
      coordinator,
      onFailure: ({ executionId, sessionId, reason, phase }) => {
        log.error('tty.execution.activation_failed', { executionId, sessionId, reason, phase })
      }
    })
  }
}

function getRuntime(): TTYExecutionActivationRuntime {
  runtime ??= createRuntime()
  return runtime
}

export async function activateTTYExecution(executionId: string, sessionId: string): Promise<TTYExecutionActivationResult> {
  return getRuntime().activator.activate(executionId, sessionId)
}
