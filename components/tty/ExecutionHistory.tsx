'use client'

import { History } from 'lucide-react'

export interface TTYExecutionHistoryEntry {
  readonly executionId: string
  readonly state: string
  readonly updatedAt: string
  readonly command?: string
  readonly durationMs?: number
}

export interface ExecutionHistoryProps {
  readonly entries?: readonly TTYExecutionHistoryEntry[]
  readonly selectedExecutionId?: string
  readonly onSelect?: (executionId: string) => void
  readonly className?: string
}

function formatDuration(durationMs?: number): string {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return '—'
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  return `${(durationMs / 1000).toFixed(1)}s`
}

export function ExecutionHistory({
  entries = [],
  selectedExecutionId,
  onSelect,
  className = '',
}: ExecutionHistoryProps) {
  return (
    <section
      className={`min-h-0 rounded-lg border border-white/10 bg-black/20 p-3 ${className}`}
      aria-label="Execution history"
    >
      <div className="mb-3 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-400">
        <History className="size-3 text-cyan-300" /> History
      </div>
      <div className="space-y-1.5">
        {entries.map((entry) => {
          const selected = entry.executionId === selectedExecutionId
          return (
            <button
              key={entry.executionId}
              type="button"
              onClick={() => onSelect?.(entry.executionId)}
              className={`w-full rounded border px-2 py-2 text-left transition ${
                selected ? 'border-cyan-400/40 bg-cyan-400/10' : 'border-white/10 bg-black/10 hover:border-cyan-400/25'
              }`}
              aria-current={selected ? 'true' : undefined}
            >
              <span className="flex items-center justify-between gap-2 font-mono text-[10px] text-cyan-200">
                <span className="truncate">{entry.command ?? entry.executionId.slice(0, 12)}</span>
                <span className="shrink-0 text-zinc-500">{formatDuration(entry.durationMs)}</span>
              </span>
              <span className="mt-1 flex items-center justify-between gap-2 font-mono text-[9px] uppercase tracking-wider text-zinc-600">
                <span>{entry.state}</span>
                <time dateTime={entry.updatedAt}>
                  {new Date(entry.updatedAt).toLocaleTimeString([], { hour12: false })}
                </time>
              </span>
            </button>
          )
        })}
        {entries.length === 0 && (
          <p className="font-mono text-[10px] leading-relaxed text-zinc-600">
            Completed executions will appear here when history is attached.
          </p>
        )}
      </div>
    </section>
  )
}
