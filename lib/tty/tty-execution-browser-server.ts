import 'server-only'

import { createSupabaseRuntimeStore } from './supabase-runtime-store'
import { TTYExecutionApi } from './tty-execution-api'
import { isTTYExecutionState, type TTYExecutionStateRecord } from './tty-execution-state'
import { TTYOutputStreamManager } from './tty-output-stream'
import { createTTYSessionStore } from './tty-session-store'
import { ttyExecutionStateKey } from './tty-worker-keys'

function parseExecutionState(raw: unknown): TTYExecutionStateRecord | null {
  try {
    const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (typeof value !== 'object' || value === null) return null
    const record = value as Record<string, unknown>
    return typeof record.executionId === 'string' &&
      typeof record.sessionId === 'string' &&
      typeof record.state === 'string' &&
      isTTYExecutionState(record.state)
      ? (record as unknown as TTYExecutionStateRecord)
      : null
  } catch {
    return null
  }
}

export function createTTYExecutionBrowserApiForRequest(): TTYExecutionApi {
  const redis = createSupabaseRuntimeStore()
  return new TTYExecutionApi({
    getState: async (executionId) => parseExecutionState(await redis.get<unknown>(ttyExecutionStateKey(executionId))),
    outputStream: new TTYOutputStreamManager(redis),
    sessionStore: createTTYSessionStore(redis),
  })
}
