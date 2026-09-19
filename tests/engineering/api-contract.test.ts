import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('engineering routes authenticate, use bounded snapshots, and keep unsupported checks explicit', async () => {
  const ingest = await readFile('app/api/engineering/runs/route.ts', 'utf8')
  const verify = await readFile('app/api/engineering/runs/[runId]/verify/route.ts', 'utf8')
  const swarm = await readFile('app/api/engineering/runs/[runId]/swarm/route.ts', 'utf8')
  const store = await readFile('lib/engineering/engineering-store.ts', 'utf8')

  assert.match(ingest, /await auth\(\)/)
  assert.match(ingest, /REPOSITORY_MAX_TOTAL_BYTES/)
  assert.match(ingest, /createRepository\(ownerUserId, graph\)/)
  assert.match(verify, /await auth\(\)/)
  assert.match(verify, /runRepositoryVerification/)
  assert.match(swarm, /orchestrateEngineeringEvidence/)
  assert.match(swarm, /orchestration\.objective/)
  assert.match(swarm, /Engineering role reconciliation/)
  assert.match(swarm, /await auth\(\)/)
  assert.match(swarm, /status: 'PLANNING'/)
  assert.match(swarm, /static_repository_evidence/)
  assert.match(store, /eq\('owner_user_id', ownerUserId\)/)
  assert.match(store, /eq\('owner_user_id', ownerUserId\)/)
  assert.match(store, /input_context: asJson\(input.inputContext/)
  assert.match(store, /evidence: asJson\(input.evidence/)
})
