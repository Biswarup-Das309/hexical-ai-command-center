import 'server-only'

import { createSupabaseRuntimeStore } from './supabase-runtime-store'
import { isTTYExecutionState, type TTYExecutionStateRecord } from './tty-execution-state'
import { createTTYSessionStore } from './tty-session-store'
import { TTYSSEManager } from './tty-sse-manager'
import { TTYStreamAuthorizer } from './tty-stream-auth'
import { TTYStreamBroker, type TTYStreamRedis } from './tty-stream-broker'
import type { TTYExecutionId, TTYSessionId } from './tty-types'
import { ttyExecutionJobKey, ttyExecutionStateKey } from './tty-worker-keys'

interface TTYStreamServerRuntime {
  readonly redis: TTYStreamRedis
  readonly manager: TTYSSEManager
}

let runtime: TTYStreamServerRuntime | null = null

function parseExecutionState(raw: unknown): TTYExecutionStateRecord | null {
  try {
    const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (typeof value !== 'object' || value === null) return null
    const record = value as Record<string, unknown>
    if (
      typeof record.executionId !== 'string' ||
      typeof record.sessionId !== 'string' ||
      typeof record.state !== 'string' ||
      !isTTYExecutionState(record.state)
    )
      return null
    return record as unknown as TTYExecutionStateRecord
  } catch {
    return null
  }
}

function parseQueuedExecutionSessionId(raw: unknown): TTYSessionId | null {
  try {
    const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (typeof value !== 'object' || value === null) return null
    const record = value as Record<string, unknown>
    const job = typeof record.job === 'object' && record.job !== null ? (record.job as Record<string, unknown>) : record
    return typeof job.sessionId === 'string' && job.sessionId.length > 0 ? (job.sessionId as TTYSessionId) : null
  } catch {
    return null
  }
}

function createRuntime(): TTYStreamServerRuntime {
  const redis = createSupabaseRuntimeStore()
  const store = createTTYSessionStore(redis)
  const broker = new TTYStreamBroker(redis as unknown as TTYStreamRedis)
  const authorizer = new TTYStreamAuthorizer({
    getExecutionState: async (executionId: TTYExecutionId) =>
      parseExecutionState(await redis.get<unknown>(ttyExecutionStateKey(executionId))),
    getQueuedExecutionSessionId: async (executionId: TTYExecutionId) =>
      parseQueuedExecutionSessionId(await redis.get<unknown>(ttyExecutionJobKey(executionId))),
    getSession: (sessionId: TTYSessionId, userId: string) => store.getSession(sessionId, userId),
  })
  return { redis, manager: new TTYSSEManager(broker, authorizer) }
}

export function createTTYStreamManagerForRequest(): TTYSSEManager {
  runtime ??= createRuntime()
  return runtime.manager
}
