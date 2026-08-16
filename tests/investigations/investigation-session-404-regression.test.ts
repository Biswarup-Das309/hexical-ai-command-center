import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FakeInvestigationRedis } from './fake-investigation-redis'
import {
  createInvestigationApi,
  createInvestigationExecutionApi,
  createInvestigationSessionApi,
} from '../../lib/investigations/investigation-api'
import { investigationRecordKey } from '../../lib/investigations/investigation-keys'
import type { InvestigationLogger } from '../../lib/investigations/investigation-logger'
import { resolveCanonicalInvestigation } from '../../lib/investigations/investigation-resolver'
import { InvestigationStore, type InvestigationRedis } from '../../lib/investigations/investigation-store'
import type { InvestigationId } from '../../lib/investigations/investigation-types'
import { raceActivationBudget } from '../../lib/tty/tty-activation-budget'
import { resetActivationMetricsForTests, snapshotActivationMetrics } from '../../lib/tty/tty-activation-metrics'

const OWNER = 'session-404-owner'
const OTHER = 'session-404-other'

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`https://hexical.test${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

async function read(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

/**
 * Wraps the fake Redis so a specific key can be armed to return a transient
 * miss (null) N times before becoming visible — modeling Upstash multi-region
 * read-after-write lag between the region that served a write and the region
 * that serves the very next read a few milliseconds later. This is the exact
 * mechanism behind "workspace GET sees it, session POST racing right behind
 * it does not."
 */
class LaggedInvestigationRedis implements InvestigationRedis {
  private readonly pendingMisses = new Map<string, number>()

  constructor(private readonly inner: InvestigationRedis) {}

  armMiss(key: string, misses: number): void {
    this.pendingMisses.set(key, misses)
  }

  async get<T>(key: string): Promise<T | null> {
    const remaining = this.pendingMisses.get(key)
    if (remaining && remaining > 0) {
      this.pendingMisses.set(key, remaining - 1)
      return null
    }
    return this.inner.get<T>(key)
  }

  set(key: string, value: unknown, options?: { readonly nx?: boolean }) {
    return this.inner.set(key, value, options)
  }
  del(...keys: string[]) {
    return this.inner.del(...keys)
  }
  incr(key: string) {
    return this.inner.incr(key)
  }
  sadd(key: string, member: string) {
    return this.inner.sadd(key, member)
  }
  srem(key: string, member: string) {
    return this.inner.srem(key, member)
  }
  zadd(key: string, value: { readonly score: number; readonly member: string }) {
    return this.inner.zadd(key, value)
  }
  zrange<T extends unknown[]>(
    key: string,
    min: number,
    max: number,
    options: { readonly rev?: boolean; readonly offset: number; readonly count: number },
  ) {
    return this.inner.zrange<T>(key, min, max, options)
  }
  zrem(key: string, member: string) {
    return this.inner.zrem(key, member)
  }
  xadd(key: string, id: '*', fields: Record<string, string>) {
    return this.inner.xadd(key, id, fields)
  }
  xrange(key: string, start: string, end: string, count?: number) {
    return this.inner.xrange(key, start, end, count)
  }
}

function sessionApiFixture(redis: InvestigationRedis) {
  const store = new InvestigationStore(redis)
  let user: string | null = OWNER
  let sessionCounter = 0
  const activeSessions = new Map<string, 'active' | 'terminated'>()
  const usableSessions = new Map<string, boolean>()
  const workspaceApi = createInvestigationApi({ authenticate: async () => user, getStore: () => store })
  const sessionApi = createInvestigationSessionApi({
    authenticate: async () => user,
    getStore: () => store,
    createTTYSession: async () => {
      sessionCounter += 1
      const sessionId = `00000000-0000-4000-8000-${String(sessionCounter).padStart(12, '0')}`
      activeSessions.set(sessionId, 'active')
      usableSessions.set(sessionId, true)
      return new Response(JSON.stringify({ ok: true, session: { sessionId, status: 'active' } }), { status: 201 })
    },
    getTTYSession: async (_request, sessionId) => {
      const status = activeSessions.get(sessionId)
      if (!status)
        return new Response(JSON.stringify({ ok: false, code: 'SESSION_NOT_FOUND', message: 'not found' }), {
          status: 404,
        })
      return new Response(JSON.stringify({ ok: true, session: { sessionId, status } }), { status: 200 })
    },
    isTTYSessionUsable: async (sessionId) => usableSessions.get(sessionId) === true,
    terminateTTYSession: async (_request, sessionId) => {
      activeSessions.set(sessionId, 'terminated')
      return new Response(JSON.stringify({ ok: true, sessionId }), { status: 200 })
    },
  })
  const executionApi = createInvestigationExecutionApi({
    authenticate: async () => user,
    getStore: () => store,
    admitExecution: async () =>
      new Response(
        JSON.stringify({
          ok: true,
          duplicate: false,
          job: {
            executionId: '00000000-0000-4000-8000-0000000000ee',
            sessionId: [...activeSessions.keys()].at(-1),
            status: 'queued',
          },
        }),
        { status: 202 },
      ),
  })
  return {
    store,
    workspaceApi,
    sessionApi,
    executionApi,
    setUser(value: string | null) {
      user = value
    },
    expireExternally(sessionId: string) {
      activeSessions.delete(sessionId)
    },
    markUnusable(sessionId: string) {
      usableSessions.set(sessionId, false)
    },
  }
}

test('create investigation -> create session returns 201 and persists the session id', async () => {
  const fixture = sessionApiFixture(new FakeInvestigationRedis())
  const created = await read(
    await fixture.workspaceApi.create(request('POST', '/api/investigations', { title: 'Case' })),
  )
  const id = String((created.investigation as Record<string, unknown>).investigationId)

  const response = await fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id)
  assert.equal(response.status, 201)
  const body = await read(response)
  assert.equal(body.reused, false)
  assert.equal((await fixture.store.get(OWNER, id as InvestigationId))?.investigation.ttySessionId, body.sessionId)
})

test('restore session: a second ensure() call after refresh is idempotent and reuses the active session', async () => {
  const fixture = sessionApiFixture(new FakeInvestigationRedis())
  const created = await read(
    await fixture.workspaceApi.create(request('POST', '/api/investigations', { title: 'Case' })),
  )
  const id = String((created.investigation as Record<string, unknown>).investigationId)

  const first = await read(await fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id))
  // Simulate "refresh page": workspace re-hydrates, then the client calls ensureSession() again.
  const workspaceReload = await read(await fixture.workspaceApi.get(request('GET', `/api/investigations/${id}`), id))
  assert.equal((workspaceReload.investigation as Record<string, unknown>).ttySessionId, first.sessionId)

  const restored = await fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id)
  assert.equal(restored.status, 200)
  const restoredBody = await read(restored)
  assert.equal(restoredBody.sessionId, first.sessionId)
  assert.equal(restoredBody.reused, true)
})

test('missing session attachment: an investigation with no ttySessionId provisions one on first ensure()', async () => {
  const fixture = sessionApiFixture(new FakeInvestigationRedis())
  const created = await read(
    await fixture.workspaceApi.create(request('POST', '/api/investigations', { title: 'Case' })),
  )
  const id = String((created.investigation as Record<string, unknown>).investigationId)
  assert.equal((created.investigation as Record<string, unknown>).ttySessionId, null)

  const response = await fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id)
  assert.equal(response.status, 201)
})

test('stale session index: a ttySessionId pointing at a session the TTY store no longer has self-heals instead of 404ing', async () => {
  const fixture = sessionApiFixture(new FakeInvestigationRedis())
  const created = await read(
    await fixture.workspaceApi.create(request('POST', '/api/investigations', { title: 'Case' })),
  )
  const id = String((created.investigation as Record<string, unknown>).investigationId)
  const first = await read(await fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id))

  // The TTY worker plane recycled/expired the session but the investigation record still
  // references it — this is the "session status may appear attached" half of the bug report.
  fixture.expireExternally(String(first.sessionId))

  const repaired = await fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id)
  assert.equal(repaired.status, 201)
  const repairedBody = await read(repaired)
  assert.notEqual(repairedBody.sessionId, first.sessionId)
  assert.equal(
    (await fixture.store.get(OWNER, id as InvestigationId))?.investigation.ttySessionId,
    repairedBody.sessionId,
  )
})

test('active but unusable session index: ensure() replaces a session whose worker runtime disappeared', async () => {
  const fixture = sessionApiFixture(new FakeInvestigationRedis())
  const created = await read(
    await fixture.workspaceApi.create(request('POST', '/api/investigations', { title: 'Unusable runtime case' })),
  )
  const id = String((created.investigation as Record<string, unknown>).investigationId)
  const first = await read(await fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id))

  fixture.markUnusable(String(first.sessionId))
  const repaired = await fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id)
  assert.equal(repaired.status, 201)
  const repairedBody = await read(repaired)
  assert.notEqual(repairedBody.sessionId, first.sessionId)
})

test('concurrent session creation: parallel ensure() calls converge on exactly one persisted session', async () => {
  const fixture = sessionApiFixture(new FakeInvestigationRedis())
  const created = await read(
    await fixture.workspaceApi.create(request('POST', '/api/investigations', { title: 'Case' })),
  )
  const id = String((created.investigation as Record<string, unknown>).investigationId)

  const [a, b] = await Promise.all([
    fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id),
    fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id),
  ])
  assert.ok([a.status, b.status].every((status) => status === 200 || status === 201))
  const [bodyA, bodyB] = await Promise.all([read(a), read(b)])
  assert.equal(bodyA.sessionId, bodyB.sessionId)
  assert.equal((await fixture.store.get(OWNER, id as InvestigationId))?.investigation.ttySessionId, bodyA.sessionId)
})

test('authorization mismatch: a different owner never sees the investigation and cannot attach a session', async () => {
  const fixture = sessionApiFixture(new FakeInvestigationRedis())
  const created = await read(
    await fixture.workspaceApi.create(request('POST', '/api/investigations', { title: 'Case' })),
  )
  const id = String((created.investigation as Record<string, unknown>).investigationId)

  fixture.setUser(OTHER)
  assert.equal((await fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id)).status, 404)
  assert.equal((await fixture.workspaceApi.get(request('GET', `/api/investigations/${id}`), id)).status, 404)
})

test('diagnoseAbsence categorizes a 404 correctly: absent, owner_mismatch, and deleted are distinguishable', async () => {
  const redis = new FakeInvestigationRedis()
  const store = new InvestigationStore(redis)

  const neverExisted = await store.diagnoseAbsence('00000000-0000-4000-8000-000000000000' as InvestigationId, OWNER)
  assert.deepEqual(neverExisted, { present: false, ownerMatches: false, status: null })

  const investigation = await store.create(OWNER, { title: 'Diagnosis case', description: '' })
  const ownerMismatch = await store.diagnoseAbsence(investigation.investigationId, OTHER)
  assert.deepEqual(ownerMismatch, { present: true, ownerMatches: false, status: 'active' })

  const ownerMatches = await store.diagnoseAbsence(investigation.investigationId, OWNER)
  assert.deepEqual(ownerMatches, { present: true, ownerMatches: true, status: 'active' })

  await store.delete(OWNER, investigation.investigationId)
  const deleted = await store.diagnoseAbsence(investigation.investigationId, OWNER)
  assert.deepEqual(deleted, { present: true, ownerMatches: true, status: 'deleted' })
})

test('deleted investigation: session creation 404s permanently, not transiently, after deletion', async () => {
  const fixture = sessionApiFixture(new FakeInvestigationRedis())
  const created = await read(
    await fixture.workspaceApi.create(request('POST', '/api/investigations', { title: 'Case' })),
  )
  const id = String((created.investigation as Record<string, unknown>).investigationId)
  assert.equal((await fixture.workspaceApi.delete(request('DELETE', `/api/investigations/${id}`), id)).status, 200)

  assert.equal((await fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id)).status, 404)
})

test('recovered investigation: an archived-then-restored investigation can attach a session and execute afterward', async () => {
  const fixture = sessionApiFixture(new FakeInvestigationRedis())
  const created = await read(
    await fixture.workspaceApi.create(request('POST', '/api/investigations', { title: 'Case' })),
  )
  const id = String((created.investigation as Record<string, unknown>).investigationId)
  assert.equal(
    (await fixture.workspaceApi.patch(request('PATCH', `/api/investigations/${id}`, { status: 'archived' }), id))
      .status,
    200,
  )
  assert.equal(
    (await fixture.workspaceApi.patch(request('PATCH', `/api/investigations/${id}`, { status: 'active' }), id)).status,
    200,
  )

  const session = await read(await fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id))
  assert.ok(typeof session.sessionId === 'string')

  const execution = await fixture.executionApi.attach(
    request('POST', `/api/investigations/${id}/executions`, {
      sessionId: session.sessionId,
      input: 'run',
      idempotencyKey: 'recovered-investigation-exec-1',
    }),
    id,
  )
  assert.equal(execution.status, 202)
})

test('execute after restore: attaching an execution to a restored (reused) session succeeds', async () => {
  const fixture = sessionApiFixture(new FakeInvestigationRedis())
  const created = await read(
    await fixture.workspaceApi.create(request('POST', '/api/investigations', { title: 'Case' })),
  )
  const id = String((created.investigation as Record<string, unknown>).investigationId)
  await fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id)
  const restored = await read(await fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id))
  assert.equal(restored.reused, true)

  const execution = await fixture.executionApi.attach(
    request('POST', `/api/investigations/${id}/executions`, {
      sessionId: restored.sessionId,
      input: 'run',
      idempotencyKey: 'execute-after-restore-1',
    }),
    id,
  )
  assert.equal(execution.status, 202)
})

test('canonical resolver alone self-heals a single transient replica-lag miss on the record key', async () => {
  const lagged = new LaggedInvestigationRedis(new FakeInvestigationRedis())
  const store = new InvestigationStore(lagged)
  const investigation = await store.create(OWNER, { title: 'Lag case', description: '' })

  // Prove the failure mode first: a *raw* store.get() with no retry sees the miss and 404s,
  // which is exactly what the old session route did before this fix.
  lagged.armMiss(investigationRecordKey(investigation.investigationId), 1)
  const raw = await store.get(OWNER, investigation.investigationId)
  assert.equal(raw, null)

  // The canonical resolver retries through the same transient miss and recovers.
  lagged.armMiss(investigationRecordKey(investigation.investigationId), 1)
  const resolved = await resolveCanonicalInvestigation(store, OWNER, investigation.investigationId, {}, {})
  assert.notEqual(resolved, null)
  assert.equal(resolved?.investigation.investigationId, investigation.investigationId)
})

test('split-brain reproduction: POST /session returns 200/201, not 404, despite the exact replica-lag race that produced the production bug', async () => {
  const lagged = new LaggedInvestigationRedis(new FakeInvestigationRedis())
  const fixture = sessionApiFixture(lagged)
  const created = await read(
    await fixture.workspaceApi.create(request('POST', '/api/investigations', { title: 'Race case' })),
  )
  const id = String((created.investigation as Record<string, unknown>).investigationId)

  // Workspace hydration (GET) observes the write immediately — this is "HYDRATED ACTIVE".
  const workspaceView = await fixture.workspaceApi.get(request('GET', `/api/investigations/${id}`), id)
  assert.equal(workspaceView.status, 200)

  // A session POST racing close behind hits a replica that has not yet observed the write.
  lagged.armMiss(investigationRecordKey(id as InvestigationId), 2)
  const sessionResponse = await fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id)
  assert.equal(sessionResponse.status, 201)
  const body = await read(sessionResponse)
  assert.ok(typeof body.sessionId === 'string')
})

test('activation response budget: a slow startExecution degrades to 202 activationPending instead of blocking the request', async () => {
  const fixture = sessionApiFixture(new FakeInvestigationRedis())
  const created = await read(
    await fixture.workspaceApi.create(request('POST', '/api/investigations', { title: 'Slow activation' })),
  )
  const id = String((created.investigation as Record<string, unknown>).investigationId)
  const session = await read(await fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id))

  let lateSettleObserved: { accepted: boolean } | null = null
  const store = fixture.store
  const executionApi = createInvestigationExecutionApi({
    authenticate: async () => OWNER,
    getStore: () => store,
    activationResponseBudgetMs: 30,
    admitExecution: async () =>
      new Response(
        JSON.stringify({
          ok: true,
          duplicate: false,
          job: { executionId: '00000000-0000-4000-8000-0000000000aa', sessionId: session.sessionId, status: 'queued' },
        }),
        { status: 202 },
      ),
    startExecution: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80))
      const result = { accepted: true }
      lateSettleObserved = result
      return result
    },
  })

  const started = Date.now()
  const response = await executionApi.attach(
    request('POST', `/api/investigations/${id}/executions`, {
      sessionId: session.sessionId,
      input: 'run',
      idempotencyKey: 'slow-activation-1',
    }),
    id,
  )
  const elapsedMs = Date.now() - started
  assert.equal(response.status, 202)
  const body = await read(response)
  assert.equal(body.activationPending, true)
  assert.ok(elapsedMs < 80, `attach() should return before startExecution settles (took ${elapsedMs}ms)`)

  // The activation keeps running in the background rather than being abandoned.
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(lateSettleObserved, { accepted: true })
})

test('activation response budget: a fast rejection (resource_denied/session_terminated/etc.) still returns synchronously as 503', async () => {
  const fixture = sessionApiFixture(new FakeInvestigationRedis())
  const created = await read(
    await fixture.workspaceApi.create(request('POST', '/api/investigations', { title: 'Fast rejection' })),
  )
  const id = String((created.investigation as Record<string, unknown>).investigationId)
  const session = await read(await fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id))

  const executionApi = createInvestigationExecutionApi({
    authenticate: async () => OWNER,
    getStore: () => fixture.store,
    activationResponseBudgetMs: 3000,
    admitExecution: async () =>
      new Response(
        JSON.stringify({
          ok: true,
          duplicate: false,
          job: { executionId: '00000000-0000-4000-8000-0000000000bb', sessionId: session.sessionId, status: 'queued' },
        }),
        { status: 202 },
      ),
    startExecution: async () => ({ accepted: false, reason: 'resource_denied' }),
  })

  const response = await executionApi.attach(
    request('POST', `/api/investigations/${id}/executions`, {
      sessionId: session.sessionId,
      input: 'run',
      idempotencyKey: 'fast-rejection-1',
    }),
    id,
  )
  assert.equal(response.status, 503)
  const body = await read(response)
  assert.equal(body.code, 'EXECUTION_NOT_STARTED')
})

test('activation metrics: pending/late-settlement counters and latency samples reflect raceActivationBudget outcomes', async () => {
  resetActivationMetricsForTests()

  await raceActivationBudget(async () => ({ accepted: true }), 50, {})
  const afterFastAccept = snapshotActivationMetrics()
  assert.equal(afterFastAccept.sampleCount, 0) // raceActivationBudget itself does not record latency samples; the activator does.
  assert.equal(afterFastAccept.pendingCount, 0)

  await raceActivationBudget(async () => ({ accepted: false, reason: 'resource_denied' }), 50, {})
  assert.equal(snapshotActivationMetrics().pendingCount, 0)

  const slow = raceActivationBudget(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
      return { accepted: true }
    },
    10,
    {},
  )
  const pendingResult = await slow
  assert.equal(pendingResult.kind, 'pending')
  assert.equal(snapshotActivationMetrics().pendingCount, 1)

  await new Promise((resolve) => setTimeout(resolve, 80))
  const finalSnapshot = snapshotActivationMetrics()
  assert.equal(finalSnapshot.pendingCount, 1)
  assert.equal(finalSnapshot.lateSettledAcceptedCount, 1)
})

test('phase timing: attach() logs a per-phase breakdown so a slow-but-resolved request is attributable, not opaque', async () => {
  const fixture = sessionApiFixture(new FakeInvestigationRedis())
  const created = await read(
    await fixture.workspaceApi.create(request('POST', '/api/investigations', { title: 'Phase timing case' })),
  )
  const id = String((created.investigation as Record<string, unknown>).investigationId)
  const session = await read(await fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id))

  const logged: Array<{ event: string; fields: Record<string, unknown> }> = []
  const logger: InvestigationLogger = {
    info: (event, fields) => logged.push({ event, fields }),
    warn: (event, fields) => logged.push({ event, fields }),
    error: (event, fields) => logged.push({ event, fields }),
  }

  const executionApi = createInvestigationExecutionApi({
    authenticate: async () => OWNER,
    getStore: () => fixture.store,
    logger,
    admitExecution: async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      return new Response(
        JSON.stringify({
          ok: true,
          duplicate: false,
          job: { executionId: '00000000-0000-4000-8000-0000000000cc', sessionId: session.sessionId, status: 'queued' },
        }),
        { status: 202 },
      )
    },
    startExecution: async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      return { accepted: true }
    },
  })

  await executionApi.attach(
    request('POST', `/api/investigations/${id}/executions`, {
      sessionId: session.sessionId,
      input: 'run',
      idempotencyKey: 'phase-timing-case-1',
    }),
    id,
  )

  const phaseLog = logged.find((entry) => entry.event === 'investigation.execution_attach_phases')
  assert.ok(phaseLog, 'expected a phase breakdown log line')
  assert.equal(typeof phaseLog!.fields.resolve, 'number')
  assert.equal(typeof phaseLog!.fields.admit, 'number')
  assert.equal(typeof phaseLog!.fields.attach, 'number')
  assert.equal(typeof phaseLog!.fields.activate, 'number')
  assert.equal(typeof phaseLog!.fields.totalMs, 'number')
  // admit and activate each slept ~15ms, so activate's cumulative mark should clearly
  // exceed admit's — proving the marks are genuinely sequential elapsed-time checkpoints,
  // not all reporting the same total.
  assert.ok((phaseLog!.fields.activate as number) > (phaseLog!.fields.admit as number))
})

test('100 repeated create/restore/execute cycles remain consistent', async () => {
  const fixture = sessionApiFixture(new FakeInvestigationRedis())
  for (let cycle = 0; cycle < 100; cycle += 1) {
    const created = await read(
      await fixture.workspaceApi.create(request('POST', '/api/investigations', { title: `Cycle ${cycle}` })),
    )
    const id = String((created.investigation as Record<string, unknown>).investigationId)

    const first = await fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id)
    assert.equal(first.status, 201, `cycle ${cycle}: create should be 201`)
    const firstBody = await read(first)

    const restored = await fixture.sessionApi.ensure(request('POST', `/api/investigations/${id}/session`), id)
    assert.equal(restored.status, 200, `cycle ${cycle}: restore should be 200`)
    const restoredBody = await read(restored)
    assert.equal(restoredBody.sessionId, firstBody.sessionId, `cycle ${cycle}: restore should reuse the same session`)

    const execution = await fixture.executionApi.attach(
      request('POST', `/api/investigations/${id}/executions`, {
        sessionId: restoredBody.sessionId,
        input: 'run',
        idempotencyKey: `regression-cycle-${cycle}-execution`,
      }),
      id,
    )
    assert.equal(execution.status, 202, `cycle ${cycle}: execute after restore should be 202`)
  }
})
