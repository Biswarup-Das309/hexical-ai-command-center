import assert from 'node:assert/strict'
import test from 'node:test'
import type { TTYSessionTranscriptEvent } from '../../lib/tty/tty-session-transcript'
import { summarizeTTYTranscript } from '../../lib/tty/tty-transcript-diagnostics'

const sessionId = '00000000-0000-4000-8000-000000009999' as never

function output(eventId: string, sequence: number): TTYSessionTranscriptEvent {
  return {
    cursor: `${sequence}-0`,
    eventId,
    sequence,
    timestamp: '2026-08-18T00:00:00.000Z',
    sessionId,
    type: 'stdout',
    data: { text: 'x\n', byteLength: 2 },
  }
}

test('transcript diagnostics count authoritative duplicates and sequence gaps', () => {
  const diagnostics = summarizeTTYTranscript([output('event-a', 1), output('event-a', 1), output('event-c', 3)])
  assert.equal(diagnostics.eventCount, 3)
  assert.equal(diagnostics.uniqueEventCount, 2)
  assert.equal(diagnostics.duplicateEventCount, 1)
  assert.equal(diagnostics.sequenceGapCount, 1)
  assert.equal(diagnostics.outOfOrderEventCount, 1)
  assert.equal(diagnostics.outputBytes, 6)
})
