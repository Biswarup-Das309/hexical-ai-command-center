import type { TTYInputBatch } from './tty-input-queue'
import { summarizeTTYLatencies, type TTYLatencySummary } from './tty-latency'

export interface TTYBrowserInputLatencySnapshot {
  readonly sampleCount: number
  readonly browserToFlush: TTYLatencySummary
  readonly queueWait: TTYLatencySummary
}

const MAX_SAMPLES = 256
const samples: Array<{ readonly browserToFlushMs: number; readonly queueWaitMs: number }> = []

function snapshot(): TTYBrowserInputLatencySnapshot {
  return Object.freeze({
    sampleCount: samples.length,
    browserToFlush: summarizeTTYLatencies(samples.map((sample) => sample.browserToFlushMs)),
    queueWait: summarizeTTYLatencies(samples.map((sample) => sample.queueWaitMs)),
  })
}

function expose(): void {
  if (typeof window === 'undefined') return
  ;(window as Window & { __hexicalTTYInputLatency?: () => TTYBrowserInputLatencySnapshot }).__hexicalTTYInputLatency =
    snapshot
}

/** Records timing only; input bytes and command text are never retained. */
export function recordTTYBrowserInputLatency(batch: TTYInputBatch): void {
  const browserToFlushMs = batch.flushedAtMs - batch.browserTimestampMs
  if (!Number.isFinite(browserToFlushMs) || browserToFlushMs < 0 || !Number.isFinite(batch.queueWaitMs)) return
  samples.push(Object.freeze({ browserToFlushMs, queueWaitMs: batch.queueWaitMs }))
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES)
  expose()
}

export function getTTYBrowserInputLatencySnapshot(): TTYBrowserInputLatencySnapshot {
  return snapshot()
}

expose()
