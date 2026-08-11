import assert from 'node:assert/strict'
import test from 'node:test'
import { TTYExecutionAdmission } from '../../lib/tty/tty-execution-admission'
import type { InternalTTYSession } from '../../lib/tty/tty-types'

const baseSession: InternalTTYSession = {
  sessionId: '00000000-0000-4000-8000-000000000011' as InternalTTYSession['sessionId'],
  ownerUserId: 'user-1',
  tier: 'pro',
  status: 'active',
  createdAt: new Date().toISOString(),
  lastActiveAt: new Date().toISOString(),
  limits: {
    maxConcurrentSessions: 3,
    maxConcurrentExecutionsPerSession: 1,
    maxExecutionsPerMinute: 1,
    maxExecutionDurationMs: 30_000,
    maxSessionIdleMs: 900_000,
    maxSessionDurationMs: 3_600_000,
    maxOutputBytesPerExecution: 262_144,
    maxQueueDepth: 1,
  },
  usage: {
    activeSessions: 1,
    activeExecutionsInSession: 0,
    executionsInLastMinute: 0,
    queueDepth: 0,
    capturedAt: new Date().toISOString(),
  },
}

function mockRedis(options: { coreExists?: boolean } = {}) {
  const idempotencies = new Map<string, string>()
  const jobs = new Map<string, string>()
  let queue = 0
  let active = 0
  let recent = 0
  return {
    eval: async (_script: string, keys: string[], args: string[]) => {
      const existing = idempotencies.get(keys[0])
      if (existing) return [2, existing]
      if (options.coreExists === false) return [0, 'session_terminated']
      if (queue >= Number(args[3])) return [0, 'queue_full']
      if (active >= Number(args[4])) return [0, 'concurrency_limit_exceeded']
      if (recent >= Number(args[5])) return [0, 'rate_limited']
      queue += 1
      active += 1
      recent += 1
      const wrapper = args[7]
      jobs.set(keys[1]!, args[6]!)
      idempotencies.set(keys[0], wrapper)
      return [1, args[6]]
    },
    jobs,
  } as never
}

test('mock contract: concurrent admission reserves once and duplicate retry replays safely', async () => {
  const redis = mockRedis() as unknown as { readonly jobs: Map<string, string> }
  const admission = new TTYExecutionAdmission(redis as never, {
    authorize: async () => ({ allowed: true, scopeId: null }),
  })
  const [first, second] = await Promise.all([
    admission.admit({
      session: baseSession,
      rawInput: 'help' as never,
      kind: 'session_utility',
      idempotencyKey: 'abcdefghijklmnop',
    }),
    admission.admit({
      session: baseSession,
      rawInput: 'help' as never,
      kind: 'session_utility',
      idempotencyKey: 'qrstuvwxyzabcdef',
    }),
  ])
  assert.equal([first, second].filter((result) => result.admitted).length, 1)
  const retry = await admission.admit({
    session: baseSession,
    rawInput: 'help' as never,
    kind: 'session_utility',
    idempotencyKey: 'abcdefghijklmnop',
  })
  assert.equal(retry.admitted, true)
  if (retry.admitted) assert.equal(retry.duplicate, true)

  const storedJob = [...redis.jobs.values()][0]
  assert.ok(storedJob)
  const parsedJob = JSON.parse(storedJob) as Record<string, unknown>
  assert.equal(typeof parsedJob.sessionId, 'string')
  assert.equal('job' in parsedJob, false)
})

test('mock contract: resource denials do not create a second queued job', async () => {
  const admission = new TTYExecutionAdmission(mockRedis(), {
    authorize: async () => ({ allowed: true, scopeId: null }),
  })
  const first = await admission.admit({
    session: baseSession,
    rawInput: 'help' as never,
    kind: 'session_utility',
    idempotencyKey: 'abcdefghijklmnop',
  })
  const denied = await admission.admit({
    session: baseSession,
    rawInput: 'help' as never,
    kind: 'session_utility',
    idempotencyKey: 'qrstuvwxyzabcdef',
  })
  assert.equal(first.admitted, true)
  assert.equal(denied.admitted, false)
  if (!denied.admitted) assert.equal(denied.reason, 'queue_full')
})

test('mock contract: idempotency fingerprint conflicts and expired cores fail closed', async () => {
  const admission = new TTYExecutionAdmission(mockRedis(), {
    authorize: async () => ({ allowed: true, scopeId: null }),
  })
  const first = await admission.admit({
    session: baseSession,
    rawInput: 'help' as never,
    kind: 'session_utility',
    idempotencyKey: 'abcdefghijklmnop',
  })
  const conflict = await admission.admit({
    session: baseSession,
    rawInput: 'status' as never,
    kind: 'session_utility',
    idempotencyKey: 'abcdefghijklmnop',
  })
  assert.equal(first.admitted, true)
  assert.equal(conflict.admitted, false)
  if (!conflict.admitted) assert.equal(conflict.reason, 'input_rejected')

  const expired = new TTYExecutionAdmission(mockRedis({ coreExists: false }), {
    authorize: async () => ({ allowed: true, scopeId: null }),
  })
  const expiredResult = await expired.admit({
    session: baseSession,
    rawInput: 'help' as never,
    kind: 'session_utility',
    idempotencyKey: 'qrstuvwxyzabcdef',
  })
  assert.equal(expiredResult.admitted, false)
  if (!expiredResult.admitted) assert.equal(expiredResult.reason, 'session_terminated')
})
