import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkerRedisMock } from './worker-redis-mock'
import { createTTYSessionRuntimeApi, type TTYSessionRuntimeStore } from '../../lib/tty/tty-session-runtime-api'
import { TTYSessionTranscriptManager } from '../../lib/tty/tty-session-transcript'
import type { InternalTTYSession, TTYSessionId } from '../../lib/tty/tty-types'

const owner = 'runtime-owner'
const otherOwner = 'runtime-other'
const sessionId = '00000000-0000-4000-8000-000000009501' as TTYSessionId

class RuntimeStore implements TTYSessionRuntimeStore {
  session: InternalTTYSession = {
    sessionId,
    ownerUserId: owner,
    tier: 'pro',
    status: 'active',
    createdAt: '2026-08-11T00:00:00.000Z',
    lastActiveAt: '2026-08-11T00:00:00.000Z',
    limits: {
      maxConcurrentSessions: 1,
      maxConcurrentExecutionsPerSession: 1,
      maxExecutionsPerMinute: 60,
      maxExecutionDurationMs: 30_000,
      maxSessionIdleMs: 60_000,
      maxSessionDurationMs: 300_000,
      maxOutputBytesPerExecution: 65_536,
      maxQueueDepth: 8,
    },
    usage: {
      activeSessions: 1,
      activeExecutionsInSession: 0,
      executionsInLastMinute: 0,
      queueDepth: 0,
      capturedAt: '2026-08-11T00:00:00.000Z',
    },
  }
  touches = 0

  async getSession(id: TTYSessionId, expectedOwnerUserId: string): Promise<InternalTTYSession | null> {
    return id === this.session.sessionId && expectedOwnerUserId === this.session.ownerUserId ? this.session : null
  }

  async touchSession(id: TTYSessionId, expectedOwnerUserId: string): Promise<InternalTTYSession | null> {
    const current = await this.getSession(id, expectedOwnerUserId)
    if (current === null || current.status !== 'active') return null
    this.touches += 1
    return current
  }
}

function fixture() {
  const redis = new WorkerRedisMock()
  const store = new RuntimeStore()
  const transcript = new TTYSessionTranscriptManager(redis as never)
  const published: Array<Record<string, unknown>> = []
  let authenticatedUser = owner
  const api = createTTYSessionRuntimeApi({
    authenticate: async () => authenticatedUser,
    store,
    transcript,
    publish: async (command) => {
      published.push(command)
      return `${published.length}-0`
    },
  })
  return {
    api,
    store,
    transcript,
    published,
    setAuthenticatedUser(value: string) {
      authenticatedUser = value
    },
  }
}

function request(body: unknown): Request {
  return new Request(`https://hexical.test/api/tty/sessions/${sessionId}/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('session control authenticates ownership, touches the live session, and queues bounded PTY stdin', async () => {
  const testFixture = fixture()
  const response = await testFixture.api.control(request({ type: 'write', data: 'cd project\n' }), sessionId)
  const body = (await response.json()) as Record<string, unknown>

  assert.equal(response.status, 202)
  assert.equal(body.ok, true)
  assert.equal(testFixture.store.touches, 1)
  assert.equal(testFixture.published.length, 1)
  assert.equal(testFixture.published[0]?.sessionId, sessionId)
  assert.equal(testFixture.published[0]?.ownerUserId, owner)
  assert.equal(testFixture.published[0]?.type, 'write')
  assert.equal(testFixture.published[0]?.data, 'cd project\n')
  assert.equal(typeof testFixture.published[0]?.commandId, 'string')
})

test('session control fails closed for another owner, a terminal session, and malformed controls', async () => {
  const testFixture = fixture()
  testFixture.setAuthenticatedUser(otherOwner)
  assert.equal((await testFixture.api.control(request({ type: 'open' }), sessionId)).status, 404)

  testFixture.setAuthenticatedUser(owner)
  testFixture.store.session = { ...testFixture.store.session, status: 'terminated' }
  assert.equal((await testFixture.api.control(request({ type: 'open' }), sessionId)).status, 409)
  testFixture.store.session = { ...testFixture.store.session, status: 'active' }
  assert.equal(
    (await testFixture.api.control(request({ type: 'resize', columns: 0, rows: 40 }), sessionId)).status,
    400,
  )
  assert.equal(testFixture.published.length, 0)
})

test('session transcript replay uses exclusive durable cursors across browser reconnects', async () => {
  const testFixture = fixture()
  const [first] = await testFixture.transcript.appendOutput({ sessionId, text: 'first\n' })
  assert.ok(first)
  await testFixture.transcript.appendOutput({ sessionId, text: 'second\n' })

  const initial = await testFixture.api.replay(
    new Request(`https://hexical.test/api/tty/sessions/${sessionId}/transcript?limit=1`),
    sessionId,
  )
  const initialBody = (await initial.json()) as { cursor: string; events: Array<{ data: Record<string, unknown> }> }
  assert.equal(initial.status, 200)
  assert.equal(initialBody.events.length, 1)
  assert.equal(initialBody.events[0]?.data.text, 'first\n')
  assert.equal(initialBody.cursor, first.cursor)

  const resumed = await testFixture.api.replay(
    new Request(
      `https://hexical.test/api/tty/sessions/${sessionId}/transcript?after=${encodeURIComponent(
        first.cursor,
      )}&limit=10`,
    ),
    sessionId,
  )
  const resumedBody = (await resumed.json()) as { events: Array<{ data: Record<string, unknown> }> }
  assert.equal(resumed.status, 200)
  assert.deepEqual(
    resumedBody.events.map((event) => event.data.text),
    ['second\n'],
  )
})
