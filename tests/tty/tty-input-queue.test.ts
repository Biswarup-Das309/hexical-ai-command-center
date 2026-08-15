import assert from 'node:assert/strict'
import test from 'node:test'
import { createTTYInputQueue } from '../../lib/tty/tty-input-queue'

test('PTY input queue preserves xterm keystroke order', async () => {
  const delivered: string[] = []
  const queue = createTTYInputQueue(async (data) => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    delivered.push(data)
  })

  await Promise.all([...'echo HELLO\\r'].map((character) => queue.enqueue(character)))

  assert.equal(delivered.join(''), 'echo HELLO\\r')
  assert.equal(delivered.length, 1)
})

test('PTY input queue continues after a failed write', async () => {
  const delivered: string[] = []
  let attempts = 0
  const queue = createTTYInputQueue(async (data) => {
    attempts += 1
    if (attempts === 1) throw new Error('temporary control failure')
    delivered.push(data)
  })

  await assert.rejects(queue.enqueue('first'))
  await queue.enqueue('second')

  assert.deepEqual(delivered, ['second'])
})
