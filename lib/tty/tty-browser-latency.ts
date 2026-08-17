import { summarizeTTYLatencies, type TTYLatencySummary } from './tty-latency'

export interface TTYBrowserOutputLatencySample {
  readonly workerReceivedTimestampMs: number
  readonly ptyOutputTimestampMs: number
  readonly browserReceivedTimestampMs: number
  readonly renderTimestampMs: number
}

export interface TTYBrowserLatencySnapshot {
  readonly outputWorkerToBrowser: TTYLatencySummary
  readonly outputBrowserToRender: TTYLatencySummary
  readonly outputWorkerToRender: TTYLatencySummary
}

const MAX_SAMPLES = 256
const samples: TTYBrowserOutputLatencySample[] = []

function snapshot(): TTYBrowserLatencySnapshot {
  return Object.freeze({
    outputWorkerToBrowser: summarizeTTYLatencies(
      samples.map((sample) => sample.browserReceivedTimestampMs - sample.workerReceivedTimestampMs),
    ),
    outputBrowserToRender: summarizeTTYLatencies(
      samples.map((sample) => sample.renderTimestampMs - sample.browserReceivedTimestampMs),
    ),
    outputWorkerToRender: summarizeTTYLatencies(
      samples.map((sample) => sample.renderTimestampMs - sample.workerReceivedTimestampMs),
    ),
  })
}

/**
 * Stores timing-only samples in the browser for an operator benchmark.  No
 * terminal bytes, command text, or credentials are retained.
 */
export function recordTTYBrowserOutputLatency(sample: TTYBrowserOutputLatencySample): void {
  if (
    ![
      sample.workerReceivedTimestampMs,
      sample.ptyOutputTimestampMs,
      sample.browserReceivedTimestampMs,
      sample.renderTimestampMs,
    ].every((value) => Number.isFinite(value))
  )
    return
  samples.push(Object.freeze({ ...sample }))
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES)
  if (typeof window !== 'undefined') {
    ;(window as Window & { __hexicalTTYLatency?: () => TTYBrowserLatencySnapshot }).__hexicalTTYLatency = snapshot
  }
}

export function getTTYBrowserLatencySnapshot(): TTYBrowserLatencySnapshot {
  return snapshot()
}
