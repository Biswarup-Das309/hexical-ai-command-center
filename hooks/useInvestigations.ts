'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InvestigationRecord } from '@/lib/investigations/investigation-types'

export type PublicInvestigation = Omit<InvestigationRecord, 'ownerUserId'>

export interface UseInvestigationsResult {
  readonly investigations: readonly PublicInvestigation[]
  readonly nextCursor: string | null
  readonly loading: boolean
  readonly error: string | null
  readonly refresh: () => Promise<void>
  readonly loadMore: () => Promise<void>
  readonly create: (input?: { readonly title?: string; readonly description?: string }) => Promise<string | null>
  readonly rename: (investigationId: string, title: string, description?: string) => Promise<void>
  readonly archive: (investigationId: string) => Promise<void>
  readonly restore: (investigationId: string) => Promise<void>
  readonly remove: (investigationId: string) => Promise<void>
}

interface InvestigationPageResponse {
  readonly ok: true
  readonly investigations: readonly PublicInvestigation[]
  readonly nextCursor: string | null
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string'
        ? body.message
        : 'Investigations could not be loaded.'
    throw new Error(message)
  }
  return body as T
}

function replaceInvestigation(
  current: readonly PublicInvestigation[],
  next: PublicInvestigation,
): readonly PublicInvestigation[] {
  return current.map((item) => (item.investigationId === next.investigationId ? next : item))
}

function optimisticPatch(current: PublicInvestigation, body: Record<string, unknown>): PublicInvestigation {
  const status = body.status === 'active' || body.status === 'archived' ? body.status : current.status
  return {
    ...current,
    title: typeof body.title === 'string' ? body.title.trim() : current.title,
    description: typeof body.description === 'string' ? body.description.trim() : current.description,
    status,
    archivedAt: status === 'active' ? null : current.archivedAt,
    updatedAt: new Date().toISOString(),
  }
}

export function useInvestigations(): UseInvestigationsResult {
  const [investigations, setInvestigations] = useState<readonly PublicInvestigation[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const investigationsRef = useRef<readonly PublicInvestigation[]>([])
  const listRequestRef = useRef(0)
  const mutationVersionRef = useRef(0)
  const paginationInFlightRef = useRef(false)
  const createInFlightRef = useRef(false)
  const mutationQueuesRef = useRef(new Map<string, Promise<void>>())

  const updateInvestigations = useCallback(
    (updater: (current: readonly PublicInvestigation[]) => readonly PublicInvestigation[]) => {
      setInvestigations((current) => {
        const next = updater(current)
        investigationsRef.current = next
        return next
      })
    },
    [],
  )

  const enqueueMutation = useCallback((investigationId: string, operation: () => Promise<void>) => {
    const previous = mutationQueuesRef.current.get(investigationId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    const tracked = next.then(
      (value) => {
        if (mutationQueuesRef.current.get(investigationId) === tracked)
          mutationQueuesRef.current.delete(investigationId)
        return value
      },
      (cause) => {
        if (mutationQueuesRef.current.get(investigationId) === tracked)
          mutationQueuesRef.current.delete(investigationId)
        throw cause
      },
    )
    mutationQueuesRef.current.set(investigationId, tracked)
    return tracked
  }, [])

  const fetchPage = useCallback(async (cursor?: string | null): Promise<InvestigationPageResponse> => {
    const params = new URLSearchParams({ limit: '50' })
    if (cursor) params.set('cursor', cursor)
    return requestJson<InvestigationPageResponse>(`/api/investigations?${params.toString()}`)
  }, [])

  const refresh = useCallback(async () => {
    const requestId = ++listRequestRef.current
    const mutationVersion = mutationVersionRef.current
    setLoading(true)
    try {
      const page = await fetchPage()
      if (requestId !== listRequestRef.current || mutationVersion !== mutationVersionRef.current) return
      updateInvestigations(() => page.investigations)
      setNextCursor(page.nextCursor)
      setError(null)
    } catch (cause) {
      if (requestId === listRequestRef.current)
        setError(cause instanceof Error ? cause.message : 'Investigations could not be loaded.')
    } finally {
      if (requestId === listRequestRef.current) setLoading(false)
    }
  }, [fetchPage, updateInvestigations])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const loadMore = useCallback(async () => {
    if (!nextCursor || paginationInFlightRef.current) return
    paginationInFlightRef.current = true
    const requestId = ++listRequestRef.current
    const mutationVersion = mutationVersionRef.current
    const cursor = nextCursor
    setLoading(true)
    try {
      const page = await fetchPage(cursor)
      if (requestId !== listRequestRef.current || mutationVersion !== mutationVersionRef.current) return
      updateInvestigations((current) => [...current, ...page.investigations])
      setNextCursor(page.nextCursor)
      setError(null)
    } catch (cause) {
      if (requestId === listRequestRef.current)
        setError(cause instanceof Error ? cause.message : 'More investigations could not be loaded.')
    } finally {
      paginationInFlightRef.current = false
      if (requestId === listRequestRef.current) setLoading(false)
    }
  }, [fetchPage, nextCursor, updateInvestigations])

  const create = useCallback(
    async (input: { readonly title?: string; readonly description?: string } = {}) => {
      if (createInFlightRef.current) return null
      createInFlightRef.current = true
      setLoading(true)
      try {
        const body = await requestJson<{ readonly ok: true; readonly investigation: PublicInvestigation }>(
          '/api/investigations',
          {
            method: 'POST',
            body: JSON.stringify({ title: input.title ?? 'New Investigation', description: input.description ?? '' }),
          },
        )
        mutationVersionRef.current += 1
        updateInvestigations((current) => [
          body.investigation,
          ...current.filter((item) => item.investigationId !== body.investigation.investigationId),
        ])
        setError(null)
        return body.investigation.investigationId
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'The investigation could not be created.')
        return null
      } finally {
        createInFlightRef.current = false
        setLoading(false)
      }
    },
    [updateInvestigations],
  )

  const patch = useCallback(
    async (investigationId: string, body: Record<string, unknown>) => {
      return enqueueMutation(investigationId, async () => {
        mutationVersionRef.current += 1
        const previous = investigationsRef.current.find((item) => item.investigationId === investigationId) ?? null
        if (previous) updateInvestigations((current) => replaceInvestigation(current, optimisticPatch(previous, body)))
        setLoading(true)
        try {
          const response = await requestJson<{ readonly ok: true; readonly investigation: PublicInvestigation }>(
            `/api/investigations/${investigationId}`,
            {
              method: 'PATCH',
              body: JSON.stringify(body),
            },
          )
          updateInvestigations((current) => replaceInvestigation(current, response.investigation))
          setError(null)
        } catch (cause) {
          if (previous) updateInvestigations((current) => replaceInvestigation(current, previous))
          setError(cause instanceof Error ? cause.message : 'The investigation could not be updated.')
          throw cause
        } finally {
          setLoading(false)
        }
      })
    },
    [enqueueMutation, updateInvestigations],
  )

  const rename = useCallback(
    async (investigationId: string, title: string, description?: string) => {
      await patch(investigationId, { title, ...(description === undefined ? {} : { description }) })
    },
    [patch],
  )

  const archive = useCallback(
    async (investigationId: string) => {
      await patch(investigationId, { status: 'archived' })
    },
    [patch],
  )

  const restore = useCallback(
    async (investigationId: string) => {
      await patch(investigationId, { status: 'active' })
    },
    [patch],
  )

  const remove = useCallback(
    async (investigationId: string) => {
      return enqueueMutation(investigationId, async () => {
        mutationVersionRef.current += 1
        const previous = investigationsRef.current
        const removedIndex = previous.findIndex((item) => item.investigationId === investigationId)
        const removed = removedIndex >= 0 ? previous[removedIndex] : null
        updateInvestigations((current) => current.filter((item) => item.investigationId !== investigationId))
        setLoading(true)
        try {
          await requestJson(`/api/investigations/${investigationId}`, { method: 'DELETE' })
          setError(null)
        } catch (cause) {
          if (removed) {
            updateInvestigations((current) => {
              if (current.some((item) => item.investigationId === investigationId)) return current
              const next = [...current]
              next.splice(Math.min(removedIndex, next.length), 0, removed)
              return next
            })
          }
          setError(cause instanceof Error ? cause.message : 'The investigation could not be deleted.')
          throw cause
        } finally {
          setLoading(false)
        }
      })
    },
    [enqueueMutation, updateInvestigations],
  )

  return useMemo(
    () => ({ investigations, nextCursor, loading, error, refresh, loadMore, create, rename, archive, restore, remove }),
    [archive, create, error, investigations, loadMore, loading, nextCursor, refresh, remove, rename, restore],
  )
}
