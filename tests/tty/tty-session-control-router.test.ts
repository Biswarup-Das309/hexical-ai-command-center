import assert from 'node:assert/strict'
import test from 'node:test'
import type { TTYSessionControlEntry } from '../../lib/tty/tty-session-control'
import { TTYSessionControlRouter } from '../../lib/tty/tty-session-control-router'
import type { TTYSessionId } from '../../lib/tty/tty-types'
import { ttySessionRuntimeKey, ttyWorkerSessionControlStreamKey } from '../../lib/tty/tty-worker-keys'
import type { TTYWorkerId } from '../../lib/tty/tty-worker-types'

const sessionId = '00000000-0000-4000-8000-000000009501' as TTYSessionId
const workerA = 'worker-router-a' as TTYWorkerId
const workerB = 'worker-router-b' as TTYWorkerId

class RouterRedisFake {
  readonly values = new Map<string, unknown>()
  readonly forwarded: Array<{ key: string; fields: Record<string, unknown> }> = []
  readonly expirations: Array<{ key: string; seconds: number }> = []

  async get<T>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null
  }

  async xadd(key: string, _id: '*', fields: Record<string, unknown>): Promise<string> {
    this.forwarded.push({ key, fields })
    return `${this.forwarded.length}-0`
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.expirations.push({ key, seconds })
    return 1
  }
}

function command(type: TTYSessionControlEntry['type']): TTYSessionControlEntry {
  return {
    streamId: '1-0',
    commandId: 'router-command-1',
    sessionId,
    ownerUserId: 'user-one',
    type,
    timestamp: '2026-08-11T10:00:00.000Z',
    ...(type === 'write' ? { data: 'pwd\n' } : {}),
  }
}

test('router forwards commands to the leased worker before acknowledging the global entry', async () => {
  const redis = new RouterRedisFake()
  redis.values.set(ttySessionRuntimeKey(sessionId), {
    version: 1,
    state: 'active',
    sessionId,
    ownerUserId: 'user-one',
    workerId: workerB,
    runtimeId: 'runtime-b',
    startedAt: '2026-08-11T10:00:00.000Z',
    leaseExpiresAt: '2026-08-11T10:01:00.000Z',
  })
  const handled: TTYSessionControlEntry[] = []
  const router = new TTYSessionControlRouter(redis as never, workerA, {
    handle: async (entry) => void handled.push(entry),
  })

  await router.handle(command('write'))

  assert.equal(handled.length, 0)
  assert.equal(redis.forwarded[0]?.key, ttyWorkerSessionControlStreamKey(workerB))
  assert.equal(redis.forwarded[0]?.fields.commandId, 'router-command-1')
  assert.equal(redis.expirations[0]?.seconds, 7 * 24 * 60 * 60)
})

test('router invokes the local handler when no foreign lease exists or the current worker owns it', async () => {
  const redis = new RouterRedisFake()
  const handled: TTYSessionControlEntry[] = []
  const router = new TTYSessionControlRouter(redis as never, workerA, {
    handle: async (entry) => void handled.push(entry),
  })

  await router.handle(command('open'))
  redis.values.set(ttySessionRuntimeKey(sessionId), {
    sessionId,
    ownerUserId: 'user-one',
    workerId: workerA,
    state: 'provisioning',
  })
  await router.handle(command('resize'))

  assert.deepEqual(
    handled.map((entry) => entry.type),
    ['open', 'resize'],
  )
  assert.equal(redis.forwarded.length, 0)
})
