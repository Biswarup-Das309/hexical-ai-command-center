'use client'

import { useCallback, useEffect, useState } from 'react'

import type {
  EvidenceGraphConnectedPage,
  EvidenceGraphEntity,
  EvidenceGraphEntityPage,
  EvidenceGraphEntityType,
  EvidenceGraphSummary
} from '@/lib/evidence-graph/evidence-graph-types'

interface SummaryResponse { readonly ok: true; readonly summary: EvidenceGraphSummary }
interface EntityResponse { readonly ok: true; readonly entity: EvidenceGraphEntity }
interface ConnectedResponse extends EvidenceGraphConnectedPage { readonly ok: true }

async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string' ? body.message : 'The evidence graph request failed.'
    throw new Error(message)
  }
  return body as T
}

export interface UseEvidenceGraphResult {
  readonly summary: EvidenceGraphSummary | null
  readonly entities: readonly EvidenceGraphEntity[]
  readonly selectedEntity: EvidenceGraphEntity | null
  readonly connected: EvidenceGraphConnectedPage | null
  readonly selectedType: EvidenceGraphEntityType | null
  readonly loading: boolean
  readonly error: string | null
  readonly selectType: (type: EvidenceGraphEntityType) => Promise<void>
  readonly selectEntity: (entityId: string) => Promise<void>
  readonly refresh: () => Promise<void>
}

export function useEvidenceGraph(investigationId: string | null): UseEvidenceGraphResult {
  const [summary, setSummary] = useState<EvidenceGraphSummary | null>(null)
  const [entities, setEntities] = useState<readonly EvidenceGraphEntity[]>([])
  const [selectedEntity, setSelectedEntity] = useState<EvidenceGraphEntity | null>(null)
  const [connected, setConnected] = useState<EvidenceGraphConnectedPage | null>(null)
  const [selectedType, setSelectedType] = useState<EvidenceGraphEntityType | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!investigationId) {
      setSummary(null)
      setEntities([])
      setSelectedEntity(null)
      setConnected(null)
      return
    }
    setLoading(true)
    try {
      const body = await requestJson<SummaryResponse>(`/api/investigations/${investigationId}/graph/summary`)
      setSummary(body.summary)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The evidence graph could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [investigationId])

  const selectType = useCallback(async (type: EvidenceGraphEntityType) => {
    if (!investigationId) return
    setLoading(true)
    try {
      const body = await requestJson<{ readonly ok: true } & EvidenceGraphEntityPage>(`/api/investigations/${investigationId}/graph/entities?type=${encodeURIComponent(type)}&limit=40`)
      setSelectedType(type)
      setEntities(body.entities)
      setSelectedEntity(null)
      setConnected(null)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The graph entities could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [investigationId])

  const selectEntity = useCallback(async (entityId: string) => {
    if (!investigationId) return
    setLoading(true)
    try {
      const [entity, connectedResult] = await Promise.all([
        requestJson<EntityResponse>(`/api/investigations/${investigationId}/graph/entities/${entityId}`),
        requestJson<ConnectedResponse>(`/api/investigations/${investigationId}/graph/entities/${entityId}/connected?limit=40`)
      ])
      setSelectedEntity(entity.entity)
      setConnected(connectedResult)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The connected graph data could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [investigationId])

  useEffect(() => {
    void refresh()
    if (!investigationId) return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh()
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [investigationId, refresh])

  return { summary, entities, selectedEntity, connected, selectedType, loading, error, selectType, selectEntity, refresh }
}
