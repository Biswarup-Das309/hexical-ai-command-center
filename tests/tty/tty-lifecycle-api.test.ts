import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Tier } from '../../lib/hexical/types'
import { createTTYLifecycleApi, type TTYLifecycleStore } from '../../lib/tty/tty-lifecycle-api'
import { resolveTTYResourceLimits } from '../../lib/tty/tty-resource-limits'
import {
  createTTYSessionId,
  type InternalTTYSession,
  type TTYSessionId,
  type TTYTerminationResult,
} from '../../lib/tty/tty-types'

const OWNER = 'user-owner'
const OTHER_USER = 'user-other'
const BASE_TIME = '2026-08-04T00:00:00.000Z'

class FakeLifecycleStore implements TTYLifecycleStore {
  readonly sessions = new Map<TTYSessionId, InternalTTYSession>()
  readonly terminationCalls: string[] = []
  lastCreateInput: Parameters<TTYLifecycleStore['createSession']>[0] | null = null

  async createSession(input: Parameters<TTYLifecycleStore['createSession']>[0]): Promise<InternalTTYSession> {
    const sessionId = input.sessionId ?? createTTYSessionId()
    const session: InternalTTYSession = {
      sessionId,
      ownerUserId: input.principal.userId,
      tier: input.principal.tier,
      status: 'active',
      createdAt: BASE_TIME,
      lastActiveAt: BASE_TIME,
      limits: input.limits,
      usage: {
        activeSessions: 1,
        activeExecutionsInSession: 0,
        queueDepth: 0,
        executionsInLastMinute: 0,
        capturedAt: BASE_TIME,
      },
    }
    this.lastCreateInput = input
    this.sessions.set(sessionId, session)
    return session
  }

  async getSession(sessionId: TTYSessionId, expectedOwnerUserId: string): Promise<InternalTTYSession | null> {
    const session = this.sessions.get(sessionId)
    return session?.ownerUserId === expectedOwnerUserId ? session : null
  }

  async touchSession(sessionId: TTYSessionId, ownerUserId: string): Promise<InternalTTYSession | null> {
    const session = await this.getSession(sessionId, ownerUserId)
    if (session === null || session.status === 'terminated' || session.status === 'expired') return null
    const touched: InternalTTYSession = { ...session, lastActiveAt: new Date(Date.now()).toISOString() }
    this.sessions.set(sessionId, touched)
    return touched
  }

  async terminateSession(
    sessionId: TTYSessionId,
    ownerUserId: string,
    _reason: Parameters<TTYLifecycleStore['terminateSession']>[2],
  ): Promise<TTYTerminationResult> {
    const session = await this.getSession(sessionId, ownerUserId)
    if (session === null) return { sessionId, acknowledged: false }

    this.terminationCalls.push(sessionId)
    if (session.status === 'terminated') {
      const terminatedAt = session.lastActiveAt
      return { sessionId, acknowledged: true, terminatedAt }
    }

    const terminatedAt = new Date(Date.now()).toISOString()
    this.sessions.set(sessionId, { ...session, status: 'terminated', lastActiveAt: terminatedAt })
    return { sessionId, acknowledged: true, terminatedAt }
  }

  async countActiveSessionsForUser(userId: string): Promise<number> {
    return [...this.sessions.values()].filter(
      (session) => session.ownerUserId === userId && (session.status === 'active' || session.status === 'idle'),
    ).length
  }

  async listSessionsForUser(userId: string): Promise<readonly InternalTTYSession[]> {
    return [...this.sessions.values()]
      .filter((session) => session.ownerUserId === userId && (session.status === 'active' || session.status === 'idle'))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  setStatus(sessionId: TTYSessionId, status: InternalTTYSession['status']): void {
    const session = this.sessions.get(sessionId)
    if (session !== undefined) this.sessions.set(sessionId, { ...session, status })
  }
}

function createFixture() {
  const store = new FakeLifecycleStore()
  let authenticatedUserId: string | null = OWNER
  let tier: Tier = 'pro'
  const api = createTTYLifecycleApi({
    authenticate: async () => authenticatedUserId,
    resolveTier: async () => tier,
    resolveLimits: resolveTTYResourceLimits,
    getStore: () => store,
  })

  return {
    api,
    store,
    setAuthenticatedUserId(value: string | null) {
      authenticatedUserId = value
    },
    setTier(value: Tier) {
      tier = value
    },
  }
}

function request(method: string, body?: string): Request {
  return new Request('https://hexical.test/api/tty/sessions', {
    method,
    ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
  })
}

async function payload(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json()
  assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate')
  assert.equal(typeof body, 'object')
  assert.notEqual(body, null)
  return body as Record<string, unknown>
}

async function createSession(fixture: ReturnType<typeof createFixture>): Promise<TTYSessionId> {
  const response = await fixture.api.create(request('POST', '{}'))
  assert.equal(response.status, 201)
  const body = await payload(response)
  const session = body.session as { sessionId: TTYSessionId }
  return session.sessionId
}

test('rejects unauthenticated session creation and non-entitled tiers', async () => {
  const unauthenticated = createFixture()
  unauthenticated.setAuthenticatedUserId(null)
  const unauthenticatedResponse = await unauthenticated.api.create(request('POST', '{}'))
  assert.equal(unauthenticatedResponse.status, 401)
  assert.equal(unauthenticated.store.lastCreateInput, null)

  const nonEntitled = createFixture()
  nonEntitled.setTier('plus')
  const nonEntitledResponse = await nonEntitled.api.create(request('POST', '{}'))
  assert.equal(nonEntitledResponse.status, 403)
  assert.equal((await payload(nonEntitledResponse)).code, 'CAPABILITY_LOCKED')
  assert.equal(nonEntitled.store.lastCreateInput, null)
})

test('creates trusted server-owned state and exposes only the browser-safe projection', async () => {
  const fixture = createFixture()
  const response = await fixture.api.create(request('POST', '{}'))
  assert.equal(response.status, 201)
  const body = await payload(response)
  const session = body.session as Record<string, unknown>

  assert.equal(fixture.store.lastCreateInput?.principal.userId, OWNER)
  assert.equal(fixture.store.lastCreateInput?.principal.tier, 'pro')
  assert.equal(session.tier, 'pro')
  assert.equal(session.status, 'active')
  assert.equal(typeof session.sessionId, 'string')
  assert.equal('ownerUserId' in session, false)
  assert.equal('usage' in session, false)
  assert.deepEqual(session.limits, resolveTTYResourceLimits('pro'))
})

test("lists only the authenticated owner's live terminal sessions for browser restart recovery", async () => {
  const fixture = createFixture()
  const first = await createSession(fixture)
  const second = await createSession(fixture)
  const otherSessionId = createTTYSessionId()
  fixture.store.sessions.set(otherSessionId, {
    sessionId: otherSessionId,
    ownerUserId: OTHER_USER,
    tier: 'pro',
    status: 'active',
    createdAt: BASE_TIME,
    lastActiveAt: BASE_TIME,
    limits: resolveTTYResourceLimits('pro')!,
    usage: {
      activeSessions: 1,
      activeExecutionsInSession: 0,
      queueDepth: 0,
      executionsInLastMinute: 0,
      capturedAt: BASE_TIME,
    },
  })

  const response = await fixture.api.list(request('GET'))
  const body = await payload(response)
  const sessions = body.sessions as readonly Record<string, unknown>[]
  assert.equal(response.status, 200)
  assert.deepEqual(new Set(sessions.map((session) => session.sessionId)), new Set([first, second]))
  assert.ok(sessions.every((session) => !('ownerUserId' in session) && !('usage' in session)))
})

test('rejects spoofed identity/tier fields and malformed request bodies', async () => {
  const fixture = createFixture()
  const spoofed = await fixture.api.create(request('POST', JSON.stringify({ userId: OTHER_USER, tier: 'pro' })))
  assert.equal(spoofed.status, 400)
  assert.equal((await payload(spoofed)).code, 'INPUT_REJECTED')
  assert.equal(fixture.store.lastCreateInput, null)

  const malformedJson = await fixture.api.create(request('POST', '{'))
  assert.equal(malformedJson.status, 400)
  assert.equal((await payload(malformedJson)).code, 'INPUT_REJECTED')

  const sessionId = await createSession(fixture)
  const malformedTouch = await fixture.api.touch(request('POST', JSON.stringify({ tier: 'pro' })), sessionId)
  assert.equal(malformedTouch.status, 400)
  assert.equal((await payload(malformedTouch)).code, 'INPUT_REJECTED')
})

test('enforces owner isolation across get, touch, and terminate', async () => {
  const fixture = createFixture()
  const sessionId = await createSession(fixture)
  fixture.setAuthenticatedUserId(OTHER_USER)

  const getResponse = await fixture.api.get(request('GET'), sessionId)
  const touchResponse = await fixture.api.touch(request('POST', '{}'), sessionId)
  const terminateResponse = await fixture.api.terminate(request('DELETE'), sessionId)

  assert.equal(getResponse.status, 404)
  assert.equal(touchResponse.status, 404)
  assert.equal(terminateResponse.status, 404)
  assert.equal(fixture.store.terminationCalls.length, 0)

  fixture.setAuthenticatedUserId(OWNER)
  const ownerView = await fixture.api.get(request('GET'), sessionId)
  assert.equal(ownerView.status, 200)
  assert.equal((await payload(ownerView)).session instanceof Object, true)
})

test('allows the owner to read and touch an active session', async () => {
  const fixture = createFixture()
  const sessionId = await createSession(fixture)

  const getResponse = await fixture.api.get(request('GET'), sessionId)
  const touchResponse = await fixture.api.touch(request('POST', '{}'), sessionId)

  assert.equal(getResponse.status, 200)
  assert.equal(touchResponse.status, 200)
  assert.equal((await payload(touchResponse)).session instanceof Object, true)
})

test('does not revive terminated or expired sessions', async () => {
  const terminatedFixture = createFixture()
  const terminatedId = await createSession(terminatedFixture)
  const terminated = await terminatedFixture.api.terminate(request('DELETE'), terminatedId)
  assert.equal(terminated.status, 200)
  const terminatedTouch = await terminatedFixture.api.touch(request('POST', '{}'), terminatedId)
  assert.equal(terminatedTouch.status, 409)
  assert.equal((await payload(terminatedTouch)).code, 'SESSION_TERMINATED')

  const expiredFixture = createFixture()
  const expiredId = await createSession(expiredFixture)
  expiredFixture.store.setStatus(expiredId, 'expired')
  const expiredTouch = await expiredFixture.api.touch(request('POST', '{}'), expiredId)
  assert.equal(expiredTouch.status, 409)
  const expiredBody = await payload(expiredTouch)
  assert.equal(expiredBody.code, 'SESSION_TERMINATED')
  assert.equal((expiredBody.session as Record<string, unknown>).status, 'expired')
})

test('uses deterministic idempotent termination semantics for repeated and competing deletes', async () => {
  const fixture = createFixture()
  const sessionId = await createSession(fixture)

  const first = await fixture.api.terminate(request('DELETE'), sessionId)
  const firstBody = await payload(first)
  const repeated = await fixture.api.terminate(request('DELETE'), sessionId)
  const repeatedBody = await payload(repeated)

  assert.equal(first.status, 200)
  assert.equal(repeated.status, 200)
  assert.equal(firstBody.terminatedAt, repeatedBody.terminatedAt)
  assert.equal(fixture.store.terminationCalls.length, 2)

  const raceFixture = createFixture()
  const raceId = await createSession(raceFixture)
  const raceResponses = await Promise.all(
    Array.from({ length: 8 }, () => raceFixture.api.terminate(request('DELETE'), raceId)),
  )
  const raceBodies = await Promise.all(raceResponses.map(payload))
  assert.ok(raceResponses.every((response) => response.status === 200))
  assert.equal(new Set(raceBodies.map((body) => body.terminatedAt)).size, 1)
})

test('fails closed for malformed session identifiers', async () => {
  const fixture = createFixture()
  for (const response of [
    await fixture.api.get(request('GET'), 'not-a-uuid'),
    await fixture.api.touch(request('POST', '{}'), 'not-a-uuid'),
    await fixture.api.terminate(request('DELETE'), 'not-a-uuid'),
  ]) {
    assert.equal(response.status, 400)
    assert.equal((await payload(response)).code, 'INPUT_REJECTED')
  }
})

test('returns a generic non-leaking response when the server store fails', async () => {
  const api = createTTYLifecycleApi({
    authenticate: async () => OWNER,
    resolveTier: async () => 'pro',
    resolveLimits: resolveTTYResourceLimits,
    getStore: () => {
      throw new Error('internal implementation detail')
    },
  })

  const originalConsoleError = console.error
  console.error = () => {}
  let response: Response | null = null
  try {
    response = await api.create(request('POST', '{}'))
  } finally {
    console.error = originalConsoleError
  }
  if (response === null) throw new Error('Expected a lifecycle API response.')
  const body = await payload(response)

  assert.equal(response.status, 500)
  assert.equal(body.code, 'INTERNAL_ERROR')
  assert.notEqual(body.message, 'internal implementation detail')
})
