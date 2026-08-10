import assert from 'node:assert/strict'
import test from 'node:test'
import type { Redis } from '@upstash/redis'
import { WorkerRedisMock } from './worker-redis-mock'
import { TTYWorkerHeartbeatService } from '../../lib/tty/tty-worker-heartbeat'
import { TTYWorkerRegistry } from '../../lib/tty/tty-worker-registry'
import { createTTYWorkerId } from '../../lib/tty/tty-worker-types'

function asRedis(redis: WorkerRedisMock): Redis {
  return redis as unknown as Redis
}

function registration(index: number) {
  return {
    workerId: createTTYWorkerId(`stress-worker-${index}`),
    identity: `stress-host-${index}`,
    version: '1.0.0',
    capabilities: ['claim_lease', 'renew_lease', 'execute'] as const,
  }
}

test('100 concurrent worker registrations complete without duplicate or corrupt records', async () => {
  const redis = new WorkerRedisMock()
  const registry = new TTYWorkerRegistry(asRedis(redis))
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, index) => registry.registerWorker(registration(index))),
  )
  assert.equal(results.filter((result) => result.registered).length, 100)
  const workers = await registry.listWorkers()
  assert.equal(workers.length, 100)
  assert.equal(new Set(workers.map((worker) => worker.workerId)).size, 100)
})

test('registration races, duplicate heartbeats, and worker recovery remain idempotent', async () => {
  const redis = new WorkerRedisMock()
  let nowMs = 1_700_000_000_000
  const registry = new TTYWorkerRegistry(asRedis(redis), { dependencies: { now: () => new Date(nowMs) } })
  const worker = registration(101)
  const raced = await Promise.all([
    registry.registerWorker(worker),
    registry.registerWorker(worker),
    registry.registerWorker(worker),
  ])
  assert.equal(raced.filter((result) => result.registered).length, 1)
  const heartbeat = new TTYWorkerHeartbeatService(asRedis(redis), registry, { now: () => new Date(nowMs) })
  const heartbeats = await Promise.all(
    Array.from({ length: 20 }, () =>
      heartbeat.recordHeartbeat({ workerId: worker.workerId, sequence: 1, sentAt: new Date(nowMs).toISOString() }),
    ),
  )
  assert.equal(heartbeats.filter((result) => result.recorded).length, 1)
  nowMs += 31_000
  assert.equal((await heartbeat.markWorkerOffline(worker.workerId, new Date(nowMs))).offline, true)
  assert.equal((await heartbeat.markWorkerOffline(worker.workerId, new Date(nowMs))).offline, true)
  assert.equal(
    (await heartbeat.recordHeartbeat({ workerId: worker.workerId, sequence: 2, sentAt: new Date(nowMs).toISOString() }))
      .recorded,
    true,
  )
  const current = await registry.getWorker(worker.workerId)
  assert.equal(current?.status, 'active')
})

test('Redis outage fails closed and reconnection does not mutate worker state', async () => {
  class FlakyRedis extends WorkerRedisMock {
    available = true

    override async get<T>(key: string): Promise<T | null> {
      if (!this.available) throw new Error('simulated partition')
      return super.get<T>(key)
    }

    override async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
      if (!this.available) throw new Error('simulated partition')
      return super.eval(script, keys, args)
    }
  }
  const redis = new FlakyRedis()
  const registry = new TTYWorkerRegistry(asRedis(redis))
  const worker = registration(102)
  assert.equal((await registry.registerWorker(worker)).registered, true)
  redis.available = false
  assert.equal(await registry.getWorker(worker.workerId), null)
  redis.available = true
  const restored = await registry.getWorker(worker.workerId)
  assert.equal(restored?.identity, worker.identity)
  assert.equal(restored?.status, 'active')
})
