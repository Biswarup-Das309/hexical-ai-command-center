import 'server-only'

import { auth } from '@clerk/nextjs/server'
import { Redis } from '@upstash/redis'
import { activateTTYExecution } from '@/lib/tty/tty-execution-activator-server'
import { createTTYAdmissionApiForRequest } from '@/lib/tty/tty-execution-admission-server'
import { TTYExecutionApi } from '@/lib/tty/tty-execution-api'
import { isTTYExecutionState, type TTYExecutionStateRecord } from '@/lib/tty/tty-execution-state'
import { createTTYLifecycleApiForRequest } from '@/lib/tty/tty-lifecycle-server'
import { TTYOutputStreamManager } from '@/lib/tty/tty-output-stream'
import { createTTYSessionStore } from '@/lib/tty/tty-session-store'
import { ttyExecutionStateKey } from '@/lib/tty/tty-worker-keys'
import {
  createInvestigationApi,
  createInvestigationExecutionApi,
  createInvestigationSessionApi,
} from './investigation-api'
import { InvestigationExecutionSynchronizer } from './investigation-execution-sync'
import { createInvestigationLogger } from './investigation-logger'
import { InvestigationStore, type InvestigationRedis } from './investigation-store'

const investigationLogger = createInvestigationLogger()

export function createRedis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('Investigation Redis configuration is missing.')
  return new Redis({ url, token })
}

export function createInvestigationRedis(redis: Redis): InvestigationRedis {
  return {
    get: <T>(key: string) => redis.get<T>(key),
    set: (key, value, options) => (options?.nx ? redis.set(key, value, { nx: true }) : redis.set(key, value)),
    del: (...keys) => redis.del(...keys),
    incr: (key) => redis.incr(key),
    sadd: (key, member) => redis.sadd(key, member),
    srem: (key, member) => redis.srem(key, member),
    zadd: (key, value) => redis.zadd(key, value),
    zrange: <T extends unknown[]>(
      key: string,
      min: number,
      max: number,
      options: { readonly rev?: boolean; readonly offset: number; readonly count: number },
    ) => redis.zrange<T>(key, min, max, options),
    zrem: (key, member) => redis.zrem(key, member),
    xadd: (key, id, fields) => redis.xadd(key, id, fields),
    xrange: (key, start, end, count) =>
      count === undefined ? redis.xrange(key, start, end) : redis.xrange(key, start, end, count),
  }
}

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

export function createInvestigationApiForRequest() {
  const redis = createRedis()
  const store = new InvestigationStore(createInvestigationRedis(redis))
  const sessionStore = createTTYSessionStore(redis)
  const executionApi = new TTYExecutionApi({
    getState: async (executionId) => parseExecutionState(await redis.get<unknown>(ttyExecutionStateKey(executionId))),
    outputStream: new TTYOutputStreamManager(redis),
    sessionStore,
  })
  const synchronizer = new InvestigationExecutionSynchronizer(store, {
    getExecution: (executionId, ownerUserId) => executionApi.getExecution(executionId as never, ownerUserId),
    getOutput: (executionId, ownerUserId, options) =>
      executionApi.getOutput(executionId as never, ownerUserId, options),
  })
  const lifecycle = createTTYLifecycleApiForRequest()
  return createInvestigationApi({
    authenticate: async () => (await auth()).userId ?? null,
    getStore: () => store,
    synchronize: (ownerUserId, investigationId) => synchronizer.synchronize(ownerUserId, investigationId),
    terminateInvestigationSession: async (sessionId) => {
      const response = await lifecycle.terminate(
        new Request(`http://localhost/api/tty/sessions/${sessionId}`, { method: 'DELETE' }),
        sessionId as never,
      )
      if (!response.ok) throw new Error('TTY session termination failed.')
    },
    logger: investigationLogger,
  })
}

export function createInvestigationSessionApiForRequest() {
  const store = new InvestigationStore(createInvestigationRedis(createRedis()))
  const lifecycle = createTTYLifecycleApiForRequest()
  return createInvestigationSessionApi({
    authenticate: async () => (await auth()).userId ?? null,
    getStore: () => store,
    createTTYSession: (request) => lifecycle.create(request),
    getTTYSession: (request, sessionId) => lifecycle.get(request, sessionId as never),
    terminateTTYSession: (request, sessionId) => lifecycle.terminate(request, sessionId as never),
    logger: investigationLogger,
  })
}

export function createInvestigationExecutionApiForRequest() {
  const redis = createRedis()
  return createInvestigationExecutionApi({
    authenticate: async () => (await auth()).userId ?? null,
    getStore: () => new InvestigationStore(createInvestigationRedis(redis)),
    admitExecution: (request, sessionId) =>
      createTTYAdmissionApiForRequest({ activate: false }).admit(request, sessionId),
    startExecution: activateTTYExecution,
    logger: investigationLogger,
  })
}
