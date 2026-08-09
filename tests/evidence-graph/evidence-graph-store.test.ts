import assert from 'node:assert/strict'
import { test } from 'node:test'

import { graphEntityId } from '../../lib/evidence-graph/evidence-graph-identity'
import { EvidenceGraphStore } from '../../lib/evidence-graph/evidence-graph-store'
import type { EvidenceGraphObservation } from '../../lib/evidence-graph/evidence-graph-types'
import { InvestigationStore } from '../../lib/investigations/investigation-store'
import { FakeEvidenceGraphRedis } from './fake-evidence-graph-redis'
import { FakeInvestigationRedis } from '../investigations/fake-investigation-redis'

const OWNER = 'graph-owner'
const OTHER = 'graph-other'
const SESSION_ID = '00000000-0000-4000-8000-000000001002'
const EXECUTION_ID = '00000000-0000-4000-8000-000000001003'
const CREATED_AT = '2026-08-09T12:00:00.000Z'

async function fixture() {
  const investigationStore = new InvestigationStore(new FakeInvestigationRedis())
  const investigation = await investigationStore.create(OWNER, { title: 'Graph case', description: '' }, CREATED_AT)
  const graphRedis = new FakeEvidenceGraphRedis()
  const graphStore = new EvidenceGraphStore(graphRedis, { getInvestigation: async (ownerUserId, investigationId) => {
    const hydration = await investigationStore.get(ownerUserId, investigationId, { executionLimit: 1, timelineLimit: 1 })
    return hydration ? { investigationId, title: hydration.investigation.title, status: hydration.investigation.status } : null
  } })
  return { investigationStore, investigation, graphStore, graphRedis }
}

function observation(investigationId: string, executionId: string, sequence: number, key: string): EvidenceGraphObservation {
  return {
    investigationId: investigationId as never,
    executionId,
    sequence,
    timestamp: `2026-08-09T12:00:${String(sequence).padStart(2, '0')}.000Z`,
    extraction: {
      entities: [{ type: 'host', canonicalKey: key, label: key, value: key, metadata: { parser: 'test' } }],
      relationships: []
    }
  }
}

test('persists immutable graph entities, directional edges, and prevents duplicate writes', async () => {
  const { investigation, graphStore } = await fixture()
  const item = observation(investigation.investigationId, EXECUTION_ID, 1, 'host.example.com')
  const [first, second] = await Promise.all([graphStore.upsertObservations(OWNER, investigation.investigationId, [item]), graphStore.upsertObservations(OWNER, investigation.investigationId, [item])])
  const summary = await graphStore.summary(OWNER, investigation.investigationId)
  assert.ok(summary)
  assert.equal(summary.entitiesByType.host, 1)
  assert.equal(summary.entityCount, 3)
  assert.equal(summary.relationshipCount, 3)
  assert.equal(first.entitiesCreated + second.entitiesCreated, 3)
  assert.equal(first.relationshipsCreated + second.relationshipsCreated, 3)
  const host = (await graphStore.listEntities(OWNER, investigation.investigationId, { type: 'host' }))!.entities[0]!
  const connected = await graphStore.getConnected(OWNER, investigation.investigationId, host.id)
  assert.ok(connected)
  assert.ok(connected.relationships.some(edge => edge.source === graphEntityId(investigation.investigationId, 'investigation', investigation.investigationId) && edge.target === host.id))
  assert.equal(await graphStore.summary(OTHER, investigation.investigationId), null)
})

test('supports bounded entity and relationship pagination and restart recovery', async () => {
  const { investigation, graphStore, graphRedis } = await fixture()
  const observations = Array.from({ length: 135 }, (_, index) => observation(investigation.investigationId, EXECUTION_ID, index + 1, `host-${index}.example.com`))
  await graphStore.upsertObservations(OWNER, investigation.investigationId, observations)
  const first = await graphStore.listEntities(OWNER, investigation.investigationId, { type: 'host', limit: 20 })
  assert.ok(first)
  assert.equal(first.entities.length, 20)
  assert.ok(first.nextCursor)
  const second = await graphStore.listEntities(OWNER, investigation.investigationId, { type: 'host', limit: 20, cursor: first.nextCursor })
  assert.equal(second?.entities.length, 20)
  const relationships = await graphStore.listRelationships(OWNER, investigation.investigationId, { limit: 10 })
  assert.equal(relationships?.relationships.length, 10)
  const restarted = new EvidenceGraphStore(graphRedis, { getInvestigation: async () => ({ investigationId: investigation.investigationId, title: 'Graph case', status: 'active' }) })
  const recovered = await restarted.summary(OWNER, investigation.investigationId)
  assert.equal(recovered?.entitiesByType.host, 135)
})

test('handles a large bounded entity set without unbounded query responses', async () => {
  const { investigation, graphStore } = await fixture()
  const large: EvidenceGraphObservation = {
    investigationId: investigation.investigationId,
    executionId: EXECUTION_ID,
    sequence: 1,
    timestamp: CREATED_AT,
    extraction: {
      entities: Array.from({ length: 10_000 }, (_, index) => ({ type: 'domain' as const, canonicalKey: `host-${index}.example.com`, label: `host-${index}.example.com`, value: `host-${index}.example.com`, metadata: { parser: 'large-test' } })),
      relationships: []
    }
  }
  await graphStore.upsertObservations(OWNER, investigation.investigationId, [large])
  const summary = await graphStore.summary(OWNER, investigation.investigationId)
  const page = await graphStore.listEntities(OWNER, investigation.investigationId, { type: 'domain', limit: 100 })
  assert.equal(summary?.entitiesByType.domain, 10_000)
  assert.equal(page?.entities.length, 100)
})
