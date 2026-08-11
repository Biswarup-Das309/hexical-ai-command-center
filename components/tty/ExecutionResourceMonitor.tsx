'use client'

import { Clock3, Database, Gauge, HardDrive, Timer } from 'lucide-react'

export interface ExecutionResourceMonitorProps {
  readonly metrics?: Readonly<Record<string, number>>
  readonly className?: string
}

function display(metrics: Readonly<Record<string, number>>, keys: readonly string[], suffix = ''): string {
  const value = keys.map((key) => metrics[key]).find((candidate) => candidate !== undefined)
  return value === undefined || !Number.isFinite(value) ? '—' : `${Math.round(value * 10) / 10}${suffix}`
}

export function ExecutionResourceMonitor({ metrics = {}, className = '' }: ExecutionResourceMonitorProps) {
  const hasMetrics = Object.keys(metrics).length > 0
  const cards = [
    { label: 'Queue wait', value: display(metrics, ['queue_wait_ms'], ' ms'), icon: Clock3, tone: 'text-cyan-300' },
    {
      label: 'Startup',
      value: display(metrics, ['startup_ms'], ' ms'),
      icon: Timer,
      tone: 'text-violet-300',
    },
    {
      label: 'Duration',
      value: display(metrics, ['duration_ms'], ' ms'),
      icon: Gauge,
      tone: 'text-emerald-300',
    },
    {
      label: 'Output',
      value: display(metrics, ['output_bytes'], ' B'),
      icon: HardDrive,
      tone: 'text-amber-300',
    },
    {
      label: 'Streams',
      value: `${display(metrics, ['stdout_bytes'], ' B')} / ${display(metrics, ['stderr_bytes'], ' B')}`,
      icon: Database,
      tone: 'text-rose-300',
    },
  ] as const

  return (
    <section
      className={`rounded-lg border border-white/10 bg-black/20 p-3 ${className}`}
      aria-label="Execution resource monitor"
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-400">
          Resource monitor
        </span>
        <span
          className={`font-mono text-[9px] uppercase tracking-wider ${
            hasMetrics ? 'text-emerald-300' : 'text-zinc-600'
          }`}
        >
          {hasMetrics ? 'telemetry live' : 'awaiting telemetry'}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5 lg:grid-cols-1">
        {cards.map(({ label, value, icon: Icon, tone }) => (
          <div key={label} className="rounded border border-white/5 bg-white/[0.02] px-2 py-2">
            <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider text-zinc-600">
              <Icon className={`size-3 ${tone}`} />
              {label}
            </div>
            <div className="mt-1 font-mono text-xs text-zinc-200">{value}</div>
          </div>
        ))}
      </div>
    </section>
  )
}
