import type { TTYExecutionState } from './tty-execution-state'
import type { TTYStreamEvent } from './tty-stream-types'

export interface TTYTimelineEntry {
  readonly state: TTYExecutionState
  readonly sequence: number
  readonly timestamp: string
  readonly durationMs: number | null
  readonly active: boolean
}

export const TTY_TIMELINE_STATES: readonly TTYExecutionState[] = ['queued', 'leased', 'starting', 'running', 'streaming', 'succeeded', 'failed', 'cancelled', 'timed_out', 'expired']

export function buildTTYExecutionTimeline(events: readonly TTYStreamEvent[], now = Date.now()): readonly TTYTimelineEntry[] {
  const stateEvents = events.filter((event): event is Extract<TTYStreamEvent, { type: 'state' }> => event.type === 'state')
  const completion = events.find(event => event.type === 'completion')
  const entries: TTYTimelineEntry[] = []
  for (const event of stateEvents) {
    if (entries.some(entry => entry.state === event.payload.state)) continue
    const startedAt = Date.parse(event.timestamp)
    const nextTimestamp = stateEvents.find(candidate => Date.parse(candidate.timestamp) > startedAt)?.timestamp
    const endMs = nextTimestamp ? Date.parse(nextTimestamp) : completion ? Date.parse(completion.timestamp) : now
    entries.push({
      state: event.payload.state,
      sequence: event.sequence,
      timestamp: event.timestamp,
      durationMs: Number.isFinite(startedAt) && Number.isFinite(endMs) ? Math.max(0, endMs - startedAt) : null,
      active: completion === undefined && event === stateEvents.at(-1)
    })
  }
  return entries.sort((left, right) => left.sequence - right.sequence)
}

export function timelineDurationLabel(durationMs: number | null): string {
  if (durationMs === null) return '—'
  if (durationMs < 1_000) return `${durationMs}ms`
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 2 : 1)}s`
}

