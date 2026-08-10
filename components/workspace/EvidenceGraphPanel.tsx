'use client'

import { Network, RefreshCw } from 'lucide-react'
import { useEvidenceGraph } from '@/hooks/useEvidenceGraph'
import type { EvidenceGraphEntityType } from '@/lib/evidence-graph/evidence-graph-types'

export interface EvidenceGraphPanelProps {
  readonly investigationId: string | null
}

const EXPLORER_TYPES: readonly EvidenceGraphEntityType[] = [
  'host',
  'service',
  'finding',
  'vulnerability',
  'technology',
  'evidence',
]

function labelForType(type: EvidenceGraphEntityType): string {
  return type.charAt(0).toUpperCase() + type.slice(1)
}

export function EvidenceGraphPanel({ investigationId }: EvidenceGraphPanelProps) {
  const graph = useEvidenceGraph(investigationId)
  const typeCount = (type: EvidenceGraphEntityType) => graph.summary?.entitiesByType[type] ?? 0
  const relationshipCount = Object.values(graph.summary?.relationshipsByType ?? {}).reduce(
    (sum, value) => sum + (value ?? 0),
    0,
  )

  return (
    <section className="mx-4 rounded-lg border border-white/10 bg-black/20 p-4" aria-label="Evidence graph">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Network className="size-4 text-violet-300" />
          <div>
            <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-violet-200">
              Evidence graph
            </div>
            <div className="font-mono text-[10px] text-zinc-600">
              Deterministic relationships from authorized execution output
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void graph.refresh()}
          className="rounded border border-white/10 p-1.5 text-zinc-500 hover:border-violet-400/40 hover:text-violet-200"
          aria-label="Refresh evidence graph"
        >
          <RefreshCw className={`size-3 ${graph.loading ? 'animate-spin' : ''}`} />
        </button>
      </header>

      {graph.error && (
        <div
          className="mt-3 rounded border border-rose-400/20 bg-rose-400/5 px-2 py-1 font-mono text-[10px] text-rose-200"
          role="status"
        >
          {graph.error}
        </div>
      )}

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <div className="rounded border border-white/10 bg-black/20 px-3 py-2">
          <div className="font-mono text-[9px] uppercase text-zinc-600">Entities</div>
          <div className="font-mono text-lg text-cyan-200">{graph.summary?.entityCount ?? 0}</div>
        </div>
        <div className="rounded border border-white/10 bg-black/20 px-3 py-2">
          <div className="font-mono text-[9px] uppercase text-zinc-600">Relationships</div>
          <div className="font-mono text-lg text-violet-200">
            {graph.summary?.relationshipCount ?? relationshipCount}
          </div>
        </div>
        <div className="rounded border border-white/10 bg-black/20 px-3 py-2">
          <div className="font-mono text-[9px] uppercase text-zinc-600">Last update</div>
          <div className="font-mono text-[10px] text-zinc-400">
            {graph.summary?.lastUpdatedAt
              ? new Date(graph.summary.lastUpdatedAt).toLocaleTimeString([], { hour12: false })
              : '—'}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {EXPLORER_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => void graph.selectType(type)}
            className={`rounded border px-2 py-1 font-mono text-[10px] ${
              graph.selectedType === type
                ? 'border-violet-400/50 bg-violet-400/10 text-violet-200'
                : 'border-white/10 text-zinc-500 hover:border-violet-400/30 hover:text-violet-200'
            }`}
          >
            {labelForType(type)} <span className="text-zinc-700">{typeCount(type)}</span>
          </button>
        ))}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="max-h-48 space-y-1 overflow-y-auto rounded border border-white/10 bg-black/20 p-2">
          {graph.entities.map((entity) => (
            <button
              key={entity.id}
              type="button"
              onClick={() => void graph.selectEntity(entity.id)}
              className={`w-full rounded border px-2 py-1.5 text-left ${
                graph.selectedEntity?.id === entity.id
                  ? 'border-cyan-400/40 bg-cyan-400/5'
                  : 'border-transparent hover:border-white/10'
              }`}
            >
              <span className="block truncate font-mono text-[10px] text-zinc-300">{entity.label}</span>
              <span className="font-mono text-[9px] uppercase text-zinc-600">{entity.type}</span>
            </button>
          ))}
          {graph.selectedType && graph.entities.length === 0 && (
            <div className="p-2 font-mono text-[10px] text-zinc-600">
              No {graph.selectedType} entities extracted yet.
            </div>
          )}
          {!graph.selectedType && (
            <div className="p-2 font-mono text-[10px] text-zinc-600">Choose an entity family to explore.</div>
          )}
        </div>
        <div className="rounded border border-white/10 bg-black/20 p-3">
          <div className="mb-2 font-mono text-[9px] font-semibold uppercase tracking-wider text-zinc-500">
            Connected evidence
          </div>
          {graph.selectedEntity ? (
            <>
              <div className="font-mono text-xs text-cyan-200">{graph.selectedEntity.label}</div>
              <div className="mt-2 space-y-1">
                {graph.connected?.entities.map((entity) => (
                  <div
                    key={entity.id}
                    className="flex items-center justify-between gap-2 font-mono text-[10px] text-zinc-500"
                  >
                    <span className="truncate">{entity.label}</span>
                    <span className="shrink-0 text-zinc-700">{entity.type}</span>
                  </div>
                ))}
                {graph.connected?.entities.length === 0 && (
                  <div className="font-mono text-[10px] text-zinc-600">No connected entities.</div>
                )}
              </div>
            </>
          ) : (
            <div className="font-mono text-[10px] text-zinc-600">
              Select an entity to inspect its directional relationships.
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
