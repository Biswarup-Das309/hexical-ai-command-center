import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createTTYStreamEvent,
  parseTTYStreamEvent,
  serializeTTYStreamEvent,
  validateTTYStreamEvent,
} from '@/lib/tty/tty-stream-types'
import { createTTYExecutionId, createTTYSessionId } from '@/lib/tty/tty-types'

test('stream events are immutable and carry the complete browser-safe envelope', () => {
  const event = createTTYStreamEvent({
    executionId: createTTYExecutionId(),
    sessionId: createTTYSessionId(),
    sequence: 1,
    timestamp: '2026-08-09T00:00:00.000Z',
    type: 'stdout',
    payload: { text: 'hello', byteLength: 5 }
  })

  assert.equal(event.type, 'stdout')
  assert.equal(event.payload.text, 'hello')
  assert.equal(Object.isFrozen(event), true)
  assert.equal(Object.isFrozen(event.payload), true)
  assert.equal(validateTTYStreamEvent(event), true)
})

test('stream events serialize and validate deterministically', () => {
  const event = createTTYStreamEvent({
    eventId: 'event-1' as never,
    executionId: 'execution-1' as never,
    sessionId: 'session-1' as never,
    sequence: 7,
    timestamp: '2026-08-09T00:00:00.000Z',
    type: 'completion',
    payload: { state: 'succeeded', exitCode: 0, signal: null, failureCode: null }
  })
  const roundTrip = parseTTYStreamEvent(serializeTTYStreamEvent(event))
  assert.deepEqual(roundTrip, event)
  assert.equal(parseTTYStreamEvent('{"type":"stdout"}'), null)
  assert.equal(validateTTYStreamEvent({ ...event, sequence: 0 }), false)
})

test('invalid payloads cannot be constructed or parsed', () => {
  assert.throws(() => createTTYStreamEvent({
    executionId: 'execution-1' as never,
    sessionId: 'session-1' as never,
    sequence: 1,
    timestamp: '2026-08-09T00:00:00.000Z',
    type: 'completion',
    payload: { state: 'running', exitCode: null, signal: null, failureCode: null } as never
  }))

  const unsafe = JSON.stringify({
    eventId: 'event-1', executionId: 'execution-1', sessionId: 'session-1', sequence: 1,
    timestamp: '2026-08-09T00:00:00.000Z', type: 'error',
    payload: { code: 'INTERNAL_ERROR', message: 'safe', recoverable: true, workerId: 'secret' }
  })
  const parsed = parseTTYStreamEvent(unsafe)
  assert.equal(parsed, null)
})
