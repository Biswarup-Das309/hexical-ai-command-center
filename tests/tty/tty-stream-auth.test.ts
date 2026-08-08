import test from 'node:test'
import assert from 'node:assert/strict'

import { TTYStreamAuthorizer } from '@/lib/tty/tty-stream-auth'
import { createQueuedTTYExecutionState, transitionTTYExecutionState, type TTYExecutionStateRecord } from '@/lib/tty/tty-execution-state'
import { createTTYExecutionId, createTTYSessionId, type InternalTTYSession } from '@/lib/tty/tty-types'

function session(sessionId: ReturnType<typeof createTTYSessionId>, ownerUserId: string, status: InternalTTYSession['status'] = 'active'): InternalTTYSession {
  return {
    sessionId, ownerUserId, status, tier: 'pro', createdAt: '2026-08-09T00:00:00.000Z', lastActiveAt: '2026-08-09T00:00:00.000Z',
    limits: { maxConcurrentSessions: 1, maxConcurrentExecutionsPerSession: 1, maxExecutionsPerMinute: 1, maxExecutionDurationMs: 1_000, maxSessionIdleMs: 1_000, maxSessionDurationMs: 1_000, maxOutputBytesPerExecution: 1_000, maxQueueDepth: 1 },
    usage: { activeSessions: 1, activeExecutionsInSession: 1, executionsInLastMinute: 1, queueDepth: 0, capturedAt: '2026-08-09T00:00:00.000Z' }
  }
}

test('authorizer permits only the owner of the execution session', async () => {
  const executionId = createTTYExecutionId()
  const sessionId = createTTYSessionId()
  const state = createQueuedTTYExecutionState(executionId, sessionId, '2026-08-09T00:00:00.000Z')
  const authorizer = new TTYStreamAuthorizer({ getExecutionState: async () => state, getSession: async (id, userId) => userId === 'owner' ? session(id, userId) : null })

  assert.deepEqual(await authorizer.authorize({ userId: null, executionId }), { authorized: false, reason: 'unauthenticated' })
  assert.deepEqual(await authorizer.authorize({ userId: 'other', executionId }), { authorized: false, reason: 'session_not_found' })
  assert.deepEqual(await authorizer.authorize({ userId: 'owner', executionId, requestedSessionId: createTTYSessionId() }), { authorized: false, reason: 'session_not_found' })
  assert.deepEqual(await authorizer.authorize({ userId: 'owner', executionId }), { authorized: true, userId: 'owner', executionId, sessionId })
})

test('authorizer fails closed for missing, inactive, and denied executions', async () => {
  const executionId = createTTYExecutionId()
  const sessionId = createTTYSessionId()
  const state = createQueuedTTYExecutionState(executionId, sessionId, '2026-08-09T00:00:00.000Z')
  const missing = new TTYStreamAuthorizer({ getExecutionState: async () => null, getSession: async () => null })
  assert.deepEqual(await missing.authorize({ userId: 'owner', executionId }), { authorized: false, reason: 'execution_not_found' })

  const inactive = new TTYStreamAuthorizer({ getExecutionState: async () => state, getSession: async id => session(id, 'owner', 'terminated') })
  assert.deepEqual(await inactive.authorize({ userId: 'owner', executionId }), { authorized: false, reason: 'session_not_active' })

  const denied = new TTYStreamAuthorizer({ getExecutionState: async () => state, getSession: async id => session(id, 'owner'), canSubscribe: async () => false })
  assert.deepEqual(await denied.authorize({ userId: 'owner', executionId }), { authorized: false, reason: 'permission_denied' })
})

