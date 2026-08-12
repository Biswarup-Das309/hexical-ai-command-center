'use client'

import { GitBranch, Info } from 'lucide-react'

export interface ExecutionProcessTreeProps {
  readonly executionId?: string
  readonly state: string | null
  readonly telemetry?: {
    readonly source: 'worker' | 'unavailable'
    readonly pid?: number | null
    readonly processCount?: number | null
    readonly cpuPercent?: number | null
    readonly memoryBytes?: number | null
    readonly diskBytes?: number | null
  }
  readonly className?: string
}

/**
 * Process data is intentionally opt-in. The browser must never turn a
 * session id into a fictional worker/PID tree; until the worker publishes a
 * sampled process tree it is shown as unavailable.
 */
export function ExecutionProcessTree({ state, telemetry, className = '' }: ExecutionProcessTreeProps) {
  const available = telemetry?.source === 'worker'
  return (
    <section
      className={`rounded-lg border border-white/10 bg-black/20 p-3 ${className}`}
      aria-label="Execution process tree"
    >
      <div className="mb-3 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-400">
        <GitBranch className="size-3 text-cyan-300" /> Process tree
      </div>
      <div className="space-y-2 font-mono text-[10px]">
        <div className="flex items-center justify-between text-zinc-300">
          <span>execution state</span>
          <span className="text-emerald-300">{state ?? 'booting'}</span>
        </div>
        {available ? (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-zinc-500">
            <dt>PID</dt>
            <dd className="text-right text-zinc-300">{telemetry.pid ?? '—'}</dd>
            <dt>processes</dt>
            <dd className="text-right text-zinc-300">{telemetry.processCount ?? '—'}</dd>
            <dt>CPU</dt>
            <dd className="text-right text-zinc-300">{telemetry.cpuPercent ?? '—'}%</dd>
            <dt>memory</dt>
            <dd className="text-right text-zinc-300">{telemetry.memoryBytes ?? '—'} B</dd>
            <dt>disk</dt>
            <dd className="text-right text-zinc-300">{telemetry.diskBytes ?? '—'} B</dd>
          </dl>
        ) : (
          <div className="flex items-start gap-2 rounded border border-amber-400/15 bg-amber-400/[0.03] p-2 text-zinc-500">
            <Info className="mt-0.5 size-3 shrink-0 text-amber-300" />
            <span>Worker process telemetry is unavailable until the Linux runtime reports a sampled process tree.</span>
          </div>
        )}
      </div>
    </section>
  )
}
