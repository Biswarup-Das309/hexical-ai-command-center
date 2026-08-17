import { summarizeTTYLatencies, type TTYLatencySummary } from './tty-latency'
import type { TTYSessionTranscriptEvent } from './tty-session-transcript'

export interface TTYTranscriptDiagnostics {
  readonly complete: boolean
  readonly eventCount: number
  readonly uniqueEventCount: number
  readonly duplicateEventCount: number
  readonly sequenceGapCount: number
  readonly outOfOrderEventCount: number
  readonly firstSequence: number | null
  readonly lastSequence: number | null
  readonly outputEventCount: number
  /** PTY transcript bytes are intentionally combined; stderr is not faked as a separate stream. */
  readonly outputBytes: number
  readonly outputWorkerToPty: TTYLatencySummary
}

/**
 * Produces an aggregate-only transcript health report. Terminal text, command
 * input, paths, environment values, and worker identifiers never leave this
 * function. `complete=false` means the caller intentionally supplied a
 * bounded sample rather than the full retained transcript.
 */
export function summarizeTTYTranscript(
  events: readonly TTYSessionTranscriptEvent[],
  complete = true,
): TTYTranscriptDiagnostics {
  const eventIds = new Set<string>()
  const workerToPty: number[] = []
  let duplicateEventCount = 0
  let sequenceGapCount = 0
  let outOfOrderEventCount = 0
  let previousSequence: number | null = null
  let outputEventCount = 0
  let outputBytes = 0

  for (const event of events) {
    if (eventIds.has(event.eventId)) duplicateEventCount += 1
    eventIds.add(event.eventId)
    if (previousSequence !== null) {
      if (event.sequence <= previousSequence) outOfOrderEventCount += 1
      else sequenceGapCount += Math.max(0, event.sequence - previousSequence - 1)
    }
    previousSequence = event.sequence

    if (event.type !== 'stdout') continue
    outputEventCount += 1
    const byteLength = event.data.byteLength
    if (typeof byteLength === 'number' && Number.isSafeInteger(byteLength) && byteLength >= 0) {
      outputBytes += byteLength
    }
    const workerReceived = event.data.workerReceivedTimestampMs
    const ptyOutput = event.data.ptyOutputTimestampMs
    if (typeof workerReceived === 'number' && typeof ptyOutput === 'number') {
      const delta = ptyOutput - workerReceived
      if (Number.isFinite(delta) && delta >= 0) workerToPty.push(delta)
    }
  }

  return Object.freeze({
    complete,
    eventCount: events.length,
    uniqueEventCount: eventIds.size,
    duplicateEventCount,
    sequenceGapCount,
    outOfOrderEventCount,
    firstSequence: events[0]?.sequence ?? null,
    lastSequence: events.at(-1)?.sequence ?? null,
    outputEventCount,
    outputBytes,
    outputWorkerToPty: summarizeTTYLatencies(workerToPty),
  })
}
