'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

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
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string'
      ? body.message
      : 'Investigations could not be loaded.'
    throw new Error(message)
  }
  return body as T
}

function replaceInvestigation(current: readonly PublicInvestigation[], next: PublicInvestigation): readonly PublicInvestigation[] {
  return current.map(item => item.investigationId === next.investigationId ? next : item)
}

export function useInvestigations(): UseInvestigationsResult {
  const [investigations, setInvestigations] = useState<readonly PublicInvestigation[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchPage = useCallback(async (cursor?: string | null): Promise<InvestigationPageResponse> => {
    const params = new URLSearchParams({ limit: '50' })
    if (cursor) params.set('cursor', cursor)
    return requestJson<InvestigationPageResponse>(`/api/investigations?${params.toString()}`)
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const page = await fetchPage()
      setInvestigations(page.investigations)
      setNextCursor(page.nextCursor)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Investigations could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [fetchPage])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const loadMore = useCallback(async () => {
    if (!nextCursor) return
    setLoading(true)
    try {
      const page = await fetchPage(nextCursor)
      setInvestigations(current => [...current, ...page.investigations])
      setNextCursor(page.nextCursor)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'More investigations could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [fetchPage, nextCursor])

  const create = useCallback(async (input: { readonly title?: string; readonly description?: string } = {}) => {
    setLoading(true)
    try {
      const body = await requestJson<{ readonly ok: true; readonly investigation: PublicInvestigation }>('/api/investigations', {
        method: 'POST',
        body: JSON.stringify({ title: input.title ?? 'New Investigation', description: input.description ?? '' })
      })
      setInvestigations(current => [body.investigation, ...current.filter(item => item.investigationId !== body.investigation.investigationId)])
      setError(null)
      return body.investigation.investigationId
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The investigation could not be created.')
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  const patch = useCallback(async (investigationId: string, body: Record<string, unknown>) => {
    setLoading(true)
    try {
      const response = await requestJson<{ readonly ok: true; readonly investigation: PublicInvestigation }>(`/api/investigations/${investigationId}`, {
        method: 'PATCH',
        body: JSON.stringify(body)
      })
      setInvestigations(current => replaceInvestigation(current, response.investigation))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The investigation could not be updated.')
      throw cause
    } finally {
      setLoading(false)
    }
  }, [])

  const rename = useCallback(async (investigationId: string, title: string, description?: string) => {
    await patch(investigationId, { title, ...(description === undefined ? {} : { description }) })
  }, [patch])

  const archive = useCallback(async (investigationId: string) => {
    await patch(investigationId, { status: 'archived' })
  }, [patch])

  const restore = useCallback(async (investigationId: string) => {
    await patch(investigationId, { status: 'active' })
  }, [patch])

  const remove = useCallback(async (investigationId: string) => {
    setLoading(true)
    try {
      await requestJson(`/api/investigations/${investigationId}`, { method: 'DELETE' })
      setInvestigations(current => current.filter(item => item.investigationId !== investigationId))
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The investigation could not be deleted.')
      throw cause
    } finally {
      setLoading(false)
    }
  }, [])

  return useMemo(() => ({ investigations, nextCursor, loading, error, refresh, loadMore, create, rename, archive, restore, remove }), [archive, create, error, investigations, loadMore, loading, nextCursor, refresh, remove, rename, restore])
}
