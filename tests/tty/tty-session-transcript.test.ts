import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkerRedisMock } from './worker-redis-mock'
import { TTYSessionTranscriptManager } from '../../lib/tty/tty-session-transcript'
import type { TTYSessionId } from '../../lib/tty/tty-types'

const sessionId = '00000000-0000-4000-8000-000000009201' as TTYSessionId

test('persistent-session transcript preserves ordered output and browser-safe system state', async () => {
  const redis = new WorkerRedisMock()
  const transcript = new TTYSessionTranscriptManager(redis as never)
  await Promise.all([
    transcript.appendSystem({ sessionId, event: 'pty_attached', data: { workerId: 'worker-a', pid: 11 } }),
    transcript.appendOutput({ sessionId, text: 'HEXICAL_RUNTIME_OS_TEST\n' }),
    transcript.appendSystem({ sessionId, event: 'terminal_resized', data: { columns: 120, rows: 40 } }),
  ])

  const replay = await transcript.read(sessionId)
  assert.deepEqual(
    replay.map((event) => event.sequence),
    [1, 2, 3],
  )
  assert.equal(replay.filter((event) => event.type === 'stdout')[0]?.data.text, 'HEXICAL_RUNTIME_OS_TEST\n')
  assert.equal(
    replay.some((event) => event.data.event === 'pty_attached'),
    true,
  )
  assert.equal(
    replay.some((event) => event.data.event === 'terminal_resized'),
    true,
  )
})

test('persistent-session transcript chunks large Unicode PTY output without corrupting replay', async () => {
  const redis = new WorkerRedisMock()
  const transcript = new TTYSessionTranscriptManager(redis as never)
  const text = '🧪'.repeat(20_000)

  const appended = await transcript.appendOutput({ sessionId, text })
  const replay = await transcript.read(sessionId)

  assert.ok(appended.length > 1)
  assert.equal(replay.map((event) => String(event.data.text ?? '')).join(''), text)
  assert.ok(replay.every((event) => Number(event.data.byteLength) <= 60 * 1024))
})

test('persistent-session transcript accepts Upstash object-shaped replay responses', async () => {
  const redis = {
    xrange: async () => ({
      '1786387000000-0': {
        eventId: 'session-transcript-upstash',
        sequence: 1,
        timestamp: '2026-08-11T10:00:00.000Z',
        sessionId,
        type: 'stdout',
        data: { text: 'replayed\n', byteLength: 9 },
      },
    }),
  }

  const replay = await new TTYSessionTranscriptManager(redis as never).read(sessionId)
  assert.equal(replay.length, 1)
  assert.equal(replay[0]?.data.text, 'replayed\n')
})

test('persistent-session transcript deduplicates a journal event retried after a worker crash', async () => {
  const redis = new WorkerRedisMock()
  const transcript = new TTYSessionTranscriptManager(redis as never)
  await transcript.appendOutput({
    sessionId,
    text: 'once\n',
    eventId: 'journal-offset-0',
    executionId: 'execution-journal',
  })
  await transcript.appendOutput({
    sessionId,
    text: 'once\n',
    eventId: 'journal-offset-0',
    executionId: 'execution-journal',
  })

  const replay = await transcript.read(sessionId)
  assert.equal(replay.filter((event) => event.type === 'stdout' && event.data.text === 'once\n').length, 1)
})
