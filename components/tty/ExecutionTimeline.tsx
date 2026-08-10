'use client'

import { Check, Circle, Loader2 } from 'lucide-react'
import type { TTYExecutionState } from '@/lib/tty/tty-execution-state'
import { buildTTYExecutionTimeline, timelineDurationLabel, TTY_TIMELINE_STATES } from '@/lib/tty/tty-execution-timeline'
import type { TTYStreamEvent } from '@/lib/tty/tty-stream-types'

export interface ExecutionTimelineProps {
  readonly events: readonly TTYStreamEvent[]
  readonly currentState?: TTYExecutionState | null
  readonly className?: string
}

function stateColor(state: TTYExecutionState, active: boolean): string {
  if (state === 'succeeded') return 'text-emerald-400 border-emerald-400/50'
  if (state === 'failed' || state === 'timed_out' || state === 'expired') return 'text-rose-400 border-rose-400/50'
  if (state === 'cancelled') return 'text-amber-400 border-amber-400/50'
  return active ? 'text-cyan-300 border-cyan-400/60' : 'text-zinc-600 border-zinc-700'
}

export function ExecutionTimeline({ events, currentState, className = '' }: ExecutionTimelineProps) {
  const timeline = buildTTYExecutionTimeline(events)
  const byState = new Map(timeline.map((entry) => [entry.state, entry]))
  return (
    <section
      className={`min-h-0 rounded-lg border border-white/10 bg-black/20 p-3 ${className}`}
      aria-label="Execution timeline"
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-400">Timeline</span>
        {currentState && (
          <span className="font-mono text-[10px] uppercase tracking-wider text-cyan-300">{currentState}</span>
        )}
      </div>
      <ol className="space-y-2">
        {TTY_TIMELINE_STATES.map((state) => {
          const entry = byState.get(state)
          const isActive = entry?.active || currentState === state
          const color = stateColor(state, isActive)
          return (
            <li key={state} className="flex items-center gap-2 font-mono text-[10px]">
              <span className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${color}`}>
                {isActive ? (
                  <Loader2 className="size-2.5 animate-spin motion-reduce:animate-none" />
                ) : entry ? (
                  <Check className="size-2.5" />
                ) : (
                  <Circle className="size-1.5" />
                )}
              </span>
              <span className={entry ? color.split(' ')[0] : 'text-zinc-600'}>{state}</span>
              {entry && <span className="ml-auto text-zinc-600">{timelineDurationLabel(entry.durationMs)}</span>}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
