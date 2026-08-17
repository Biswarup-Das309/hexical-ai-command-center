import assert from 'node:assert/strict'
import test from 'node:test'
import { getTTYBrowserLatencySnapshot, recordTTYBrowserOutputLatency } from '../../lib/tty/tty-browser-latency'
import { summarizeTTYLatencies } from '../../lib/tty/tty-latency'

test('latency summaries report p50, p95, p99, and max without raw content', () => {
  const summary = summarizeTTYLatencies([4, 1, 8, 2, 16])
  assert.deepEqual(summary, { count: 5, p50Ms: 4, p95Ms: 16, p99Ms: 16, maxMs: 16 })
})

test('browser output telemetry retains timing-only samples', () => {
  recordTTYBrowserOutputLatency({
    workerReceivedTimestampMs: 100,
    ptyOutputTimestampMs: 101,
    browserReceivedTimestampMs: 115,
    renderTimestampMs: 116,
  })
  const snapshot = getTTYBrowserLatencySnapshot()
  assert.equal(snapshot.outputWorkerToBrowser.p50Ms, 15)
  assert.equal(snapshot.outputBrowserToRender.p50Ms, 1)
  assert.equal(snapshot.outputWorkerToRender.p50Ms, 16)
})
