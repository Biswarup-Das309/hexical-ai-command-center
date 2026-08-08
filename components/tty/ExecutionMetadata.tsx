'use client'

import type { TTYBrowserExecutionView } from '@/lib/tty/tty-execution-api'
import type { TTYStreamEvent } from '@/lib/tty/tty-stream-types'

export interface ExecutionMetadataProps {
  readonly execution?: TTYBrowserExecutionView | null
  readonly completion?: Extract<TTYStreamEvent, { type: 'completion' }>
  readonly verificationStatus?: 'verified' | 'pending' | 'unverified'
  readonly className?: string
}

function value(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === '' ? '—' : String(value)
}

function timestamp(valueToFormat: string | null | undefined): string {
  if (!valueToFormat) return '—'
  const date = new Date(valueToFormat)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour12: false })
}

export function ExecutionMetadata({ execution, completion, verificationStatus = 'pending', className = '' }: ExecutionMetadataProps) {
  const fields = [
    ['execution id', value(execution?.executionId)],
    ['session id', value(execution?.sessionId)],
    ['started', timestamp(execution?.timestamps.startedAt)],
    ['completed', timestamp(execution?.timestamps.finishedAt)],
    ['duration', execution?.resourceUsage.durationMs === null || execution?.resourceUsage.durationMs === undefined ? '—' : `${execution.resourceUsage.durationMs}ms`],
    ['output size', execution ? `${execution.outputSummary.totalBytes} B` : '—'],
    ['exit status', completion?.payload.exitCode === null || completion?.payload.exitCode === undefined ? value(completion?.payload.state) : String(completion.payload.exitCode)],
    ['verification', verificationStatus],
    ['queue wait', execution?.resourceUsage.queueWaitMs === null || execution?.resourceUsage.queueWaitMs === undefined ? '—' : `${execution.resourceUsage.queueWaitMs}ms`],
    ['startup', execution?.resourceUsage.startupMs === null || execution?.resourceUsage.startupMs === undefined ? '—' : `${execution.resourceUsage.startupMs}ms`]
  ] as const
  return (
    <section className={`min-h-0 rounded-lg border border-white/10 bg-black/20 p-3 ${className}`} aria-label="Execution metadata">
      <div className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-400">Metadata</div>
      <dl className="space-y-2">
        {fields.map(([label, fieldValue]) => (
          <div key={label} className="flex items-baseline justify-between gap-3 font-mono text-[10px]">
            <dt className="shrink-0 uppercase tracking-wider text-zinc-600">{label}</dt>
            <dd className={`min-w-0 truncate text-right ${label === 'verification' && fieldValue === 'verified' ? 'text-emerald-400' : 'text-zinc-300'}`} title={fieldValue}>{fieldValue}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

