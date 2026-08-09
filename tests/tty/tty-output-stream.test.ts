import test from 'node:test'
import assert from 'node:assert/strict'

import { TTYOutputStreamManager } from '../../lib/tty/tty-output-stream'
import type { TTYExecutionId, TTYSessionId } from '../../lib/tty/tty-types'
import { WorkerRedisMock } from './worker-redis-mock'

const executionId = '00000000-0000-4000-8000-000000000401' as TTYExecutionId
const sessionId = '00000000-0000-4000-8000-000000000402' as TTYSessionId

test('output stream assigns ordered per-execution sequences under concurrent appends', async () => {
  const redis = new WorkerRedisMock()
  const stream = new TTYOutputStreamManager(redis as never)
  const events = await Promise.all([
    stream.appendOutput({ executionId, sessionId, stream: 'stdout', text: 'one' }),
    stream.appendOutput({ executionId, sessionId, stream: 'stderr', text: 'two' }),
    stream.appendState({ executionId, sessionId, state: 'running' }),
    stream.appendMetric({ executionId, sessionId, name: 'queue_wait_ms', value: 12 })
  ])

  assert.deepEqual(events.map(event => event.sequence).sort((a, b) => a - b), [1, 2, 3, 4])
  const replay = await stream.read(executionId)
  assert.deepEqual(replay.map(event => event.sequence), [1, 2, 3, 4])
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

test('output stream rejects oversized event payloads before Redis persistence', async () => {
  const redis = new WorkerRedisMock()
  const stream = new TTYOutputStreamManager(redis as never)
  await assert.rejects(
    stream.appendOutput({ executionId, sessionId, stream: 'stdout', text: 'x'.repeat(70 * 1024) }),
    /Invalid TTY output event/
  )
  assert.equal((await stream.read(executionId)).length, 0)
})

