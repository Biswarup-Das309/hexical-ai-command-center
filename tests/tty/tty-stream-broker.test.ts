import test from 'node:test'
import assert from 'node:assert/strict'

import { TTYStreamBroker } from '@/lib/tty/tty-stream-broker'
import { createTTYExecutionId, createTTYSessionId } from '@/lib/tty/tty-types'
import { WorkerRedisMock } from './worker-redis-mock'

function ids() {
  return { executionId: createTTYExecutionId(), sessionId: createTTYSessionId() }
}

test('broker preserves per-execution ordering for concurrent publishers', async () => {
  const broker = new TTYStreamBroker(null)
  const { executionId, sessionId } = ids()
  const received: number[] = []
  await broker.subscribe(executionId, event => received.push(event.sequence))
  const events = await Promise.all(Array.from({ length: 12 }, (_, index) => broker.publish({
    executionId,
    sessionId,
    type: 'stdout',
    payload: { text: String(index), byteLength: 1 }
  })))

  assert.deepEqual(events.map(event => event.sequence).sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index + 1))
  assert.deepEqual(received, Array.from({ length: 12 }, (_, index) => index + 1))
})

test('Redis replay survives a new broker instance and detects an expired window', async () => {
  const redis = new WorkerRedisMock()
  const first = new TTYStreamBroker(redis, { maxBufferedEvents: 2, maxReplayEvents: 32 })
  const { executionId, sessionId } = ids()
  await first.publish({ executionId, sessionId, type: 'state', payload: { state: 'running' } })
  await first.publish({ executionId, sessionId, type: 'stdout', payload: { text: 'one', byteLength: 3 } })
  await first.publish({ executionId, sessionId, type: 'completion', payload: { state: 'succeeded', exitCode: 0, signal: null, failureCode: null } })

  const second = new TTYStreamBroker(redis, { maxBufferedEvents: 2, maxReplayEvents: 32 })
  const replay = await second.replay(executionId, 1)
  assert.equal(replay.status, 'ok')
  assert.deepEqual(replay.events.map(event => event.sequence), [2, 3])
  assert.equal(replay.completed, true)

  const bounded = new TTYStreamBroker(null, { maxBufferedEvents: 2 })
  await bounded.publish({ executionId, sessionId, type: 'stdout', payload: { text: '1', byteLength: 1 } })
  await bounded.publish({ executionId, sessionId, type: 'stdout', payload: { text: '2', byteLength: 1 } })
  await bounded.publish({ executionId, sessionId, type: 'stdout', payload: { text: '3', byteLength: 1 } })
  const gap = await bounded.replay(executionId, 0)
  assert.equal(gap.status, 'gap')
  assert.deepEqual(gap.events.map(event => event.sequence), [2, 3])

  const retainedRedis = new WorkerRedisMock()
  const producer = new TTYStreamBroker(retainedRedis, { maxReplayEvents: 2 })
  await producer.publish({ executionId, sessionId, type: 'stdout', payload: { text: 'a', byteLength: 1 } })
  await producer.publish({ executionId, sessionId, type: 'stdout', payload: { text: 'b', byteLength: 1 } })
  await producer.publish({ executionId, sessionId, type: 'stdout', payload: { text: 'c', byteLength: 1 } })
  const retainedReplay = await new TTYStreamBroker(retainedRedis, { maxReplayEvents: 2 }).replay(executionId, 0)
  assert.equal(retainedReplay.status, 'gap')
  assert.deepEqual(retainedReplay.events.map(event => event.sequence), [2, 3])
})

test('subscription replay is ordered before subsequent live events', async () => {
  const broker = new TTYStreamBroker(null)
  const { executionId, sessionId } = ids()
  await broker.publish({ executionId, sessionId, type: 'stdout', payload: { text: 'before', byteLength: 6 } })
  const received: number[] = []
  const subscription = await broker.subscribe(executionId, event => received.push(event.sequence), 0)
  for (const event of subscription.replay.events) received.push(event.sequence)
  await broker.publish({ executionId, sessionId, type: 'stdout', payload: { text: 'after', byteLength: 5 } })
  assert.deepEqual(received, [1, 2])
  subscription.unsubscribe()
  assert.equal(broker.subscriberCount(executionId), 0)
})

test('a Redis-backed subscriber receives events published by another broker instance', async () => {
  const redis = new WorkerRedisMock()
  const producer = new TTYStreamBroker(redis)
  const viewer = new TTYStreamBroker(redis, { redisPollIntervalMs: 50 })
  const { executionId, sessionId } = ids()
  const received: number[] = []
  const subscription = await viewer.subscribe(executionId, event => received.push(event.sequence))
  await producer.publish({ executionId, sessionId, type: 'stdout', payload: { text: 'cross-instance', byteLength: 14 } })
  await new Promise(resolve => setTimeout(resolve, 120))
  subscription.unsubscribe()
  viewer.close()
  assert.deepEqual(received, [1])
})

test('a Redis sequence outage fails closed instead of inventing an instance-local cursor', async () => {
  const redis = {
    incr: async () => { throw new Error('redis unavailable') },
    xadd: async () => { throw new Error('redis unavailable') },
    xrange: async () => [],
    eval: async () => { throw new Error('redis unavailable') }
  }
  const broker = new TTYStreamBroker(redis)
  const { executionId, sessionId } = ids()
  await assert.rejects(
    broker.publish({ executionId, sessionId, type: 'stdout', payload: { text: 'must not fork', byteLength: 13 } }),
    /redis unavailable/
  )
  assert.equal(broker.subscriberCount(executionId), 0)
})
