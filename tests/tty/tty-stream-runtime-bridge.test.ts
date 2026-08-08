import test from 'node:test'
import assert from 'node:assert/strict'

import { TTYStreamBroker } from '@/lib/tty/tty-stream-broker'
import { TTYStreamingOutputStreamManager } from '@/lib/tty/tty-stream-runtime-bridge'
import { createTTYExecutionId, createTTYSessionId } from '@/lib/tty/tty-types'
import { WorkerRedisMock } from './worker-redis-mock'

test('runtime bridge preserves the frozen durable output API and publishes browser-safe events', async () => {
  const redis = new WorkerRedisMock()
  const broker = new TTYStreamBroker(redis)
  const output = new TTYStreamingOutputStreamManager(redis as never, broker)
  const executionId = createTTYExecutionId()
  const sessionId = createTTYSessionId()

  await Promise.all([
    output.appendOutput({ executionId, sessionId, stream: 'stdout', text: 'out' }),
    output.appendOutput({ executionId, sessionId, stream: 'stderr', text: 'err' }),
    output.appendState({ executionId, sessionId, state: 'running' }),
    output.appendMetric({ executionId, sessionId, name: 'durationMs', value: 4 }),
    output.appendCompletion({ executionId, sessionId, state: 'succeeded' })
  ])

  const durable = await output.read(executionId)
  const live = await broker.replay(executionId)
  assert.equal(durable.length, 5)
  assert.deepEqual(live.events.map(event => event.type), ['stdout', 'stderr', 'state', 'metric', 'completion'])
  assert.deepEqual(live.events.map(event => event.sequence), [1, 2, 3, 4, 5])
  assert.equal(live.completed, true)
  assert.equal('workerId' in live.events[0]!, false)
})

