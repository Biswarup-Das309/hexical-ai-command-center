import { normalizeTTYRedisStreamEntries, normalizeTTYRedisStreamFields } from './tty-redis-stream'
import type { TTYRuntimeStore } from './tty-runtime-store'
import type { TTYExecutionId } from './tty-types'
import { ttyExecutionJobKey, ttyPendingExecutionIndexKey, ttyPendingExecutionStreamKey } from './tty-worker-keys'
import type { PendingExecutionQueue } from './tty-worker-poller'

function workerLogger(level: 'info' | 'warn' | 'error', event: string, fields: Readonly<Record<string, unknown>> = {}) {
  const entry = JSON.stringify({ component: 'hexical-tty-worker', level, event, ...fields })
  if (level === 'error') console.error(entry)
  else if (level === 'warn') console.warn(entry)
  else console.info(entry)
}

/**
 * Realtime is a wake-up hint. The durable pending index is reconciled on every
 * poll so a missed notification cannot strand an admitted execution until the
 * next worker restart.
 */
export class SupabasePendingExecutionQueue implements PendingExecutionQueue {
  private readonly pending = new Set<string>()
  private readonly seenCursors = new Set<string>()

  constructor(private readonly runtimeStore: TTYRuntimeStore) {}

  async listPendingExecutionIds(limit: number): Promise<readonly string[]> {
    const requestedLimit = Math.max(0, Math.floor(limit))
    if (requestedLimit === 0) return []

    const indexedIds = await this.runtimeStore.smembers(ttyPendingExecutionIndexKey())
    for (const id of indexedIds) {
      const normalized = String(id).trim()
      if (normalized.length > 0) this.pending.add(normalized)
    }

    const ids = [...this.pending]
      .filter(Boolean)
      // Reconcile a bounded window on every poll. This prevents an unbounded
      // stale index from turning the worker into a hot loop while still
      // allowing a large queue to drain over subsequent polls.
      .slice(0, Math.max(requestedLimit, 100))

    const queued: string[] = []
    const stale: string[] = []
    await Promise.all(
      ids.map(async (executionId) => {
        const raw = await this.runtimeStore.get<unknown>(ttyExecutionJobKey(executionId as TTYExecutionId))
        let parsed: unknown
        try {
          parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
        } catch {
          parsed = null
        }
        const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
        const job =
          record && typeof record.job === 'object' && record.job !== null
            ? (record.job as Record<string, unknown>)
            : record
        if (job && job.status === 'queued' && typeof job.sessionId === 'string' && job.sessionId.length > 0)
          queued.push(executionId)
        else stale.push(executionId)
      }),
    )
    if (stale.length > 0) {
      await this.runtimeStore.srem(ttyPendingExecutionIndexKey(), ...stale)
      for (const executionId of stale) this.pending.delete(executionId)
      workerLogger('info', 'stale_pending_executions_pruned', { count: stale.length })
    }
    return queued.slice(0, requestedLimit)
  }

  async subscribe(
    onPendingExecutionIds: (executionIds: readonly string[]) => Promise<void> | void,
  ): Promise<() => void> {
    if (!this.runtimeStore.subscribeToStream) return () => undefined
    const deliver = (cursor: string, fields: unknown) => {
      if (this.seenCursors.has(cursor)) return
      this.seenCursors.add(cursor)
      const parsed = normalizeTTYRedisStreamFields(fields)
      const executionId = typeof parsed?.executionId === 'string' ? parsed.executionId : null
      if (!executionId) return
      this.pending.add(executionId)
      void onPendingExecutionIds([executionId])
    }
    const cleanup = await this.runtimeStore.subscribeToStream(ttyPendingExecutionStreamKey(), (payload) => {
      deliver(payload.streamId, payload.fields)
    })
    const historical = normalizeTTYRedisStreamEntries(
      await this.runtimeStore.xrange(ttyPendingExecutionStreamKey(), '-', '+', 10_000),
    )
    for (const entry of historical) {
      if (typeof entry[0] === 'string') deliver(entry[0], entry[1])
    }
    return cleanup
  }
}
