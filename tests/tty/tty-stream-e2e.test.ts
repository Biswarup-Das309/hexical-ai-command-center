import assert from 'node:assert/strict'
import test from 'node:test'
import { TTYStreamBroker } from '@/lib/tty/tty-stream-broker'
import { createTTYExecutionId, createTTYSessionId } from '@/lib/tty/tty-types'

test('one execution remains ordered and leak-free for 100 concurrent viewers', async () => {
  const broker = new TTYStreamBroker(null, { maxBufferedEvents: 256 })
  const executionId = createTTYExecutionId()
  const sessionId = createTTYSessionId()
  const received = Array.from({ length: 100 }, () => [] as number[])
  const subscriptions = await Promise.all(
    received.map((events, index) => broker.subscribe(executionId, (event) => events.push(event.sequence), index)),
  )

  for (let index = 0; index < 24; index += 1) {
    if (index % 3 === 0)
      await broker.publish({ executionId, sessionId, type: 'state', payload: { state: 'streaming' } })
    else
      await broker.publish({
        executionId,
        sessionId,
        type: 'stdout',
        payload: { text: `chunk-${index}`, byteLength: 8 },
      })
  }
  await broker.publish({
    executionId,
    sessionId,
    type: 'completion',
    payload: { state: 'cancelled', exitCode: null, signal: 'SIGTERM', failureCode: 'CANCELLED' },
  })

  const expected = Array.from({ length: 25 }, (_, index) => index + 1)
  for (const events of received) assert.deepEqual(events, expected)
  for (const subscription of subscriptions) subscription.unsubscribe()
  assert.equal(broker.subscriberCount(executionId), 0)
  broker.close(executionId)
  assert.equal(broker.subscriberCount(executionId), 0)
})
