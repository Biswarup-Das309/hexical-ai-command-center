import 'server-only'

import { auth } from '@clerk/nextjs/server'
import { Redis } from '@upstash/redis'

import { createTTYAdmissionApiForRequest } from '@/lib/tty/tty-execution-admission-server'
import { TTYExecutionApi } from '@/lib/tty/tty-execution-api'
import { isTTYExecutionState, type TTYExecutionStateRecord } from '@/lib/tty/tty-execution-state'
import { TTYOutputStreamManager } from '@/lib/tty/tty-output-stream'
import { createTTYSessionStore } from '@/lib/tty/tty-session-store'
import { ttyExecutionStateKey } from '@/lib/tty/tty-worker-keys'
import { createInvestigationApi, createInvestigationExecutionApi } from './investigation-api'
import { InvestigationExecutionSynchronizer } from './investigation-execution-sync'
import { InvestigationStore, type InvestigationRedis } from './investigation-store'

export function createRedis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('Investigation Redis configuration is missing.')
  return new Redis({ url, token })
}

export function createInvestigationRedis(redis: Redis): InvestigationRedis {
  return {
    get: <T>(key: string) => redis.get<T>(key),
    set: (key, value, options) => options?.nx ? redis.set(key, value, { nx: true }) : redis.set(key, value),
    del: (...keys) => redis.del(...keys),
    incr: key => redis.incr(key),
    sadd: (key, member) => redis.sadd(key, member),
    srem: (key, member) => redis.srem(key, member),
    zadd: (key, value) => redis.zadd(key, value),
    zrange: <T extends unknown[]>(key: string, min: number, max: number, options: { readonly rev?: boolean; readonly offset: number; readonly count: number }) => redis.zrange<T>(key, min, max, options),
    zrem: (key, member) => redis.zrem(key, member),
    xadd: (key, id, fields) => redis.xadd(key, id, fields),
    xrange: (key, start, end, count) => count === undefined ? redis.xrange(key, start, end) : redis.xrange(key, start, end, count)
  }
}

function parseExecutionState(raw: unknown): TTYExecutionStateRecord | null {
  try {
    const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (typeof value !== 'object' || value === null) return null
    const record = value as Record<string, unknown>
    return typeof record.executionId === 'string' && typeof record.sessionId === 'string' && typeof record.state === 'string' && isTTYExecutionState(record.state) ? record as unknown as TTYExecutionStateRecord : null
  } catch {
    return null
  }
}

export function createInvestigationApiForRequest() {
  const redis = createRedis()
  const store = new InvestigationStore(createInvestigationRedis(redis))
  const sessionStore = createTTYSessionStore(redis)
  const executionApi = new TTYExecutionApi({
    getState: async executionId => parseExecutionState(await redis.get<unknown>(ttyExecutionStateKey(executionId))),
    outputStream: new TTYOutputStreamManager(redis),
    sessionStore
  })
  const synchronizer = new InvestigationExecutionSynchronizer(store, {
    getExecution: (executionId, ownerUserId) => executionApi.getExecution(executionId as never, ownerUserId),
    getOutput: (executionId, ownerUserId, options) => executionApi.getOutput(executionId as never, ownerUserId, options)
  })
  return createInvestigationApi({
    authenticate: async () => (await auth()).userId ?? null,
    getStore: () => store,
    synchronize: (ownerUserId, investigationId) => synchronizer.synchronize(ownerUserId, investigationId)
  })
}

export function createInvestigationExecutionApiForRequest() {
  const redis = createRedis()
  return createInvestigationExecutionApi({
    authenticate: async () => (await auth()).userId ?? null,
    getStore: () => new InvestigationStore(createInvestigationRedis(redis)),
    admitExecution: (request, sessionId) => createTTYAdmissionApiForRequest().admit(request, sessionId)
  })
}
