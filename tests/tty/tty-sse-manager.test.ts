import test from 'node:test'
import assert from 'node:assert/strict'

import { TTYStreamAuthorizer } from '@/lib/tty/tty-stream-auth'
import { TTYStreamBroker } from '@/lib/tty/tty-stream-broker'
import { TTYSSEManager } from '@/lib/tty/tty-sse-manager'
import { createQueuedTTYExecutionState, transitionTTYExecutionState } from '@/lib/tty/tty-execution-state'
import { createTTYExecutionId, createTTYSessionId, type InternalTTYSession } from '@/lib/tty/tty-types'

function createSession(sessionId: ReturnType<typeof createTTYSessionId>): InternalTTYSession {
  return {
    sessionId, ownerUserId: 'owner', status: 'active', tier: 'pro', createdAt: '2026-08-09T00:00:00.000Z', lastActiveAt: '2026-08-09T00:00:00.000Z',
    limits: { maxConcurrentSessions: 1, maxConcurrentExecutionsPerSession: 1, maxExecutionsPerMinute: 1, maxExecutionDurationMs: 1_000, maxSessionIdleMs: 1_000, maxSessionDurationMs: 1_000, maxOutputBytesPerExecution: 1_000, maxQueueDepth: 1 },
    usage: { activeSessions: 1, activeExecutionsInSession: 0, executionsInLastMinute: 0, queueDepth: 0, capturedAt: '2026-08-09T00:00:00.000Z' }
  }
}

function manager() {
  const broker = new TTYStreamBroker(null)
  const executionId = createTTYExecutionId()
  const sessionId = createTTYSessionId()
  const state = createQueuedTTYExecutionState(executionId, sessionId, '2026-08-09T00:00:00.000Z')
  const authorizer = new TTYStreamAuthorizer({ getExecutionState: async () => state, getSession: async () => createSession(sessionId) })
  return { broker, executionId, sessionId, manager: new TTYSSEManager(broker, authorizer, { heartbeatIntervalMs: 60_000, idleTimeoutMs: 120_000 }) }
}

async function readOne(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  const result = await reader.read()
  await reader.cancel()
  return new TextDecoder().decode(result.value)
}

async function readTwo(response: Response): Promise<[string, string]> {
  const reader = response.body!.getReader()
  const first = await reader.read()
  const second = await reader.read()
  await reader.cancel()
  return [new TextDecoder().decode(first.value), new TextDecoder().decode(second.value)]
}

test('SSE response replays events, emits SSE fields, and closes after completion', async () => {
  const setup = manager()
  await setup.broker.publish({ executionId: setup.executionId, sessionId: setup.sessionId, type: 'stdout', payload: { text: 'hello', byteLength: 5 } })
  await setup.broker.publish({ executionId: setup.executionId, sessionId: setup.sessionId, type: 'completion', payload: { state: 'succeeded', exitCode: 0, signal: null, failureCode: null } })
  const opened = await setup.manager.open({ userId: 'owner', executionId: setup.executionId })
  assert.equal(opened.accepted, true)
  if (!opened.accepted) return
  const [first, second] = await readTwo(opened.response)
  assert.match(first, /event: stdout/)
  assert.match(first, /id: 1/)
  assert.match(second, /event: completion/)
  assert.match(second, /retry: 3000/)
})

test('Last-Event-ID replays only the missing suffix and rejects malformed cursors', async () => {
  const setup = manager()
  await setup.broker.publish({ executionId: setup.executionId, sessionId: setup.sessionId, type: 'stdout', payload: { text: 'one', byteLength: 3 } })
  await setup.broker.publish({ executionId: setup.executionId, sessionId: setup.sessionId, type: 'stdout', payload: { text: 'two', byteLength: 3 } })
  await setup.broker.publish({ executionId: setup.executionId, sessionId: setup.sessionId, type: 'completion', payload: { state: 'succeeded', exitCode: 0, signal: null, failureCode: null } })
  const opened = await setup.manager.open({ userId: 'owner', executionId: setup.executionId, lastEventId: '1' })
  assert.equal(opened.accepted, true)
  if (!opened.accepted) return
  const suffix = await readOne(opened.response)
  assert.match(suffix, /event: stdout/)
  assert.doesNotMatch(suffix, /"text":"one"/)

  const invalid = await setup.manager.open({ userId: 'owner', executionId: setup.executionId, lastEventId: 'not-a-sequence' })
  assert.equal(invalid.accepted, false)
  assert.equal(invalid.response.status, 400)
})

test('unauthorized viewers receive no stream body', async () => {
  const setup = manager()
  const opened = await setup.manager.open({ userId: 'other', executionId: setup.executionId })
  assert.equal(opened.accepted, false)
  assert.equal(opened.response.status, 404)
})

test('bounded queues drop droppable output but preserve completion for a slow client', async () => {
  const broker = new TTYStreamBroker(null)
  const executionId = createTTYExecutionId()
  const sessionId = createTTYSessionId()
  const state = createQueuedTTYExecutionState(executionId, sessionId, '2026-08-09T00:00:00.000Z')
  const authorizer = new TTYStreamAuthorizer({ getExecutionState: async () => state, getSession: async () => createSession(sessionId) })
  const bounded = new TTYSSEManager(broker, authorizer, { maxQueueEvents: 4, maxQueueBytes: 8 * 1024, heartbeatIntervalMs: 60_000, idleTimeoutMs: 120_000 })
  const opened = await bounded.open({ userId: 'owner', executionId })
  assert.equal(opened.accepted, true)
  if (!opened.accepted) return

  for (let index = 0; index < 40; index += 1) {
    await broker.publish({ executionId, sessionId, type: 'stdout', payload: { text: String(index), byteLength: String(index).length } })
  }
  await broker.publish({ executionId, sessionId, type: 'completion', payload: { state: 'succeeded', exitCode: 0, signal: null, failureCode: null } })

  const reader = opened.response.body!.getReader()
  const chunks: string[] = []
  while (true) {
    const next = await reader.read()
    if (next.done) break
    chunks.push(new TextDecoder().decode(next.value))
  }
  const body = chunks.join('')
  assert.match(body, /event: completion/)
  assert.ok((body.match(/event: stdout/g) ?? []).length <= 5)
})

test('expired replay windows return a deterministic SSE recovery error', async () => {
  const broker = new TTYStreamBroker(null, { maxBufferedEvents: 2 })
  const executionId = createTTYExecutionId()
  const sessionId = createTTYSessionId()
  const state = createQueuedTTYExecutionState(executionId, sessionId, '2026-08-09T00:00:00.000Z')
  const authorizer = new TTYStreamAuthorizer({ getExecutionState: async () => state, getSession: async () => createSession(sessionId) })
  const manager = new TTYSSEManager(broker, authorizer, { heartbeatIntervalMs: 60_000, idleTimeoutMs: 120_000 })
  await broker.publish({ executionId, sessionId, type: 'stdout', payload: { text: 'one', byteLength: 3 } })
  await broker.publish({ executionId, sessionId, type: 'stdout', payload: { text: 'two', byteLength: 3 } })
  await broker.publish({ executionId, sessionId, type: 'stdout', payload: { text: 'three', byteLength: 5 } })
  const opened = await manager.open({ userId: 'owner', executionId })
  assert.equal(opened.accepted, true)
  if (!opened.accepted) return
  const error = await readOne(opened.response)
  assert.match(error, /event: error/)
  assert.match(error, /STREAM_GAP/)
})
