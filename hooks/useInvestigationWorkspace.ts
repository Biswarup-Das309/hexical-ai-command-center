'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
  readonly editNote: (noteId: string, body: string) => Promise<void>
  readonly deleteNote: (noteId: string) => Promise<void>
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

function notesFromTimeline(events: readonly InvestigationTimelineEvent[]): readonly InvestigationNote[] {
  const notes = new Map<string, InvestigationNote>()
  for (const event of events) {
    const noteId = String(event.payload.noteId ?? '')
    if (!noteId) continue
    if (event.type === 'note_added') notes.set(noteId, { noteId, body: String(event.payload.body ?? ''), createdAt: event.occurredAt })
    else if (event.type === 'note_edited') {
      const current = notes.get(noteId)
      if (current) notes.set(noteId, { ...current, body: String(event.payload.body ?? '') })
    } else if (event.type === 'note_deleted') notes.delete(noteId)
  }
  return [...notes.values()].slice(-10_000)
}

export function useInvestigationWorkspace(options: UseInvestigationWorkspaceOptions = {}): UseInvestigationWorkspaceResult {
  const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY
  const [investigationId, setInvestigationId] = useState<string | null>(() => options.investigationId ?? storedId(storageKey))
  const [data, setData] = useState<InvestigationWorkspaceData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadRequestRef = useRef(0)
  const createInFlightRef = useRef(false)
  const mutationQueueRef = useRef(Promise.resolve())

  const fetchInvestigation = useCallback(async (id: string, query = ''): Promise<InvestigationWorkspaceData> => {
    const body = await requestJson<{ ok: true } & InvestigationWorkspaceData>(`/api/investigations/${id}${query}`)
    return body
  }, [])

  const load = useCallback(async (id: string | null, query = ''): Promise<InvestigationWorkspaceData | null> => {
    if (!id) {
      loadRequestRef.current += 1
      setData(null)
      setError(null)
      setLoading(false)
      return null
    }
    const requestId = ++loadRequestRef.current
    setLoading(true)
    try {
      const body = await fetchInvestigation(id, query)
      if (requestId !== loadRequestRef.current) return null
      setData(body)
      setError(null)
      rememberId(storageKey, id)
      return body
    } catch (cause) {
      if (requestId === loadRequestRef.current) setError(cause instanceof Error ? cause.message : 'The investigation could not be loaded.')
      return null
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false)
    }
  }, [fetchInvestigation, storageKey])

  const create = useCallback(async (input: { readonly title?: string; readonly description?: string } = {}) => {
    if (createInFlightRef.current) return null
    createInFlightRef.current = true
    setLoading(true)
    try {
      const body = await requestJson<{ ok: true; investigation: PublicInvestigation }>('/api/investigations', { method: 'POST', body: JSON.stringify({ title: input.title ?? 'New investigation', description: input.description ?? '' }) })
      setInvestigationId(body.investigation.investigationId)
      rememberId(storageKey, body.investigation.investigationId)
      return body.investigation.investigationId
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The investigation could not be created.')
      return null
    } finally {
      createInFlightRef.current = false
      setLoading(false)
    }
  }, [storageKey])

  useEffect(() => {
    if (options.investigationId !== undefined) {
      setInvestigationId(options.investigationId ?? null)
      rememberId(storageKey, options.investigationId ?? null)
    }
  }, [options.investigationId, storageKey])

  const resolvedInvestigationId = options.investigationId !== undefined ? options.investigationId ?? null : investigationId

  useEffect(() => {
    if (resolvedInvestigationId) {
      if (resolvedInvestigationId !== investigationId) {
        setData(null)
        setError(null)
      }
      void load(resolvedInvestigationId)
    }
    else if (options.autoCreate) void create()
    else void load(null)
  }, [create, investigationId, load, options.autoCreate, resolvedInvestigationId])

  useEffect(() => {
    if (typeof window === 'undefined' || !resolvedInvestigationId) return
    const reconnect = () => { if (document.visibilityState !== 'hidden') void load(resolvedInvestigationId) }
    window.addEventListener('online', reconnect)
    document.addEventListener('visibilitychange', reconnect)
    return () => {
      window.removeEventListener('online', reconnect)
      document.removeEventListener('visibilitychange', reconnect)
    }
  }, [load, resolvedInvestigationId])

  const refresh = useCallback(async () => { await load(resolvedInvestigationId) }, [load, resolvedInvestigationId])

  const loadMoreTimeline = useCallback(async () => {
    if (!resolvedInvestigationId || !data?.nextTimelineCursor) return
    const requestId = ++loadRequestRef.current
    setLoading(true)
    try {
      const next = await fetchInvestigation(resolvedInvestigationId, `?timelineCursor=${encodeURIComponent(data.nextTimelineCursor)}`)
      if (requestId !== loadRequestRef.current) return
      setData(current => {
        if (!current) return current
        const timeline = mergeUnique(current.timeline, next.timeline, 10_000)
        return { ...current, timeline, bookmarks: next.bookmarks, notes: notesFromTimeline(timeline), nextTimelineCursor: next.nextTimelineCursor }
      })
      setError(null)
    } catch (cause) {
      if (requestId === loadRequestRef.current) setError(cause instanceof Error ? cause.message : 'The timeline could not be loaded.')
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false)
    }
  }, [data?.nextTimelineCursor, fetchInvestigation, resolvedInvestigationId])

  const loadMoreExecutions = useCallback(async () => {
    if (!resolvedInvestigationId || !data?.nextExecutionCursor) return
    const requestId = ++loadRequestRef.current
    setLoading(true)
    try {
      const next = await fetchInvestigation(resolvedInvestigationId, `?executionCursor=${encodeURIComponent(data.nextExecutionCursor)}`)
      if (requestId !== loadRequestRef.current) return
      setData(current => current ? { ...current, executions: [...current.executions, ...next.executions].slice(0, 500), nextExecutionCursor: next.nextExecutionCursor } : current)
      setError(null)
    } catch (cause) {
      if (requestId === loadRequestRef.current) setError(cause instanceof Error ? cause.message : 'The executions could not be loaded.')
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false)
    }
  }, [data?.nextExecutionCursor, fetchInvestigation, resolvedInvestigationId])

  const patch = useCallback(async (body: Record<string, unknown>) => {
    if (!resolvedInvestigationId) return
    ++loadRequestRef.current
    setLoading(true)
    try {
      const response = await requestJson<{ ok: true; investigation: PublicInvestigation }>(`/api/investigations/${resolvedInvestigationId}`, { method: 'PATCH', body: JSON.stringify(body) })
      setData(current => current ? { ...current, investigation: { ...current.investigation, ...response.investigation } } : current)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The investigation could not be updated.')
      throw cause
    } finally {
      setLoading(false)
    }
  }, [resolvedInvestigationId])

  const rename = useCallback(async (title: string, description?: string) => { await patch({ title, ...(description === undefined ? {} : { description }) }) }, [patch])
  const archive = useCallback(async () => { await patch({ status: 'archived' }) }, [patch])
  const restore = useCallback(async () => { await patch({ status: 'active' }) }, [patch])

  const remove = useCallback(async () => {
    if (!resolvedInvestigationId) return
    ++loadRequestRef.current
    setLoading(true)
    try {
      await requestJson(`/api/investigations/${resolvedInvestigationId}`, { method: 'DELETE' })
      setData(null)
      setInvestigationId(null)
      rememberId(storageKey, null)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The investigation could not be deleted.')
      throw cause
    } finally {
      setLoading(false)
    }
  }, [resolvedInvestigationId, storageKey])

  const queueMutation = useCallback((operation: () => Promise<void>) => {
    const next = mutationQueueRef.current.catch(() => undefined).then(operation)
    mutationQueueRef.current = next.then(() => undefined, () => undefined)
    return next
  }, [])

  const timelinePost = useCallback(async (body: Record<string, unknown>) => {
    if (!resolvedInvestigationId) return
    try {
      await queueMutation(async () => {
        await requestJson(`/api/investigations/${resolvedInvestigationId}/timeline`, { method: 'POST', body: JSON.stringify(body) })
        await load(resolvedInvestigationId)
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The timeline event could not be persisted.')
      throw cause
    }
  }, [load, queueMutation, resolvedInvestigationId])

  const addNote = useCallback(async (body: string) => { await timelinePost({ type: 'note', body }) }, [timelinePost])
  const editNote = useCallback(async (noteId: string, body: string) => {
    if (!resolvedInvestigationId) return
    try {
      await queueMutation(async () => {
        await requestJson(`/api/investigations/${resolvedInvestigationId}/timeline/notes/${noteId}`, { method: 'PATCH', body: JSON.stringify({ body }) })
        await load(resolvedInvestigationId)
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The note could not be updated.')
      throw cause
    }
  }, [load, queueMutation, resolvedInvestigationId])
  const deleteNote = useCallback(async (noteId: string) => {
    if (!resolvedInvestigationId) return
    try {
      await queueMutation(async () => {
        await requestJson(`/api/investigations/${resolvedInvestigationId}/timeline/notes/${noteId}`, { method: 'DELETE' })
        await load(resolvedInvestigationId)
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The note could not be deleted.')
      throw cause
    }
  }, [load, queueMutation, resolvedInvestigationId])
  const addBookmark = useCallback(async (bookmark: Omit<InvestigationBookmark, 'bookmarkId' | 'createdAt'>) => { await timelinePost({ type: 'bookmark', ...bookmark }) }, [timelinePost])

  const attachExecution = useCallback(async (input: { readonly sessionId: string; readonly input: string; readonly idempotencyKey: string }) => {
    if (!resolvedInvestigationId) return null
    let executionId: string | null = null
    try {
      await queueMutation(async () => {
        const body = await requestJson<{ ok: true; execution: InvestigationExecution }>(`/api/investigations/${resolvedInvestigationId}/executions`, { method: 'POST', body: JSON.stringify(input) })
        executionId = body.execution.executionId
        await load(resolvedInvestigationId)
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The execution could not be attached.')
      throw cause
    }
    return executionId
  }, [load, queueMutation, resolvedInvestigationId])

  return useMemo(() => ({ investigationId: resolvedInvestigationId, data, loading, error, create, refresh, loadMoreTimeline, loadMoreExecutions, rename, archive, restore, remove, addNote, editNote, deleteNote, addBookmark, attachExecution }), [addBookmark, addNote, archive, attachExecution, create, data, deleteNote, editNote, error, loadMoreExecutions, loadMoreTimeline, refresh, remove, rename, resolvedInvestigationId, restore, loading])
}
