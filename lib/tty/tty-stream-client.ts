import { parseTTYStreamEvent, type TTYStreamEvent } from './tty-stream-types'

export type TTYStreamClientConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'completed' | 'error'

export function buildTTYStreamUrl(executionId: string, sessionId?: string): string {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
  return `/api/tty/executions/${encodeURIComponent(executionId)}/stream${query}`
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
  maxEvents: number
): readonly TTYStreamEvent[] {
  const boundedMax = Math.max(100, Math.min(100_000, Math.floor(maxEvents)))
  const bySequence = new Map<number, TTYStreamEvent>()
  for (const event of existing) bySequence.set(event.sequence, event)
  for (const event of incoming) bySequence.set(event.sequence, event)
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence).slice(-boundedMax)
}

export function isTTYStreamTerminal(event: TTYStreamEvent): boolean {
  return event.type === 'completion' && ['succeeded', 'failed', 'cancelled', 'timed_out', 'expired'].includes(event.payload.state)
}

