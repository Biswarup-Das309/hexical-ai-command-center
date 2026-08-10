import assert from 'node:assert/strict'
import test from 'node:test'
import type { TTYQueuedJob } from '../../lib/tty/tty-execution-admission'
import { createTTYExecutionAdmissionApi } from '../../lib/tty/tty-execution-admission-api'
import type { TTYExecutionAdmissionApiDependencies } from '../../lib/tty/tty-execution-admission-api'
import type { InternalTTYSession } from '../../lib/tty/tty-types'

const session: InternalTTYSession = {
  sessionId: '00000000-0000-4000-8000-000000000001' as InternalTTYSession['sessionId'],
  ownerUserId: 'user-1',
  tier: 'pro',
  status: 'active',
  createdAt: new Date().toISOString(),
  lastActiveAt: new Date().toISOString(),
  limits: {
    maxConcurrentSessions: 3,
    maxConcurrentExecutionsPerSession: 4,
    maxExecutionsPerMinute: 60,
    maxExecutionDurationMs: 30_000,
    maxSessionIdleMs: 900_000,
    maxSessionDurationMs: 3_600_000,
    maxOutputBytesPerExecution: 262_144,
    maxQueueDepth: 20,
  },
  usage: {
    activeSessions: 1,
    activeExecutionsInSession: 0,
    executionsInLastMinute: 0,
    queueDepth: 0,
    capturedAt: new Date().toISOString(),
  },
}

const job: TTYQueuedJob = {
  executionId: '00000000-0000-4000-8000-000000000002' as TTYQueuedJob['executionId'],
  sessionId: session.sessionId,
  ownerUserId: session.ownerUserId,
  kind: 'session_utility',
  status: 'queued',
  createdAt: new Date().toISOString(),
  admittedAt: new Date().toISOString(),
  authorizationScopeId: null,
  resource: { maxExecutionDurationMs: 30_000, maxOutputBytes: 262_144 },
}

function api(overrides: Partial<TTYExecutionAdmissionApiDependencies> = {}) {
  const deps: TTYExecutionAdmissionApiDependencies = {
    authenticate: async () => 'user-1',
    resolveTier: async () => 'pro',
    getSession: async (id, owner) => (id === session.sessionId && owner === session.ownerUserId ? session : null),
    admission: { admit: async () => ({ admitted: true, job, duplicate: false }) } as never,
    ...overrides,
  }
  return createTTYExecutionAdmissionApi(deps)
}

function request(body: unknown): Request {
  return new Request('http://localhost', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

test('rejects unauthenticated and malformed admission requests', async () => {
  const unauthenticated = await api({ authenticate: async () => null }).admit(
    request({ input: 'help', idempotencyKey: 'abcdefghijklmnop' }),
    session.sessionId,
  )
  assert.equal(unauthenticated.status, 401)
  const malformed = await api().admit(
    request({ input: 'help', idempotencyKey: 'short', kindHint: 'recon_probe' }),
    session.sessionId,
  )
  assert.equal(malformed.status, 400)
})

test('derives classification and returns only the browser-safe queued job', async () => {
  let seenKind: string | undefined
  const result = await api({
    admission: {
      admit: async (_args: unknown) => {
        seenKind = 'recon_probe'
        return { admitted: true, job, duplicate: false }
      },
    } as never,
  }).admit(request({ input: 'recon 10.0.0.1', idempotencyKey: 'abcdefghijklmnop' }), session.sessionId)
  assert.equal(result.status, 202)
  const body = (await result.json()) as { job: Record<string, unknown> }
  assert.equal(seenKind, 'recon_probe')
  assert.equal(body.job.status, 'queued')
  assert.equal(body.job.kind, 'session_utility')
  assert.equal('ownerUserId' in body.job, false)
  assert.equal('authorizationScopeId' in body.job, false)
  assert.equal('resource' in body.job, false)
})

test('returns a durable queued job when web activation is temporarily unavailable', async () => {
  const starts: string[] = []
  const unavailable = await api({
    startExecution: async (executionId, sessionId) => {
      starts.push(`${executionId}:${sessionId}`)
      return { accepted: false }
    },
  }).admit(request({ input: 'echo hello', idempotencyKey: 'abcdefghijklmnop' }), session.sessionId)
  assert.equal(unavailable.status, 202)
  assert.deepEqual(await unavailable.json(), {
    ok: true,
    job: {
      executionId: job.executionId,
      sessionId: job.sessionId,
      kind: job.kind,
      status: job.status,
      createdAt: job.createdAt,
      admittedAt: job.admittedAt,
    },
    duplicate: false,
    activationPending: true,
  })
  assert.deepEqual(starts, [`${job.executionId}:${session.sessionId}`])

  const accepted = await api({ startExecution: async () => ({ accepted: true }) }).admit(
    request({ input: 'echo hello', idempotencyKey: 'abcdefghijklmnop' }),
    session.sessionId,
  )
  assert.equal(accepted.status, 202)
  assert.equal(((await accepted.json()) as { job: { executionId: string } }).job.executionId, job.executionId)
})

test('fails closed when authorization denies or the session is not owned', async () => {
  const denied = await api({
    admission: { admit: async () => ({ admitted: false, reason: 'authorization_required' }) } as never,
  }).admit(request({ input: 'recon example.com', idempotencyKey: 'abcdefghijklmnop' }), session.sessionId)
  assert.equal(denied.status, 403)
  const missing = await api({ getSession: async () => null }).admit(
    request({ input: 'help', idempotencyKey: 'abcdefghijklmnop' }),
    session.sessionId,
  )
  assert.equal(missing.status, 404)
})

test('does not admit non-entitled or terminal sessions', async () => {
  const tierDenied = await api({ resolveTier: async () => 'free' }).admit(
    request({ input: 'help', idempotencyKey: 'abcdefghijklmnop' }),
    session.sessionId,
  )
  assert.equal(tierDenied.status, 403)
  const terminated = await api({ getSession: async () => ({ ...session, status: 'terminated' }) }).admit(
    request({ input: 'help', idempotencyKey: 'abcdefghijklmnop' }),
    session.sessionId,
  )
  assert.equal(terminated.status, 409)
})
