import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IllegalTTYExecutionTransitionError,
  canRecoverTTYExecutionState,
  canTransitionTTYExecutionState,
  createQueuedTTYExecutionState,
  isTerminalTTYExecutionState,
  recoverTTYExecutionState,
  transitionTTYExecutionState,
} from '../../lib/tty/tty-execution-state'
import type { TTYExecutionId, TTYSessionId } from '../../lib/tty/tty-types'
import type { TTYLeaseId, TTYWorkerId } from '../../lib/tty/tty-worker-types'

const executionId = '00000000-0000-4000-8000-000000000101' as TTYExecutionId
const sessionId = '00000000-0000-4000-8000-000000000102' as TTYSessionId
const workerId = 'worker-state-test' as TTYWorkerId
const leaseId = 'lease-state-test' as TTYLeaseId
const queuedAt = '2026-08-08T10:00:00.000Z'

test('state machine accepts the normal queued-to-successful-streaming lifecycle and records timings', () => {
  const leasedAt = '2026-08-08T10:00:00.250Z'
  const startedAt = '2026-08-08T10:00:00.500Z'
  const finishedAt = '2026-08-08T10:00:01.000Z'

  const queued = createQueuedTTYExecutionState(executionId, sessionId, queuedAt)
  const leased = transitionTTYExecutionState(queued, 'leased', leasedAt, { workerId, leaseId })
  const starting = transitionTTYExecutionState(leased, 'starting', '2026-08-08T10:00:00.400Z')
  const running = transitionTTYExecutionState(starting, 'running', startedAt)
  const streaming = transitionTTYExecutionState(running, 'streaming', '2026-08-08T10:00:00.600Z', {
    outputBytes: 12,
    stdoutBytes: 8,
    stderrBytes: 4,
  })
  const succeeded = transitionTTYExecutionState(streaming, 'succeeded', finishedAt, {
    exitCode: 0,
    completionReason: 'process_exit',
  })

  assert.equal(succeeded.state, 'succeeded')
  assert.equal(succeeded.workerId, workerId)
  assert.equal(succeeded.leaseId, leaseId)
  assert.equal(succeeded.queueWaitMs, 250)
  assert.equal(succeeded.startupMs, 250)
  assert.equal(succeeded.durationMs, 500)
  assert.equal(succeeded.outputBytes, 12)
  assert.equal(succeeded.finishedAt, finishedAt)
  assert.equal(isTerminalTTYExecutionState(succeeded.state), true)
  assert.equal(Object.isFrozen(succeeded), true)
})

test('terminal states are idempotent but cannot transition to another terminal state', () => {
  const queued = createQueuedTTYExecutionState(executionId, sessionId, queuedAt)
  const failed = transitionTTYExecutionState(queued, 'expired', '2026-08-08T10:00:00.100Z', {
    failureCode: 'LEASE_EXPIRED',
  })
  const replay = transitionTTYExecutionState(failed, 'expired', '2026-08-08T10:00:00.200Z')

  assert.equal(replay.finishedAt, failed.finishedAt)
  assert.equal(replay.updatedAt, '2026-08-08T10:00:00.200Z')
  assert.equal(canTransitionTTYExecutionState('expired', 'expired'), true)
  assert.equal(canTransitionTTYExecutionState('expired', 'succeeded'), false)
  assert.throws(
    () => transitionTTYExecutionState(failed, 'succeeded', '2026-08-08T10:00:00.300Z'),
    (error: unknown) =>
      error instanceof IllegalTTYExecutionTransitionError && error.from === 'expired' && error.to === 'succeeded',
  )
})

test('state machine rejects skipping lease ownership and rejects mutation after completion', () => {
  const queued = createQueuedTTYExecutionState(executionId, sessionId, queuedAt)
  assert.equal(canTransitionTTYExecutionState('queued', 'running'), false)
  assert.throws(
    () => transitionTTYExecutionState(queued, 'running', '2026-08-08T10:00:00.100Z'),
    IllegalTTYExecutionTransitionError,
  )

  const cancelled = transitionTTYExecutionState(queued, 'cancelled', '2026-08-08T10:00:00.100Z', {
    completionReason: 'user_cancellation',
  })
  assert.throws(
    () => transitionTTYExecutionState(cancelled, 'running', '2026-08-08T10:00:00.200Z'),
    IllegalTTYExecutionTransitionError,
  )
})

test('requeue is recovery-only and never part of ordinary execution transitions', () => {
  assert.equal(canTransitionTTYExecutionState('running', 'queued'), false)
  assert.equal(canRecoverTTYExecutionState('running', 'queued'), true)
  assert.equal(canRecoverTTYExecutionState('succeeded', 'queued'), false)
})

test('crash recovery clears attempt-scoped timing before a fresh worker claim', () => {
  const queued = createQueuedTTYExecutionState(executionId, sessionId, queuedAt)
  const leased = transitionTTYExecutionState(queued, 'leased', '2026-08-08T10:00:00.250Z', { workerId, leaseId })
  const running = transitionTTYExecutionState(
    transitionTTYExecutionState(leased, 'starting', '2026-08-08T10:00:00.400Z'),
    'running',
    '2026-08-08T10:00:00.500Z',
  )

  const recovered = recoverTTYExecutionState(running, '2026-08-08T10:00:10.000Z')
  const reclaimed = transitionTTYExecutionState(recovered, 'leased', '2026-08-08T10:00:10.250Z', {
    workerId,
    leaseId,
  })
  const rerun = transitionTTYExecutionState(
    transitionTTYExecutionState(reclaimed, 'starting', '2026-08-08T10:00:10.400Z'),
    'running',
    '2026-08-08T10:00:10.500Z',
  )

  assert.equal(recovered.startedAt, null)
  assert.equal(recovered.startupMs, null)
  assert.equal(recovered.durationMs, null)
  assert.equal(rerun.startedAt, '2026-08-08T10:00:10.500Z')
  assert.equal(rerun.startupMs, 250)
})
