import { isTTYExecutionState, type TTYExecutionState } from './tty-execution-state'
import { parseTTYStreamEvent, type TTYStreamEvent } from './tty-stream-types'

export type TTYStreamClientConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'completed' | 'error'

export function buildTTYStreamUrl(executionId: string, sessionId?: string, lastEventId?: number | null): string {
  const query = new URLSearchParams()
  if (sessionId) query.set('sessionId', sessionId)
  if (lastEventId !== undefined && lastEventId !== null && Number.isSafeInteger(lastEventId) && lastEventId > 0)
    query.set('lastEventId', String(lastEventId))
  // Keep the URL stable with the previous encoder contract (`%20` for
  // spaces) while still using URLSearchParams for safe cursor composition.
  const suffix = query.toString().replace(/\+/g, '%20')
  return `/api/tty/executions/${encodeURIComponent(executionId)}/stream${suffix ? `?${suffix}` : ''}`
}

export function parseTTYStreamMessage(data: string): TTYStreamEvent | null {
  return parseTTYStreamEvent(data)
}

export function hasTTYStreamSequenceGap(previousSequence: number, event: TTYStreamEvent): boolean {
  return previousSequence > 0 && event.sequence > previousSequence + 1
}

export function appendTTYStreamEvents(
  existing: readonly TTYStreamEvent[],
  incoming: readonly TTYStreamEvent[],
  maxEvents: number,
): readonly TTYStreamEvent[] {
  const boundedMax = Math.max(100, Math.min(100_000, Math.floor(maxEvents)))
  const bySequence = new Map<number, TTYStreamEvent>()
  for (const event of existing) bySequence.set(event.sequence, event)
  for (const event of incoming) bySequence.set(event.sequence, event)
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence).slice(-boundedMax)
}

export function isTTYStreamTerminal(event: TTYStreamEvent): boolean {
  return (
    event.type === 'completion' &&
    ['succeeded', 'failed', 'cancelled', 'timed_out', 'expired'].includes(event.payload.state)
  )
}

/**
 * Returns the authoritative execution state already received by the browser.
 * The durable workspace snapshot can lag behind the live execution stream;
 * Runtime OS surfaces must project this value immediately without waiting for
 * a refresh.
 */
export function latestTTYStreamExecutionState(events: readonly TTYStreamEvent[]): TTYExecutionState | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'completion' && isTTYExecutionState(event.payload.state)) return event.payload.state
    if (event?.type === 'state' && isTTYExecutionState(event.payload.state)) return event.payload.state
  }
  return null
}

/**
 * Overlays a live stream state on the server-provided execution history. This
 * keeps the history card and status panels consistent while the durable
 * investigation snapshot catches up asynchronously.
 */
export function projectTTYExecutionHistoryState<T extends { readonly executionId: string; readonly state: string }>(
  entries: readonly T[],
  executionId: string | null | undefined,
  state: TTYExecutionState | null,
): readonly T[] {
  if (!executionId || !state) return entries
  return entries.map((entry) => (entry.executionId === executionId ? { ...entry, state } : entry))
}

/**
 * The live broker is an acceleration layer. A replay gap or an unavailable
 * broker must always send the browser to the authoritative durable-output
 * endpoint before it attempts another live connection.
 */
export function requiresTTYDurableRecovery(event: TTYStreamEvent): boolean {
  return event.type === 'error' && (event.payload.code === 'STREAM_GAP' || event.payload.code === 'STREAM_UNAVAILABLE')
}
