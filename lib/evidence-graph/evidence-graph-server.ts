import 'server-only'

import { auth } from '@clerk/nextjs/server'
import { Redis } from '@upstash/redis'
import { createInvestigationRedis, createRedis } from '@/lib/investigations/investigation-server'
import { InvestigationStore } from '@/lib/investigations/investigation-store'
import { TTYExecutionApi } from '@/lib/tty/tty-execution-api'
import { isTTYExecutionState, type TTYExecutionStateRecord } from '@/lib/tty/tty-execution-state'
import { TTYOutputStreamManager } from '@/lib/tty/tty-output-stream'
import { createTTYSessionStore } from '@/lib/tty/tty-session-store'
import { ttyExecutionStateKey } from '@/lib/tty/tty-worker-keys'
import { createEvidenceGraphApi } from './evidence-graph-api'
import { EvidenceGraphStore, type EvidenceGraphRedis } from './evidence-graph-store'
import { EvidenceGraphSynchronizer } from './evidence-graph-sync'

function createGraphRedis(redis: Redis): EvidenceGraphRedis {
  return {
    get: <T>(key: string) => redis.get<T>(key),
    set: (key, value, options) => (options?.nx ? redis.set(key, value, { nx: true }) : redis.set(key, value)),
    zadd: (key, value) => redis.zadd(key, value),
    zrange: <T extends unknown[]>(
      key: string,
      min: number,
      max: number,
      options: { readonly rev?: boolean; readonly offset: number; readonly count: number },
    ) => redis.zrange<T>(key, min, max, options),
    zcard: (key) => redis.zcard(key),
    eval: <T>(script: string, keys: readonly string[], args: readonly string[]) =>
      redis.eval<unknown[]>(script, [...keys], [...args]).then((value) => value as T),
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

export function createEvidenceGraphApiForRequest() {
  const redis = createRedis()
  const investigationStore = new InvestigationStore(createInvestigationRedis(redis))
  const getInvestigation = async (
    ownerUserId: string,
    investigationId: Parameters<typeof investigationStore.get>[1],
  ) => {
    const hydration = await investigationStore.get(ownerUserId, investigationId, {
      executionLimit: 50,
      timelineLimit: 1,
    })
    return hydration
      ? {
          investigationId: hydration.investigation.investigationId,
          title: hydration.investigation.title,
          status: hydration.investigation.status,
        }
      : null
  }
  const graphStore = new EvidenceGraphStore(createGraphRedis(redis), {
    getInvestigation,
  })
  const sessionStore = createTTYSessionStore(redis)
  const executionApi = new TTYExecutionApi({
    getState: async (executionId) => parseExecutionState(await redis.get<unknown>(ttyExecutionStateKey(executionId))),
    outputStream: new TTYOutputStreamManager(redis),
    sessionStore,
  })
  const synchronizer = new EvidenceGraphSynchronizer(graphStore, {
    getInvestigation,
    getExecutions: async (ownerUserId, investigationId) =>
      (await investigationStore.get(ownerUserId, investigationId, { executionLimit: 50, timelineLimit: 1 }))
        ?.executions ?? [],
    getExecution: (executionId, ownerUserId) => executionApi.getExecution(executionId as never, ownerUserId),
    getOutput: (executionId, ownerUserId, options) =>
      executionApi.getOutput(executionId as never, ownerUserId, options),
  })
  return createEvidenceGraphApi({
    authenticate: async () => (await auth()).userId ?? null,
    getStore: () => graphStore,
    getInvestigation,
    synchronize: (ownerUserId, investigationId, executionId) =>
      executionId
        ? synchronizer.synchronizeExecution(ownerUserId, investigationId, executionId)
        : synchronizer.synchronizeInvestigation(ownerUserId, investigationId),
  })
}
