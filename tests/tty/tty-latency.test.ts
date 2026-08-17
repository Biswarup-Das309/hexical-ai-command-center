import assert from 'node:assert/strict'
import test from 'node:test'
import { getTTYBrowserLatencySnapshot, recordTTYBrowserOutputLatency } from '../../lib/tty/tty-browser-latency'
import { getTTYBrowserInputLatencySnapshot, recordTTYBrowserInputLatency } from '../../lib/tty/tty-input-latency'
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

test('browser input telemetry measures only bounded local flush timing', () => {
  recordTTYBrowserInputLatency({
    data: 'not retained',
    sequence: 1,
    inputEventId: 'input-1',
    browserTimestampMs: 100,
    flushedAtMs: 103,
    queueWaitMs: 3,
  })
  const snapshot = getTTYBrowserInputLatencySnapshot()
  assert.equal(snapshot.sampleCount, 1)
  assert.equal(snapshot.browserToFlush.p50Ms, 3)
  assert.equal(snapshot.queueWait.p50Ms, 3)
})
