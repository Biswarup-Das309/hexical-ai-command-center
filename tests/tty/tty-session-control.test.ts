import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TTYSessionControlConsumer,
  TTYSessionInputBroadcastConsumer,
  publishTTYSessionControl,
  type TTYSessionControlEntry,
} from '../../lib/tty/tty-session-control'
import { TTY_SESSION_INPUT_BROADCAST_EVENT } from '../../lib/tty/tty-session-input-channel'
import type { TTYSessionId } from '../../lib/tty/tty-types'
import {
  ttySessionControlGroup,
  ttySessionControlStreamKey,
  ttySessionInputChannelKey,
} from '../../lib/tty/tty-worker-keys'

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

class RealtimeControlRedisFake {
  private readonly values = new Map<string, string>()
  private callback: ((payload: { streamId: string; fields: unknown }) => void) | null = null
  historical: Array<readonly [string, Record<string, unknown>]> = []
  onSubscribe: (() => void) | null = null

  async xrange(): Promise<unknown[]> {
    return this.historical
  }

  async subscribeToStream(
    _streamKey: string,
    callback: (payload: { streamId: string; fields: unknown }) => void,
  ): Promise<() => void> {
    this.callback = callback
    this.onSubscribe?.()
    return () => {
      this.callback = null
    }
  }

  async set(key: string, value: string): Promise<string | null> {
    if (this.values.has(key)) return null
    this.values.set(key, value)
    return 'OK'
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0
  }

  emit(streamId: string, fields: Record<string, unknown>): void {
    this.callback?.({ streamId, fields })
  }
}

class BroadcastInputRedisFake {
  private readonly values = new Map<string, unknown>()
  private readonly callbacks = new Map<string, (payload: unknown) => void>()
  readonly subscriptions = new Map<string, number>()

  constructor(sessionRecords: readonly { sessionId: string; channel: string; token: string; ownerUserId: string }[]) {
    for (const record of sessionRecords) {
      this.values.set(ttySessionInputChannelKey(record.sessionId as TTYSessionId), {
        ...record,
        issuedAtMs: Date.now(),
      })
    }
    this.sessionIds = sessionRecords.map((record) => record.sessionId)
  }

  private readonly sessionIds: string[]

  async smembers(): Promise<string[]> {
    return this.sessionIds
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null
  }

  async set<T = unknown>(key: string, value: T): Promise<string> {
    this.values.set(key, value)
    return 'OK'
  }

  async del(key: string): Promise<number> {
    this.values.delete(key)
    return 1
  }

  async subscribeToBroadcast(
    channel: string,
    event: string,
    callback: (payload: unknown) => void,
  ): Promise<() => void> {
    assert.equal(event, TTY_SESSION_INPUT_BROADCAST_EVENT)
    this.callbacks.set(channel, callback)
    this.subscriptions.set(channel, (this.subscriptions.get(channel) ?? 0) + 1)
    return () => this.callbacks.delete(channel)
  }

  emit(channel: string, payload: unknown): void {
    this.callbacks.get(channel)?.(payload)
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

test('Realtime control delivery preserves FIFO order for one PTY session', async () => {
  const redis = new RealtimeControlRedisFake()
  const handled: string[] = []
  let releaseFirst: () => void = () => undefined
  const firstStarted = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const consumer = new TTYSessionControlConsumer(redis as never, 'worker-realtime-order-test', {
    handle: async (command) => {
      handled.push(command.commandId)
      if (command.commandId === 'first') await firstStarted
    },
  })

  await consumer.start()
  redis.emit('1-0', {
    commandId: 'first',
    sessionId,
    ownerUserId: 'user-one',
    type: 'write',
    data: 'e',
    timestamp: '2026-08-11T10:00:00.000Z',
  })
  redis.emit('2-0', {
    commandId: 'second',
    sessionId,
    ownerUserId: 'user-one',
    type: 'write',
    data: 'ENTER',
    timestamp: '2026-08-11T10:00:00.001Z',
  })

  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(handled, ['first'])
  releaseFirst()
  await new Promise((resolve) => setTimeout(resolve, 10))
  await consumer.stop()

  assert.deepEqual(handled, ['first', 'second'])
})

test('Realtime control repairs out-of-order notifications from the durable stream', async () => {
  const redis = new RealtimeControlRedisFake()
  const handled: string[] = []
  const consumer = new TTYSessionControlConsumer(redis as never, 'worker-realtime-reorder-test', {
    handle: async (command) => void handled.push(command.commandId),
  })

  await consumer.start()
  redis.historical = [
    [
      '1-0',
      {
        commandId: 'first',
        sessionId,
        ownerUserId: 'user-one',
        type: 'write',
        data: 'echo PRE_ENTER_CHECK',
        timestamp: '2026-08-11T10:00:00.000Z',
      },
    ],
    [
      '2-0',
      {
        commandId: 'second',
        sessionId,
        ownerUserId: 'user-one',
        type: 'write',
        data: '\r',
        timestamp: '2026-08-11T10:00:00.001Z',
      },
    ],
  ]
  redis.emit('2-0', redis.historical[1]?.[1] as Record<string, unknown>)

  await new Promise((resolve) => setTimeout(resolve, 10))
  await consumer.stop()

  assert.deepEqual(handled, ['first', 'second'])
})

test('Realtime control keeps unrelated session FIFOs concurrent', async () => {
  const redis = new RealtimeControlRedisFake()
  const otherSessionId = '00000000-0000-4000-8000-000000009102' as TTYSessionId
  const handled: string[] = []
  let releaseSessionA: () => void = () => undefined
  const sessionABlocked = new Promise<void>((resolve) => {
    releaseSessionA = resolve
  })
  const consumer = new TTYSessionControlConsumer(redis as never, 'worker-realtime-independent-sessions-test', {
    handle: async (command) => {
      handled.push(command.commandId)
      if (command.sessionId === sessionId && command.commandId === 'a1') await sessionABlocked
    },
  })

  await consumer.start()
  redis.emit('1-0', {
    commandId: 'a1',
    sessionId,
    ownerUserId: 'user-one',
    type: 'write',
    data: 'A1',
    timestamp: '2026-08-11T10:00:00.000Z',
  })
  redis.emit('2-0', {
    commandId: 'b1',
    sessionId: otherSessionId,
    ownerUserId: 'user-one',
    type: 'write',
    data: 'B1',
    timestamp: '2026-08-11T10:00:00.001Z',
  })

  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(handled, ['a1', 'b1'])
  releaseSessionA()
  await consumer.stop()
})

test('Realtime control replays a command inserted during channel startup', async () => {
  const redis = new RealtimeControlRedisFake()
  redis.historical = [
    [
      '1-0',
      {
        commandId: 'historical-open',
        sessionId,
        ownerUserId: 'user-one',
        type: 'open',
        timestamp: '2026-08-11T10:00:00.000Z',
      },
    ],
  ]
  redis.onSubscribe = () => {
    redis.emit('2-0', {
      commandId: 'startup-race-write',
      sessionId,
      ownerUserId: 'user-one',
      type: 'write',
      data: 'echo recovered\\n',
      timestamp: '2026-08-11T10:00:00.001Z',
    })
  }
  const handled: string[] = []
  const consumer = new TTYSessionControlConsumer(
    redis as never,
    'worker-startup-race-test',
    { handle: async (command) => void handled.push(command.commandId) },
    { reconciliationIntervalMs: 1_000 },
  )

  await consumer.start()
  await new Promise((resolve) => setTimeout(resolve, 10))
  await consumer.stop()

  assert.deepEqual(handled, ['historical-open', 'startup-race-write'])
})

test('broadcast stdin preserves per-session byte order and ignores duplicate delivery', async () => {
  const redis = new BroadcastInputRedisFake([
    { sessionId, channel: 'channel-a', token: 'token-a', ownerUserId: 'user-one' },
  ])
  const handled: string[] = []
  const consumer = new TTYSessionInputBroadcastConsumer(redis as never, {
    handle: async (command) => {
      handled.push(command.data ?? '')
    },
  })

  await consumer.start()
  const payload = (commandId: string, data: string, sequence: number) => ({
    sessionId,
    token: 'token-a',
    commandId,
    data,
    inputEventId: commandId,
    inputSequence: sequence,
    browserTimestampMs: 1_700_000_000_000 + sequence,
  })
  redis.emit('channel-a', payload('input-1', 'echo PRE_ENTER_CHECK\r', 1))
  redis.emit('channel-a', payload('input-2', 'echo SECOND_NO_REFRESH_TEST\r', 2))
  redis.emit('channel-a', payload('input-2', 'echo SECOND_NO_REFRESH_TEST\r', 2))
  await new Promise((resolve) => setTimeout(resolve, 10))
  await consumer.stop()

  assert.deepEqual(handled, ['echo PRE_ENTER_CHECK\r', 'echo SECOND_NO_REFRESH_TEST\r'])
  assert.equal(redis.subscriptions.get('channel-a'), 1)
})

test('broadcast stdin keeps unrelated session queues concurrent', async () => {
  const otherSessionId = '00000000-0000-4000-8000-000000009103' as TTYSessionId
  const redis = new BroadcastInputRedisFake([
    { sessionId, channel: 'channel-a', token: 'token-a', ownerUserId: 'user-one' },
    { sessionId: otherSessionId, channel: 'channel-b', token: 'token-b', ownerUserId: 'user-one' },
  ])
  const handled: string[] = []
  let releaseA: () => void = () => undefined
  const blockedA = new Promise<void>((resolve) => {
    releaseA = resolve
  })
  const consumer = new TTYSessionInputBroadcastConsumer(redis as never, {
    handle: async (command) => {
      handled.push(command.data ?? '')
      if (command.sessionId === sessionId) await blockedA
    },
  })
  await consumer.start()
  redis.emit('channel-a', {
    sessionId,
    token: 'token-a',
    commandId: 'a1',
    data: 'A1',
    inputEventId: 'a1',
    inputSequence: 1,
    browserTimestampMs: 1_700_000_000_001,
  })
  redis.emit('channel-b', {
    sessionId: otherSessionId,
    token: 'token-b',
    commandId: 'b1',
    data: 'B1',
    inputEventId: 'b1',
    inputSequence: 1,
    browserTimestampMs: 1_700_000_000_002,
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(handled, ['A1', 'B1'])
  releaseA()
  await consumer.stop()
})
