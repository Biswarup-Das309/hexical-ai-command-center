import 'server-only'

import { Redis } from '@upstash/redis'
import { isTTYExecutionState, type TTYExecutionStateRecord } from './tty-execution-state'
import { createTTYSessionStore } from './tty-session-store'
import { TTYSSEManager } from './tty-sse-manager'
import { TTYStreamAuthorizer } from './tty-stream-auth'
import { TTYStreamBroker, type TTYStreamRedis } from './tty-stream-broker'
import type { TTYExecutionId, TTYSessionId } from './tty-types'
import { ttyExecutionStateKey } from './tty-worker-keys'

interface TTYStreamServerRuntime {
  readonly redis: Redis
  readonly manager: TTYSSEManager
}

let runtime: TTYStreamServerRuntime | null = null

function createRedis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('TTY stream Redis configuration is missing.')
  return new Redis({ url, token })
}

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

function createRuntime(): TTYStreamServerRuntime {
  const redis = createRedis()
  const store = createTTYSessionStore(redis)
  const broker = new TTYStreamBroker(redis as unknown as TTYStreamRedis)
  const authorizer = new TTYStreamAuthorizer({
    getExecutionState: async (executionId: TTYExecutionId) =>
      parseExecutionState(await redis.get<unknown>(ttyExecutionStateKey(executionId))),
    getSession: (sessionId: TTYSessionId, userId: string) => store.getSession(sessionId, userId),
  })
  return { redis, manager: new TTYSSEManager(broker, authorizer) }
}

export function createTTYStreamManagerForRequest(): TTYSSEManager {
  runtime ??= createRuntime()
  return runtime.manager
}
