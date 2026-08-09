import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createInvestigationApi, createInvestigationExecutionApi } from '../../lib/investigations/investigation-api'
import { InvestigationStore } from '../../lib/investigations/investigation-store'
import { FakeInvestigationRedis } from './fake-investigation-redis'

const OWNER = 'api-investigation-owner'
const OTHER = 'api-other-owner'
const SESSION_ID = '00000000-0000-4000-8000-000000000911'
const EXECUTION_ID = '00000000-0000-4000-8000-000000000912'

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`https://hexical.test${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  })
}

async function read(response: Response): Promise<Record<string, unknown>> {
  assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate')
  return await response.json() as Record<string, unknown>
}

function fixture() {
  const store = new InvestigationStore(new FakeInvestigationRedis())
  let user: string | null = OWNER
  const api = createInvestigationApi({ authenticate: async () => user, getStore: () => store })
  return { store, api, setUser(value: string | null) { user = value } }
}

test('investigation API enforces authentication, owner authorization, no-store, and browser-safe responses', async () => {
  const fixtureData = fixture()
  fixtureData.setUser(null)
  assert.equal((await fixtureData.api.create(request('POST', '/api/investigations', { title: 'Denied', description: '' }))).status, 401)

  fixtureData.setUser(OWNER)
  const createdResponse = await fixtureData.api.create(request('POST', '/api/investigations', { title: 'Owner case', description: 'Description' }))
  assert.equal(createdResponse.status, 201)
  const createdBody = await read(createdResponse)
  const investigation = createdBody.investigation as Record<string, unknown>
  const investigationId = String(investigation.investigationId)
  assert.equal('ownerUserId' in investigation, false)

  fixtureData.setUser(OTHER)
  assert.equal((await fixtureData.api.get(request('GET', `/api/investigations/${investigationId}`), investigationId)).status, 404)
  const otherList = await fixtureData.api.list(request('GET', '/api/investigations'))
  assert.deepEqual((await read(otherList)).investigations, [])

  fixtureData.setUser(OWNER)
  assert.equal((await fixtureData.api.patch(request('PATCH', `/api/investigations/${investigationId}`, { status: 'archived' }), investigationId)).status, 200)
  const invalid = await fixtureData.api.patch(request('PATCH', `/api/investigations/${investigationId}`, { ownerUserId: OTHER }), investigationId)
  assert.equal(invalid.status, 400)
  const detail = await fixtureData.api.get(request('GET', `/api/investigations/${investigationId}`), investigationId)
  assert.equal((await read(detail)).investigation instanceof Object, true)

  const deleted = await fixtureData.api.delete(request('DELETE', `/api/investigations/${investigationId}`), investigationId)
  assert.equal(deleted.status, 200)
  assert.equal((await fixtureData.api.get(request('GET', `/api/investigations/${investigationId}`), investigationId)).status, 404)
})

test('investigation list pagination and lifecycle mutations remain owner-scoped', async () => {
  const fixtureData = fixture()
  const ids: string[] = []
  for (const title of ['First case', 'Second case', 'Third case']) {
    const created = await fixtureData.api.create(request('POST', '/api/investigations', { title }))
    const body = await read(created)
    ids.push(String((body.investigation as Record<string, unknown>).investigationId))
  }

  const firstPage = await read(await fixtureData.api.list(request('GET', '/api/investigations?limit=1')))
  const secondPage = await read(await fixtureData.api.list(request('GET', `/api/investigations?limit=1&cursor=${String(firstPage.nextCursor)}`)))
  const firstInvestigations = firstPage.investigations as Array<Record<string, unknown>>
  const secondInvestigations = secondPage.investigations as Array<Record<string, unknown>>
  assert.equal(firstInvestigations.length, 1)
  assert.equal(secondInvestigations.length, 1)
  assert.notEqual(String(firstInvestigations[0]?.investigationId), String(secondInvestigations[0]?.investigationId))

  const archived = await fixtureData.api.patch(request('PATCH', `/api/investigations/${ids[0]}`, { status: 'archived' }), ids[0]!)
  assert.equal(archived.status, 200)
  const restored = await fixtureData.api.patch(request('PATCH', `/api/investigations/${ids[0]}`, { status: 'active' }), ids[0]!)
  assert.equal(restored.status, 200)
  const deleted = await fixtureData.api.delete(request('DELETE', `/api/investigations/${ids[1]}`), ids[1]!)
  assert.equal(deleted.status, 200)

  const visible = await read(await fixtureData.api.list(request('GET', '/api/investigations?limit=50')))
  const visibleIds = (visible.investigations as Array<Record<string, unknown>>).map(item => String(item.investigationId))
  assert.equal(visibleIds.includes(ids[0]!), true)
  assert.equal(visibleIds.includes(ids[1]!), false)
  assert.equal(visibleIds.includes(ids[2]!), true)
})

test('timeline API validates and persists notes and evidence bookmarks', async () => {
  const fixtureData = fixture()
  const created = await fixtureData.api.create(request('POST', '/api/investigations', { title: 'Timeline case' }))
  const createdBody = await read(created)
  const id = String((createdBody.investigation as Record<string, unknown>).investigationId)
  const second = await fixtureData.api.create(request('POST', '/api/investigations', { title: 'Timeline case 2' }))
  const secondBody = await read(second)
  const secondId = String((secondBody.investigation as Record<string, unknown>).investigationId)
  assert.match(id, /^[0-9a-f-]{36}$/)

  const note = await fixtureData.api.timeline(request('POST', `/api/investigations/${secondId}/timeline`, { type: 'note', body: 'Validate source provenance.' }), secondId)
  const bookmark = await fixtureData.api.timeline(request('POST', `/api/investigations/${secondId}/timeline`, { type: 'bookmark', executionId: EXECUTION_ID, sequence: 2, lineNumber: 4, kind: 'finding', label: 'Finding', excerpt: 'Evidence' }), secondId)
  assert.equal(note.status, 201)
  assert.equal(bookmark.status, 201)
  assert.equal((await fixtureData.api.timeline(request('POST', `/api/investigations/${secondId}/timeline`, { type: 'note', body: '' }), secondId)).status, 400)
})

test('investigation execution attachment composes with the frozen admission boundary', async () => {
  const store = new InvestigationStore(new FakeInvestigationRedis())
  let user: string | null = OWNER
  const api = createInvestigationApi({ authenticate: async () => user, getStore: () => store })
  const created = await api.create(request('POST', '/api/investigations', { title: 'Execution attachment' }))
  const body = await read(created)
  const investigationId = String((body.investigation as Record<string, unknown>).investigationId)
  let admissions = 0
  const executionApi = createInvestigationExecutionApi({
    authenticate: async () => user,
    getStore: () => store,
    admitExecution: async () => {
      admissions += 1
      return new Response(JSON.stringify({ ok: true, duplicate: false, job: { executionId: EXECUTION_ID, sessionId: SESSION_ID, status: 'queued' } }), { status: 202 })
    }
  })

  const attached = await executionApi.attach(request('POST', `/api/investigations/${investigationId}/executions`, { sessionId: SESSION_ID, input: 'approved probe', idempotencyKey: 'investigation-idempotency-1' }), investigationId)
  assert.equal(attached.status, 202)
  const attachedBody = await read(attached)
  assert.equal((attachedBody.execution as Record<string, unknown>).executionId, EXECUTION_ID)
  user = OTHER
  assert.equal((await executionApi.attach(request('POST', `/api/investigations/${investigationId}/executions`, { sessionId: SESSION_ID, input: 'approved probe', idempotencyKey: 'investigation-idempotency-2' }), investigationId)).status, 404)
  assert.equal(admissions, 1)
})
