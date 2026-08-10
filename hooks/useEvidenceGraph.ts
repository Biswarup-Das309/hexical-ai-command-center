'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  EvidenceGraphConnectedPage,
  EvidenceGraphEntity,
  EvidenceGraphEntityPage,
  EvidenceGraphEntityType,
  EvidenceGraphSummary,
} from '@/lib/evidence-graph/evidence-graph-types'

interface SummaryResponse {
  readonly ok: true
  readonly summary: EvidenceGraphSummary
}
interface EntityResponse {
  readonly ok: true
  readonly entity: EvidenceGraphEntity
}
interface ConnectedResponse extends EvidenceGraphConnectedPage {
  readonly ok: true
}

class EvidenceGraphRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'EvidenceGraphRequestError'
  }
}

async function requestJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' }, signal })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string'
        ? body.message
        : 'The evidence graph request failed.'
    const code =
      typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string'
        ? body.code
        : 'REQUEST_FAILED'
    throw new EvidenceGraphRequestError(message, response.status, code)
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
  readonly refresh: (options?: { readonly synchronize?: boolean }) => Promise<void>
}

const SUMMARY_REFRESH_INTERVAL_MS = 15_000

export function useEvidenceGraph(investigationId: string | null): UseEvidenceGraphResult {
  const [summary, setSummary] = useState<EvidenceGraphSummary | null>(null)
  const [entities, setEntities] = useState<readonly EvidenceGraphEntity[]>([])
  const [selectedEntity, setSelectedEntity] = useState<EvidenceGraphEntity | null>(null)
  const [connected, setConnected] = useState<EvidenceGraphConnectedPage | null>(null)
  const [selectedType, setSelectedType] = useState<EvidenceGraphEntityType | null>(null)
  const [loadedInvestigationId, setLoadedInvestigationId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refreshRequestRef = useRef(0)
  const refreshAbortRef = useRef<AbortController | null>(null)
  const refreshPromiseRef = useRef<Promise<void> | null>(null)
  const loadedInvestigationIdRef = useRef<string | null>(null)

  const clearGraphData = useCallback(() => {
    loadedInvestigationIdRef.current = null
    setLoadedInvestigationId(null)
    setSummary(null)
    setEntities([])
    setSelectedEntity(null)
    setConnected(null)
    setSelectedType(null)
  }, [])

  const refresh = useCallback(
    async (options: { readonly synchronize?: boolean } = {}) => {
      if (refreshPromiseRef.current) return refreshPromiseRef.current

      const promise = (async () => {
        if (!investigationId) {
          refreshRequestRef.current += 1
          refreshAbortRef.current?.abort()
          refreshAbortRef.current = null
          clearGraphData()
          setError(null)
          return
        }
        if (loadedInvestigationIdRef.current !== investigationId) {
          clearGraphData()
          setError(null)
        }
        const requestId = ++refreshRequestRef.current
        const controller = new AbortController()
        refreshAbortRef.current = controller
        setLoading(true)
        try {
          const query = options.synchronize === false ? '' : '?sync=1'
          const body = await requestJson<SummaryResponse>(
            `/api/investigations/${investigationId}/graph/summary${query}`,
            controller.signal,
          )
          if (requestId !== refreshRequestRef.current) return
          loadedInvestigationIdRef.current = investigationId
          setLoadedInvestigationId(investigationId)
          setSummary(body.summary)
          setError(null)
        } catch (cause) {
          if (requestId !== refreshRequestRef.current || (cause instanceof DOMException && cause.name === 'AbortError'))
            return
          // A failed refresh must not leave counts from a previous investigation
          // or a previous authorization state visible beside the error banner.
          clearGraphData()
          setError(cause instanceof Error ? cause.message : 'The evidence graph could not be loaded.')
        } finally {
          if (requestId === refreshRequestRef.current) {
            refreshAbortRef.current = null
            setLoading(false)
          }
        }
      })()

      refreshPromiseRef.current = promise
      try {
        await promise
      } finally {
        if (refreshPromiseRef.current === promise) refreshPromiseRef.current = null
      }
    },
    [clearGraphData, investigationId],
  )

  const selectType = useCallback(
    async (type: EvidenceGraphEntityType) => {
      if (!investigationId) return
      setLoading(true)
      try {
        const body = await requestJson<{ readonly ok: true } & EvidenceGraphEntityPage>(
          `/api/investigations/${investigationId}/graph/entities?type=${encodeURIComponent(type)}&limit=40`,
        )
        setSelectedType(type)
        setEntities(body.entities)
        setSelectedEntity(null)
        setConnected(null)
        setError(null)
      } catch (cause) {
        setEntities([])
        setSelectedEntity(null)
        setConnected(null)
        setError(cause instanceof Error ? cause.message : 'The graph entities could not be loaded.')
      } finally {
        setLoading(false)
      }
    },
    [investigationId],
  )

  const selectEntity = useCallback(
    async (entityId: string) => {
      if (!investigationId) return
      setLoading(true)
      try {
        const [entity, connectedResult] = await Promise.all([
          requestJson<EntityResponse>(`/api/investigations/${investigationId}/graph/entities/${entityId}`),
          requestJson<ConnectedResponse>(
            `/api/investigations/${investigationId}/graph/entities/${entityId}/connected?limit=40`,
          ),
        ])
        setSelectedEntity(entity.entity)
        setConnected(connectedResult)
        setError(null)
      } catch (cause) {
        setSelectedEntity(null)
        setConnected(null)
        setError(cause instanceof Error ? cause.message : 'The connected graph data could not be loaded.')
      } finally {
        setLoading(false)
      }
    },
    [investigationId],
  )

  useEffect(() => {
    void refresh({ synchronize: true })
    if (!investigationId) return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh({ synchronize: false })
    }, SUMMARY_REFRESH_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      refreshRequestRef.current += 1
      refreshAbortRef.current?.abort()
      refreshAbortRef.current = null
      refreshPromiseRef.current = null
    }
  }, [clearGraphData, investigationId, refresh])

  const graphIsCurrent = investigationId !== null && loadedInvestigationId === investigationId

  return {
    summary: graphIsCurrent ? summary : null,
    entities: graphIsCurrent ? entities : [],
    selectedEntity: graphIsCurrent ? selectedEntity : null,
    connected: graphIsCurrent ? connected : null,
    selectedType: graphIsCurrent ? selectedType : null,
    loading,
    error,
    selectType,
    selectEntity,
    refresh,
  }
}
