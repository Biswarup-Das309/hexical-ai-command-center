import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkerRedisMock } from './worker-redis-mock'
import { TTYOutputStreamManager } from '../../lib/tty/tty-output-stream'
import type { TTYExecutionId, TTYSessionId } from '../../lib/tty/tty-types'

const executionId = '00000000-0000-4000-8000-000000000401' as TTYExecutionId
const sessionId = '00000000-0000-4000-8000-000000000402' as TTYSessionId

test('output stream assigns ordered per-execution sequences under concurrent appends', async () => {
  const redis = new WorkerRedisMock()
  const stream = new TTYOutputStreamManager(redis as never)
  const events = await Promise.all([
    stream.appendOutput({ executionId, sessionId, stream: 'stdout', text: 'one' }),
    stream.appendOutput({ executionId, sessionId, stream: 'stderr', text: 'two' }),
    stream.appendState({ executionId, sessionId, state: 'running' }),
    stream.appendMetric({ executionId, sessionId, name: 'queue_wait_ms', value: 12 }),
  ])

  assert.deepEqual(
    events.map((event) => event.sequence).sort((a, b) => a - b),
    [1, 2, 3, 4],
  )
  const replay = await stream.read(executionId)
  assert.deepEqual(
    replay.map((event) => event.sequence),
    [1, 2, 3, 4],
  )
  assert.equal(replay[0]?.type, 'stdout')
  assert.equal(replay[1]?.type, 'stderr')
  assert.equal(replay[2]?.type, 'state')
  assert.deepEqual(replay[0]?.data, { text: 'one', byteLength: 3 })
  assert.deepEqual(replay[3]?.data, { name: 'queue_wait_ms', value: 12 })
})

test('output stream preserves terminal completion events and supports bounded reads', async () => {
  const redis = new WorkerRedisMock()
  const stream = new TTYOutputStreamManager(redis as never)
  await stream.appendOutput({ executionId, sessionId, stream: 'stdout', text: 'hello' })
  await stream.appendCompletion({ executionId, sessionId, state: 'succeeded' })

  const bounded = await stream.read(executionId, { count: 1 })
  assert.equal(bounded.length, 1)
  assert.equal(bounded[0]?.type, 'stdout')
  const all = await stream.read(executionId)
  assert.equal(all.at(-1)?.type, 'completion')
})

test('output stream deduplicates durable PTY output when journal replay retries the same event', async () => {
  const redis = new WorkerRedisMock()
  const stream = new TTYOutputStreamManager(redis as never)
  await stream.appendOutput({
    executionId,
    sessionId,
    stream: 'stdout',
    text: 'replayed-once',
    eventId: 'session-transcript-event-1',
    transport: 'persistent_pty',
  })
  await stream.appendOutput({
    executionId,
    sessionId,
    stream: 'stdout',
    text: 'replayed-once',
    eventId: 'session-transcript-event-1',
    transport: 'persistent_pty',
  })

  const replay = await stream.read(executionId)
  assert.equal(replay.filter((event) => event.type === 'stdout').length, 1)
})

test('output stream rejects oversized event payloads before Redis persistence', async () => {
  const redis = new WorkerRedisMock()
  const stream = new TTYOutputStreamManager(redis as never)
  await assert.rejects(
    stream.appendOutput({ executionId, sessionId, stream: 'stdout', text: 'x'.repeat(70 * 1024) }),
    /Invalid TTY output event/,
  )
  assert.equal((await stream.read(executionId)).length, 0)
})

test('output stream reads the object-shaped XRANGE response returned by Upstash Redis', async () => {
  const redis = {
    xrange: async () => ({
      '1786387000000-0': {
        eventId: 'output-event-upstash',
        sequence: 1,
        timestamp: '2026-08-11T10:00:00.000Z',
        executionId,
        sessionId,
        type: 'stdout',
        data: { text: 'HEXICAL_EXECUTE_SMOKE_TEST\n', byteLength: 29 },
      },
    }),
  }
  const events = await new TTYOutputStreamManager(redis as never).read(executionId)
  assert.equal(events.length, 1)
  assert.equal(events[0]?.type, 'stdout')
  assert.equal(events[0]?.data.text, 'HEXICAL_EXECUTE_SMOKE_TEST\n')
  assert.equal(events[0]?.data.byteLength, 29)
})
