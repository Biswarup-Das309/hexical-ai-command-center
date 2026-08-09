'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  InvestigationBookmark,
  InvestigationExecution,
  InvestigationNote,
  InvestigationRecord,
  InvestigationTimelineEvent
} from '@/lib/investigations/investigation-types'

type PublicInvestigation = Omit<InvestigationRecord, 'ownerUserId'>

export interface InvestigationWorkspaceData {
  readonly investigation: PublicInvestigation
  readonly executions: readonly InvestigationExecution[]
  readonly timeline: readonly InvestigationTimelineEvent[]
  readonly bookmarks: readonly InvestigationBookmark[]
  readonly notes: readonly InvestigationNote[]
  readonly nextTimelineCursor: string | null
  readonly nextExecutionCursor: string | null
}

export interface UseInvestigationWorkspaceOptions {
  readonly investigationId?: string | null
  readonly autoCreate?: boolean
  readonly storageKey?: string
}

export interface UseInvestigationWorkspaceResult {
  readonly investigationId: string | null
  readonly data: InvestigationWorkspaceData | null
  readonly loading: boolean
  readonly error: string | null
  readonly create: (input?: { readonly title?: string; readonly description?: string }) => Promise<string | null>
  readonly refresh: () => Promise<void>
  readonly loadMoreTimeline: () => Promise<void>
  readonly loadMoreExecutions: () => Promise<void>
  readonly rename: (title: string, description?: string) => Promise<void>
  readonly archive: () => Promise<void>
  readonly restore: () => Promise<void>
  readonly remove: () => Promise<void>
  readonly addNote: (body: string) => Promise<void>
  readonly addBookmark: (bookmark: Omit<InvestigationBookmark, 'bookmarkId' | 'createdAt'>) => Promise<void>
  readonly attachExecution: (input: { readonly sessionId: string; readonly input: string; readonly idempotencyKey: string }) => Promise<string | null>
}

const DEFAULT_STORAGE_KEY = 'hexical:workspace:active-investigation'

function storedId(key: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function rememberId(key: string, id: string | null): void {
  if (typeof window === 'undefined') return
  try {
    if (id) window.localStorage.setItem(key, id)
    else window.localStorage.removeItem(key)
  } catch {
    // Storage is an optimization; server persistence remains authoritative.
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: 'no-store', headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string' ? body.message : 'The investigation request failed.'
    throw new Error(message)
  }
  return body as T
}

function mergeUnique<T extends { readonly eventId: string }>(current: readonly T[], next: readonly T[], maximum: number): readonly T[] {
  const seen = new Set<string>()
  const merged: T[] = []
  for (const item of [...current, ...next]) {
    if (seen.has(item.eventId)) continue
    seen.add(item.eventId)
    merged.push(item)
  }
  return merged.slice(-maximum)
}

function mergeNotes(current: readonly InvestigationNote[], next: readonly InvestigationNote[]): readonly InvestigationNote[] {
  const seen = new Set<string>()
  const merged: InvestigationNote[] = []
  for (const note of [...current, ...next]) {
    if (seen.has(note.noteId)) continue
    seen.add(note.noteId)
    merged.push(note)
  }
  return merged.slice(-10_000)
}

export function useInvestigationWorkspace(options: UseInvestigationWorkspaceOptions = {}): UseInvestigationWorkspaceResult {
  const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY
  const [investigationId, setInvestigationId] = useState<string | null>(() => options.investigationId ?? storedId(storageKey))
  const [data, setData] = useState<InvestigationWorkspaceData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchInvestigation = useCallback(async (id: string, query = ''): Promise<InvestigationWorkspaceData> => {
    const body = await requestJson<{ ok: true } & InvestigationWorkspaceData>(`/api/investigations/${id}${query}`)
    return body
  }, [])

  const load = useCallback(async (id: string | null, query = ''): Promise<InvestigationWorkspaceData | null> => {
    if (!id) {
      setData(null)
      return null
    }
    setLoading(true)
    try {
      const body = await fetchInvestigation(id, query)
      setData(body)
      setError(null)
      rememberId(storageKey, id)
      return body
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The investigation could not be loaded.')
      return null
    } finally {
      setLoading(false)
    }
  }, [fetchInvestigation, storageKey])

  const create = useCallback(async (input: { readonly title?: string; readonly description?: string } = {}) => {
    setLoading(true)
    try {
      const body = await requestJson<{ ok: true; investigation: PublicInvestigation }>('/api/investigations', { method: 'POST', body: JSON.stringify({ title: input.title ?? 'New investigation', description: input.description ?? '' }) })
      setInvestigationId(body.investigation.investigationId)
      rememberId(storageKey, body.investigation.investigationId)
      await load(body.investigation.investigationId)
      return body.investigation.investigationId
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The investigation could not be created.')
      return null
    } finally {
      setLoading(false)
    }
  }, [load, storageKey])

  useEffect(() => {
    if (options.investigationId !== undefined) {
      setInvestigationId(options.investigationId ?? null)
      rememberId(storageKey, options.investigationId ?? null)
    }
  }, [options.investigationId, storageKey])

  useEffect(() => {
    if (investigationId) void load(investigationId)
    else if (options.autoCreate) void create()
  }, [create, investigationId, load, options.autoCreate])

  useEffect(() => {
    if (typeof window === 'undefined' || !investigationId) return
    const reconnect = () => { if (document.visibilityState !== 'hidden') void load(investigationId) }
    window.addEventListener('online', reconnect)
    document.addEventListener('visibilitychange', reconnect)
    return () => {
      window.removeEventListener('online', reconnect)
      document.removeEventListener('visibilitychange', reconnect)
    }
  }, [investigationId, load])

  const refresh = useCallback(async () => { await load(investigationId) }, [investigationId, load])

  const loadMoreTimeline = useCallback(async () => {
    if (!investigationId || !data?.nextTimelineCursor) return
    setLoading(true)
    try {
      const next = await fetchInvestigation(investigationId, `?timelineCursor=${encodeURIComponent(data.nextTimelineCursor)}`)
      setData(current => current ? { ...current, timeline: mergeUnique(current.timeline, next.timeline, 10_000), bookmarks: next.bookmarks, notes: mergeNotes(current.notes, next.notes), nextTimelineCursor: next.nextTimelineCursor } : current)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The timeline could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [data?.nextTimelineCursor, fetchInvestigation, investigationId])

  const loadMoreExecutions = useCallback(async () => {
    if (!investigationId || !data?.nextExecutionCursor) return
    setLoading(true)
    try {
      const next = await fetchInvestigation(investigationId, `?executionCursor=${encodeURIComponent(data.nextExecutionCursor)}`)
      setData(current => current ? { ...current, executions: [...current.executions, ...next.executions].slice(0, 500), nextExecutionCursor: next.nextExecutionCursor } : current)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The executions could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [data?.nextExecutionCursor, fetchInvestigation, investigationId])

  const patch = useCallback(async (body: Record<string, unknown>) => {
    if (!investigationId) return
    const response = await requestJson<{ ok: true; investigation: PublicInvestigation }>(`/api/investigations/${investigationId}`, { method: 'PATCH', body: JSON.stringify(body) })
    setData(current => current ? { ...current, investigation: { ...current.investigation, ...response.investigation } } : current)
  }, [investigationId])

  const rename = useCallback(async (title: string, description?: string) => { await patch({ title, ...(description === undefined ? {} : { description }) }) }, [patch])
  const archive = useCallback(async () => { await patch({ status: 'archived' }) }, [patch])
  const restore = useCallback(async () => { await patch({ status: 'active' }) }, [patch])

  const remove = useCallback(async () => {
    if (!investigationId) return
    await requestJson(`/api/investigations/${investigationId}`, { method: 'DELETE' })
    setData(null)
    setInvestigationId(null)
    rememberId(storageKey, null)
  }, [investigationId, storageKey])

  const timelinePost = useCallback(async (body: Record<string, unknown>) => {
    if (!investigationId) return
    await requestJson(`/api/investigations/${investigationId}/timeline`, { method: 'POST', body: JSON.stringify(body) })
    await load(investigationId)
  }, [investigationId, load])

  const addNote = useCallback(async (body: string) => { await timelinePost({ type: 'note', body }) }, [timelinePost])
  const addBookmark = useCallback(async (bookmark: Omit<InvestigationBookmark, 'bookmarkId' | 'createdAt'>) => { await timelinePost({ type: 'bookmark', ...bookmark }) }, [timelinePost])

  const attachExecution = useCallback(async (input: { readonly sessionId: string; readonly input: string; readonly idempotencyKey: string }) => {
    if (!investigationId) return null
    const body = await requestJson<{ ok: true; execution: InvestigationExecution }>(`/api/investigations/${investigationId}/executions`, { method: 'POST', body: JSON.stringify(input) })
    await load(investigationId)
    return body.execution.executionId
  }, [investigationId, load])

  return useMemo(() => ({ investigationId, data, loading, error, create, refresh, loadMoreTimeline, loadMoreExecutions, rename, archive, restore, remove, addNote, addBookmark, attachExecution }), [addBookmark, addNote, archive, attachExecution, create, data, error, investigationId, loadMoreExecutions, loadMoreTimeline, refresh, remove, rename, restore, loading])
}
