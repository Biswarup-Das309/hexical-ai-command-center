import test from 'node:test'
import assert from 'node:assert/strict'

import { appendTTYStreamEvents, buildTTYStreamUrl, hasTTYStreamSequenceGap, parseTTYStreamMessage } from '@/lib/tty/tty-stream-client'
import { createTTYStreamEvent } from '@/lib/tty/tty-stream-types'

const executionId = 'execution-1' as never
const sessionId = 'session-1' as never

function event(sequence: number, type: 'stdout' | 'completion' = 'stdout') {
  if (type === 'completion') return createTTYStreamEvent({
    executionId,
    sessionId,
    sequence,
    timestamp: '2026-08-09T00:00:00.000Z',
    type,
    payload: { state: 'succeeded', exitCode: 0, signal: null, failureCode: null }
  })
  return createTTYStreamEvent({
    executionId,
    sessionId,
    sequence,
    timestamp: '2026-08-09T00:00:00.000Z',
    type,
    payload: { text: String(sequence), byteLength: 1 }
  })
}

test('client builds the browser-safe SSE URL and parses event frames', () => {
  assert.equal(buildTTYStreamUrl('exec/1', 'session 1'), '/api/tty/executions/exec%2F1/stream?sessionId=session%201')
  assert.equal(buildTTYStreamUrl('exec/1', 'session 1', 42), '/api/tty/executions/exec%2F1/stream?sessionId=session%201&lastEventId=42')
  const parsed = parseTTYStreamMessage(JSON.stringify(event(1)))
  assert.equal(parsed?.sequence, 1)
  assert.equal(parseTTYStreamMessage('{"type":"stdout"}'), null)
})

test('client detects sequence gaps and deduplicates a replay into a bounded ordered ring', () => {
  assert.equal(hasTTYStreamSequenceGap(1, event(3)), true)
  assert.equal(hasTTYStreamSequenceGap(1, event(2)), false)
  const result = appendTTYStreamEvents([event(1), event(2)], [event(2), event(3), event(4)], 100)
  assert.deepEqual(result.map(item => item.sequence), [1, 2, 3, 4])
  const bounded = appendTTYStreamEvents(result, [event(5), event(6)], 100)
  assert.deepEqual(bounded.map(item => item.sequence), [1, 2, 3, 4, 5, 6])
})
