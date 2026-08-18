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

test('PTY input queue micro-batches a burst and flushes Enter immediately', async () => {
  const delivered: string[] = []
  const queue = createTTYInputQueue(async (data) => {
    delivered.push(data)
  })

  const first = queue.enqueue('echo ')
  const second = queue.enqueue('HELLO')
  const third = queue.enqueue('\r')
  await Promise.all([first, second, third])

  assert.deepEqual(delivered, ['echo HELLO\r'])
})

test('PTY input queue preserves adjacent Enter boundaries for rapid commands', async () => {
  const delivered: string[] = []
  const queue = createTTYInputQueue(async (data) => {
    delivered.push(data)
  })

  await Promise.all([
    queue.enqueue('echo PRE_ENTER_CHECK'),
    queue.enqueue('\r'),
    queue.enqueue('echo SECOND_NO_REFRESH_TEST'),
    queue.enqueue('\r'),
  ])

  assert.equal(delivered.join(''), 'echo PRE_ENTER_CHECK\recho SECOND_NO_REFRESH_TEST\r')
})

test('PTY input queue never imposes the old 100ms printable-key delay', async () => {
  const delivered: string[] = []
  const startedAt = Date.now()
  const queue = createTTYInputQueue(async (data) => {
    delivered.push(data)
  })

  await queue.enqueue('x')

  assert.deepEqual(delivered, ['x'])
  assert.ok(Date.now() - startedAt < 100)
})

test('PTY input queue attaches monotonic batch metadata without changing bytes', async () => {
  const batches: Array<{ data: string; sequence: number; inputEventId: string }> = []
  const queue = createTTYInputQueue(
    async (data, batch) => {
      batches.push({ data, sequence: batch.sequence, inputEventId: batch.inputEventId })
    },
    { now: () => 1_700_000_000_000 },
  )

  await queue.enqueue('a')
  await queue.enqueue('\u001b[A')

  assert.deepEqual(
    batches.map(({ data, sequence }) => ({ data, sequence })),
    [
      { data: 'a', sequence: 1 },
      { data: '\u001b[A', sequence: 2 },
    ],
  )
  assert.equal(
    batches.every(({ inputEventId }) => inputEventId.length > 0),
    true,
  )
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
