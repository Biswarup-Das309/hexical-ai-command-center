import test from 'node:test'
import assert from 'node:assert/strict'

import { TTYExecutionApi } from '../../lib/tty/tty-execution-api'
import { TTYRecoveryManager } from '../../lib/tty/tty-recovery'
import { createQueuedTTYExecutionState, transitionTTYExecutionState } from '../../lib/tty/tty-execution-state'
import { TTYOutputStreamManager } from '../../lib/tty/tty-output-stream'
import { ttyExecutionActiveIndexKey, ttyExecutionRuntimeKey, ttyExecutionStateKey } from '../../lib/tty/tty-worker-keys'
import type { TTYExecutionId, TTYSessionId } from '../../lib/tty/tty-types'
import { WorkerRedisMock } from './worker-redis-mock'

const executionId = '00000000-0000-4000-8000-000000000601' as TTYExecutionId
const sessionId = '00000000-0000-4000-8000-000000000602' as TTYSessionId
const session = {
  sessionId,
  ownerUserId: 'owner-recovery-api',
  tier: 'pro' as const,
  status: 'active' as const,
  createdAt: '2026-08-08T10:00:00.000Z',
  lastActiveAt: '2026-08-08T10:00:00.000Z',
  limits: { maxConcurrentSessions: 1, maxConcurrentExecutionsPerSession: 2, maxExecutionsPerMinute: 10, maxExecutionDurationMs: 10_000, maxSessionIdleMs: 900_000, maxSessionDurationMs: 3_600_000, maxOutputBytesPerExecution: 100, maxQueueDepth: 10 },
  usage: { activeSessions: 1, activeExecutionsInSession: 1, executionsInLastMinute: 1, queueDepth: 0, capturedAt: '2026-08-08T10:00:00.000Z' }
}

test('recovery scans the active index, cleans an orphan, and delegates state mutation', async () => {
  const redis = new WorkerRedisMock()
  const queued = createQueuedTTYExecutionState(executionId, sessionId, '2026-08-08T10:00:00.000Z')
  const running = transitionTTYExecutionState(transitionTTYExecutionState(queued, 'leased', '2026-08-08T10:00:00.010Z', { workerId: 'worker-old' as never, leaseId: 'lease-old' as never }), 'starting', '2026-08-08T10:00:00.020Z')
  const stateKey = ttyExecutionStateKey(executionId)
  await redis.set(stateKey, JSON.stringify(running))
  await redis.sadd(ttyExecutionActiveIndexKey(), executionId)
  await redis.set(ttyExecutionRuntimeKey(executionId), JSON.stringify({ pid: 12_345, cwd: 'C:/runtime/execution-1' }))

  const cleaned: Array<{ pid: number; cwd: string }> = []
  const recovery = new TTYRecoveryManager(redis as never, { cleanupOrphan: async orphan => { cleaned.push(orphan); return true } })
  const candidates = await recovery.findCandidates()
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.runtime?.pid, 12_345)

  const result = await recovery.reconcile(async id => {
    assert.equal(id, executionId)
    return transitionTTYExecutionState(running, 'queued', '2026-08-08T10:00:00.030Z', { workerId: null, leaseId: null, completionReason: 'worker_crash_recovered' })
  })
  assert.deepEqual(result, { scanned: 1, cleaned: 1, recovered: 1, failed: 0 })
  assert.deepEqual(cleaned, [{ pid: 12_345, cwd: 'C:/runtime/execution-1' }])
})

test('browser-safe execution API verifies session ownership and omits worker and lease internals', async () => {
  const redis = new WorkerRedisMock()
  const queued = createQueuedTTYExecutionState(executionId, sessionId, '2026-08-08T10:00:00.000Z')
  const running = transitionTTYExecutionState(transitionTTYExecutionState(queued, 'leased', '2026-08-08T10:00:00.010Z', { workerId: 'worker-api' as never, leaseId: 'opaque-api-lease' as never }), 'starting', '2026-08-08T10:00:00.020Z')
  const state = transitionTTYExecutionState(running, 'running', '2026-08-08T10:00:00.030Z')
  await redis.set(ttyExecutionStateKey(executionId), JSON.stringify(state))
  const output = new TTYOutputStreamManager(redis as never)
  await output.appendOutput({ executionId, sessionId, stream: 'stdout', text: 'safe output' })
  await output.appendState({ executionId, sessionId, state: 'running' })

  const api = new TTYExecutionApi({
    getState: async () => state,
    outputStream: output,
    sessionStore: { getSession: async (_id, owner) => owner === session.ownerUserId ? session : null }
  })
  const view = await api.getExecution(executionId, session.ownerUserId)
  assert.equal(view?.state, 'running')
  assert.equal(view?.outputSummary.stdoutBytes, 11)
  assert.equal('workerId' in (view ?? {}), false)
  assert.equal('leaseId' in (view ?? {}), false)
  assert.equal(JSON.stringify(view).includes('opaque-api-lease'), false)
  const browserOutput = await api.getOutput(executionId, session.ownerUserId)
  assert.equal(browserOutput?.[0]?.text, 'safe output')
  assert.equal(await api.getExecution(executionId, 'other-user'), null)
})

