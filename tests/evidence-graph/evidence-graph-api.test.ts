import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createEvidenceGraphApi } from '../../lib/evidence-graph/evidence-graph-api'
import { EvidenceGraphStore } from '../../lib/evidence-graph/evidence-graph-store'
import type { EvidenceGraphObservation } from '../../lib/evidence-graph/evidence-graph-types'
import { InvestigationStore } from '../../lib/investigations/investigation-store'
import { FakeEvidenceGraphRedis } from './fake-evidence-graph-redis'
import { FakeInvestigationRedis } from '../investigations/fake-investigation-redis'

const OWNER = 'graph-api-owner'
const OTHER = 'graph-api-other'
const EXECUTION_ID = '00000000-0000-4000-8000-000000001006'

function request(path: string): Request {
  return new Request(`https://hexical.test${path}`, { method: 'GET' })
}

async function fixture() {
  const investigationStore = new InvestigationStore(new FakeInvestigationRedis())
  const investigation = await investigationStore.create(OWNER, { title: 'API graph', description: '' }, '2026-08-09T12:20:00.000Z')
  const graphStore = new EvidenceGraphStore(new FakeEvidenceGraphRedis(), { getInvestigation: async (ownerUserId, investigationId) => {
    const hydration = await investigationStore.get(ownerUserId, investigationId, { executionLimit: 1, timelineLimit: 1 })
    return hydration ? { investigationId, title: hydration.investigation.title, status: hydration.investigation.status } : null
  } })
  const observation: EvidenceGraphObservation = {
    investigationId: investigation.investigationId,
    executionId: EXECUTION_ID,
    sequence: 1,
    timestamp: '2026-08-09T12:20:01.000Z',
    extraction: { entities: [{ type: 'host', canonicalKey: 'api.example.com', label: 'api.example.com', value: 'api.example.com' }], relationships: [] }
  }
  await graphStore.upsertObservations(OWNER, investigation.investigationId, [observation])
  let user: string | null = OWNER
  const api = createEvidenceGraphApi({ authenticate: async () => user, getStore: () => graphStore })
  return { investigation, api, setUser(value: string | null) { user = value } }
}

async function read(response: Response): Promise<Record<string, unknown>> {
  assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate')
  return await response.json() as Record<string, unknown>
}

test('graph APIs enforce authentication, owner isolation, browser-safe responses, and pagination validation', async () => {
  const fixtureData = await fixture()
  fixtureData.setUser(null)
  assert.equal((await fixtureData.api.summary(request(`/api/investigations/${fixtureData.investigation.investigationId}/graph/summary`), fixtureData.investigation.investigationId)).status, 401)

  fixtureData.setUser(OWNER)
  const summary = await fixtureData.api.summary(request(`/api/investigations/${fixtureData.investigation.investigationId}/graph/summary`), fixtureData.investigation.investigationId)
  const summaryBody = await read(summary)
  assert.equal(summary.status, 200)
  assert.equal('ownerUserId' in summaryBody, false)
  const entities = await fixtureData.api.entities(request(`/api/investigations/${fixtureData.investigation.investigationId}/graph/entities?type=host&limit=1`), fixtureData.investigation.investigationId)
  const entityBody = await read(entities)
  assert.equal(entities.status, 200)
  const entity = (entityBody.entities as Array<Record<string, unknown>>)[0]!
  assert.equal('canonicalKey' in entity, false)
  const invalid = await fixtureData.api.entities(request(`/api/investigations/${fixtureData.investigation.investigationId}/graph/entities?type=unknown`), fixtureData.investigation.investigationId)
  assert.equal(invalid.status, 400)

  fixtureData.setUser(OTHER)
  const denied = await fixtureData.api.graph(request(`/api/investigations/${fixtureData.investigation.investigationId}/graph`), fixtureData.investigation.investigationId)
  assert.equal(denied.status, 404)
})

test('graph entity details and connected evidence remain owner-scoped', async () => {
  const fixtureData = await fixture()
  const entitiesResponse = await fixtureData.api.entities(request(`/api/investigations/${fixtureData.investigation.investigationId}/graph/entities?type=host`), fixtureData.investigation.investigationId)
  const entitiesBody = await read(entitiesResponse)
  const entityId = String((entitiesBody.entities as Array<Record<string, unknown>>)[0]!.id)
  const entity = await fixtureData.api.entity(request(`/api/investigations/${fixtureData.investigation.investigationId}/graph/entities/${entityId}`), fixtureData.investigation.investigationId, entityId)
  assert.equal(entity.status, 200)
  const connected = await fixtureData.api.connected(request(`/api/investigations/${fixtureData.investigation.investigationId}/graph/entities/${entityId}/connected`), fixtureData.investigation.investigationId, entityId)
  assert.equal(connected.status, 200)
  const execution = await fixtureData.api.execution(request(`/api/investigations/${fixtureData.investigation.investigationId}/graph/executions/${EXECUTION_ID}`), fixtureData.investigation.investigationId, EXECUTION_ID)
  assert.equal(execution.status, 200)
})

test('summary recreates the investigation graph root before querying an empty graph', async () => {
  const investigationStore = new InvestigationStore(new FakeInvestigationRedis())
  const investigation = await investigationStore.create(OWNER, { title: 'Empty graph', description: '' }, '2026-08-09T12:30:00.000Z')
  const graphStore = new EvidenceGraphStore(new FakeEvidenceGraphRedis(), {
    getInvestigation: async (ownerUserId, investigationId) => {
      const hydration = await investigationStore.get(ownerUserId, investigationId, { executionLimit: 1, timelineLimit: 1 })
      return hydration ? { investigationId, title: hydration.investigation.title, status: hydration.investigation.status } : null
    }
  })
  const api = createEvidenceGraphApi({
    authenticate: async () => OWNER,
    getStore: () => graphStore,
    getInvestigation: async (ownerUserId, investigationId) => {
      const hydration = await investigationStore.get(ownerUserId, investigationId, { executionLimit: 1, timelineLimit: 1 })
      return hydration ? { investigationId, title: hydration.investigation.title, status: hydration.investigation.status } : null
    }
  })

  const response = await api.summary(request(`/api/investigations/${investigation.investigationId}/graph/summary`), investigation.investigationId)
  const body = await read(response)
  const summary = body.summary as Record<string, unknown>
  assert.equal(response.status, 200)
  assert.equal(summary.entityCount, 1)
  assert.equal((summary.entitiesByType as Record<string, number>).investigation, 1)
})
