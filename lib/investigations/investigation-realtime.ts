import type { InvestigationRecord } from './investigation-types'

export type PublicInvestigation = Omit<InvestigationRecord, 'ownerUserId'>

type RealtimeInvestigationRow = {
  readonly id?: unknown
  readonly title?: unknown
  readonly description?: unknown
  readonly status?: unknown
  readonly created_at?: unknown
  readonly updated_at?: unknown
  readonly tty_session_id?: unknown
}

type CamelCaseInvestigationRecord = {
  readonly investigationId?: unknown
  readonly title?: unknown
  readonly description?: unknown
  readonly status?: unknown
  readonly createdAt?: unknown
  readonly updatedAt?: unknown
  readonly ttySessionId?: unknown
}

export type InvestigationRealtimeChange = {
  readonly eventType: 'INSERT' | 'UPDATE' | 'DELETE'
  readonly new: unknown
  readonly old: unknown
}

function isRealtimeRow(value: unknown): value is RealtimeInvestigationRow {
  return typeof value === 'object' && value !== null
}

function normalizeRealtimeRow(value: unknown): RealtimeInvestigationRow | null {
  if (!isRealtimeRow(value)) return null
  const row = value as RealtimeInvestigationRow & CamelCaseInvestigationRecord
  if (typeof row.id === 'string') return row
  if (typeof row.investigationId !== 'string') return null
  return {
    id: row.investigationId,
    title: row.title,
    description: row.description,
    status: row.status,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    tty_session_id: row.ttySessionId,
  }
}

function rowToInvestigation(
  row: RealtimeInvestigationRow,
  previous: PublicInvestigation | undefined,
): PublicInvestigation | null {
  if (typeof row.id !== 'string' || row.id.length === 0) return null
  if (typeof row.title !== 'string' || typeof row.description !== 'string') return null
  if (row.status !== 'active' && row.status !== 'archived' && row.status !== 'deleted') return null
  if (typeof row.created_at !== 'string' || typeof row.updated_at !== 'string') return null

  return {
    investigationId: row.id as PublicInvestigation['investigationId'],
    title: row.title,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.status === 'active' ? null : row.updated_at,
    ttySessionId: typeof row.tty_session_id === 'string' ? row.tty_session_id : previous?.ttySessionId ?? null,
    executionCount: previous?.executionCount ?? 0,
    evidenceCount: previous?.evidenceCount ?? 0,
    findingCount: previous?.findingCount ?? 0,
  }
}

/** Apply a scoped Supabase investigation event without allowing stale events to rewind state. */
export function applyInvestigationRealtimeChange(
  current: readonly PublicInvestigation[],
  change: InvestigationRealtimeChange,
): readonly PublicInvestigation[] {
  const payload = normalizeRealtimeRow(change.eventType === 'DELETE' ? change.old : change.new)
  if (!payload || typeof payload.id !== 'string') return current
  const index = current.findIndex((item) => item.investigationId === payload.id)
  if (change.eventType === 'DELETE' || payload.status === 'deleted') {
    return index < 0 ? current : current.filter((item) => item.investigationId !== payload.id)
  }

  const previous = index < 0 ? undefined : current[index]
  const next = rowToInvestigation(payload, previous)
  if (!next) return current
  if (previous && previous.updatedAt >= next.updatedAt) return current

  if (index < 0) return [next, ...current]
  return current.map((item, itemIndex) => (itemIndex === index ? next : item))
}
