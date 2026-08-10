import assert from 'node:assert/strict'
import test from 'node:test'
import { createTTYStreamEvent } from '@/lib/tty/tty-stream-types'
import { TTYTerminalRenderer, renderTTYStreamEvent } from '@/lib/tty/tty-terminal-renderer'

const executionId = 'execution-1' as never
const sessionId = 'session-1' as never

function output(sequence: number, text: string, type: 'stdout' | 'stderr' = 'stdout') {
  return createTTYStreamEvent({
    executionId,
    sessionId,
    sequence,
    timestamp: '2026-08-09T01:02:03.000Z',
    type,
    payload: { text, byteLength: Buffer.byteLength(text) },
  })
}

test('renderer preserves ANSI escape sequences and partial output chunks', () => {
  const writes: string[] = []
  const renderer = new TTYTerminalRenderer({ write: (value) => writes.push(value) })
  renderer.render(output(1, '\u001b[31mred'))
  renderer.render(output(2, ' text\u001b[0m'))
  assert.equal(writes.join(''), '\u001b[31mred text\u001b[0m')
  assert.equal(renderer.sequence, 2)
})

test('renderer converts lifecycle events to timestamped system lines and ignores duplicates', () => {
  const writes: string[] = []
  const state = createTTYStreamEvent({
    executionId,
    sessionId,
    sequence: 3,
    timestamp: '2026-08-09T01:02:03.000Z',
    type: 'state',
    payload: { state: 'running' },
  })
  const duplicate = createTTYStreamEvent({
    executionId,
    sessionId,
    sequence: 3,
    timestamp: '2026-08-09T01:02:03.000Z',
    type: 'state',
    payload: { state: 'running' },
  })
  const result = renderTTYStreamEvent(state, { write: (value) => writes.push(value) }, 0)
  const ignored = renderTTYStreamEvent(duplicate, { write: (value) => writes.push(value) }, 3)
  assert.equal(result.rendered, true)
  assert.match(writes[0]!, /01:02:03.*STATE.*running/)
  assert.deepEqual(ignored, { rendered: false, duplicate: true, gap: false })
})
