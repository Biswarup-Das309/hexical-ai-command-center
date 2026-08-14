import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TTYSessionControlConsumer,
  publishTTYSessionControl,
  type TTYSessionControlEntry,
} from '../../lib/tty/tty-session-control'
import type { TTYSessionId } from '../../lib/tty/tty-types'
import { ttySessionControlGroup, ttySessionControlStreamKey } from '../../lib/tty/tty-worker-keys'

class ControlRedisFake {
  entries: Array<readonly [string, Record<string, unknown>]> = []
  acknowledgements: string[] = []
  groupCreates = 0
  groupOptions: unknown[] = []
  expirationSeconds: number | null = null
  pending: readonly [string, Record<string, unknown>][] = []

  async xgroup(_key: string, options: unknown): Promise<string> {
    this.groupCreates += 1
    this.groupOptions.push(options)
    if (this.groupCreates > 1) throw new Error('BUSYGROUP Consumer Group name already exists')
    return 'OK'
  }

  async xadd(_key: string, _id: '*', fields: Record<string, unknown>): Promise<string> {
    const id = `${this.entries.length + 1}-0`
    this.entries.push([id, fields])
    return id
  }

  async expire(_key: string, seconds: number): Promise<number> {
    this.expirationSeconds = seconds
    return 1
  }

  async xautoclaim(): Promise<unknown[]> {
    const pending = this.pending
    this.pending = []
    return ['0-0', pending]
  }

  async xreadgroup(): Promise<unknown[]> {
    const unread = this.entries.splice(0)
    return unread.length === 0 ? [] : [[ttySessionControlStreamKey(), unread]]
  }

  async xack(_key: string, _group: string, id: string): Promise<number> {
    this.acknowledgements.push(id)
    return 1
  }
}

const sessionId = '00000000-0000-4000-8000-000000009101' as TTYSessionId

test('control publisher creates one durable consumer group and appends a bounded command', async () => {
  const redis = new ControlRedisFake()
  const streamId = await publishTTYSessionControl(redis as never, {
    sessionId,
    ownerUserId: 'user-one',
    type: 'write',
    data: 'echo persistent\n',
  })

  assert.equal(streamId, '1-0')
  assert.equal(redis.groupCreates, 1)
  assert.deepEqual(redis.groupOptions[0], {
    type: 'CREATE',
    group: ttySessionControlGroup(),
    id: '0-0',
    options: { MKSTREAM: true },
  })
  assert.equal(redis.expirationSeconds, 7 * 24 * 60 * 60)
  assert.equal(redis.entries[0]?.[1].sessionId, sessionId)
  assert.equal(redis.entries[0]?.[1].type, 'write')
})

test('consumer processes fresh, reclaimed, and malformed commands with durable acknowledgements', async () => {
  const redis = new ControlRedisFake()
  redis.pending = [
    [
      '9-0',
      {
        commandId: 'reclaimed-command',
        sessionId,
        ownerUserId: 'user-one',
        type: 'resize',
        columns: '120',
        rows: '40',
        timestamp: '2026-08-11T10:00:00.000Z',
      },
    ],
  ]
  redis.entries.push(
    [
      '10-0',
      {
        commandId: 'fresh-command',
        sessionId,
        ownerUserId: 'user-one',
        type: 'write',
        data: 'echo recovered\n',
        timestamp: '2026-08-11T10:00:01.000Z',
      },
    ],
    ['11-0', { malformed: true }],
  )
  const handled: TTYSessionControlEntry[] = []
  const consumer = new TTYSessionControlConsumer(redis as never, 'worker-control-test', {
    handle: async (command) => void handled.push(command),
  })

  await consumer.start()
  await consumer.stop()

  assert.deepEqual(
    handled.map((command) => command.commandId),
    ['reclaimed-command', 'fresh-command'],
  )
  assert.deepEqual(redis.acknowledgements.sort(), ['10-0', '11-0', '9-0'])
  assert.equal(ttySessionControlGroup(), 'tty-session-workers-v1')
})

test('consumer acknowledges malformed flat Redis fields by their stream entry ID', async () => {
  const redis = new ControlRedisFake()
  redis.entries.push(['13-0', ['commandId', 'malformed-command', 'sessionId', sessionId, 'type', 'open']] as never)
  const consumer = new TTYSessionControlConsumer(redis as never, 'worker-control-malformed-fields', {
    handle: async () => undefined,
  })

  await consumer.start()
  await consumer.stop()

  assert.deepEqual(redis.acknowledgements, ['13-0'])
})

test('consumer leaves a failed command pending for reclamation instead of acknowledging it', async () => {
  const redis = new ControlRedisFake()
  redis.entries.push([
    '12-0',
    {
      commandId: 'retry-command',
      sessionId,
      ownerUserId: 'user-one',
      type: 'terminate',
      timestamp: '2026-08-11T10:00:02.000Z',
    },
  ])
  const consumer = new TTYSessionControlConsumer(redis as never, 'worker-control-failure-test', {
    handle: async () => Promise.reject(new Error('temporary worker failure')),
  })

  await consumer.start()
  await consumer.stop()

  assert.deepEqual(redis.acknowledgements, [])
})

test('consumer labels Redis stream startup failures with the affected stream and group', async () => {
  const redis = new ControlRedisFake()
  redis.xautoclaim = async () => {
    throw new Error('ERR invalid stream id')
  }
  const consumer = new TTYSessionControlConsumer(redis as never, 'worker-control-diagnostics', {
    handle: async () => undefined,
  })

  await assert.rejects(() => consumer.start(), {
    message:
      /TTY control stream poll failed for tty:sessions:control\/tty-session-workers-v1: xautoclaim failed for tty:sessions:control\/tty-session-workers-v1: ERR invalid stream id/,
  })
})
