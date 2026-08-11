import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FakeEvidenceGraphRedis } from './fake-evidence-graph-redis'
import { EvidenceGraphStore } from '../../lib/evidence-graph/evidence-graph-store'
import { EvidenceGraphSynchronizer } from '../../lib/evidence-graph/evidence-graph-sync'
import { InvestigationStore } from '../../lib/investigations/investigation-store'
import type { InvestigationId } from '../../lib/investigations/investigation-types'
import type { TTYBrowserExecutionView, TTYBrowserOutputEvent } from '../../lib/tty/tty-execution-api'
import { FakeInvestigationRedis } from '../investigations/fake-investigation-redis'

const OWNER = 'sync-owner'
const SESSION_ID = '00000000-0000-4000-8000-000000001004'
const EXECUTION_ID = '00000000-0000-4000-8000-000000001005'
const CREATED_AT = '2026-08-09T12:10:00.000Z'

function execution(): TTYBrowserExecutionView {
  return {
    executionId: EXECUTION_ID as never,
    sessionId: SESSION_ID as never,
    state: 'succeeded',
    timestamps: {
      queuedAt: CREATED_AT,
      updatedAt: '2026-08-09T12:10:05.000Z',
      leasedAt: CREATED_AT,
      startedAt: '2026-08-09T12:10:01.000Z',
      finishedAt: '2026-08-09T12:10:05.000Z',
    },
    outputSummary: {
      eventCount: 5,
      stdoutBytes: 100,
      stderrBytes: 0,
      totalBytes: 100,
      lastEventAt: '2026-08-09T12:10:05.000Z',
    },
    diagnostics: { exitCode: 0, signal: null, failureCode: null, completionReason: 'process_exit' },
    resourceUsage: { queueWaitMs: 1, startupMs: 2, durationMs: 3 },
  }
}

function source(output: readonly TTYBrowserOutputEvent[], investigationStore: InvestigationStore) {
  return {
    getInvestigation: async (ownerUserId: string, id: InvestigationId) => {
      const hydrated = await investigationStore.get(ownerUserId, id, { executionLimit: 1, timelineLimit: 1 })
      return hydrated
        ? {
            investigationId: hydrated.investigation.investigationId,
            title: hydrated.investigation.title,
            status: hydrated.investigation.status,
          }
        : null
    },
    getExecutions: async (ownerUserId: string, id: InvestigationId) =>
      (await investigationStore.get(ownerUserId, id, { executionLimit: 50, timelineLimit: 1 }))?.executions ?? [],
    getExecution: async () => execution(),
    getOutput: async () => output,
  }
}

async function fixture(output: readonly TTYBrowserOutputEvent[]) {
  const investigationStore = new InvestigationStore(new FakeInvestigationRedis())
  const investigation = await investigationStore.create(OWNER, { title: 'Sync graph', description: '' }, CREATED_AT)
  await investigationStore.attachExecution(OWNER, investigation.investigationId, {
    executionId: EXECUTION_ID,
    sessionId: SESSION_ID,
    attachedAt: CREATED_AT,
  })
  const graphRedis = new FakeEvidenceGraphRedis()
  const graphStore = new EvidenceGraphStore(graphRedis, {
    getInvestigation: async (ownerUserId, id) => source(output, investigationStore).getInvestigation(ownerUserId, id),
  })
  const synchronizer = new EvidenceGraphSynchronizer(graphStore, source(output, investigationStore))
  return { investigation, investigationStore, graphStore, synchronizer }
}

test('synchronizes streaming output into a graph and remains replay-safe', async () => {
  const output: TTYBrowserOutputEvent[] = [
    {
      sequence: 1,
      timestamp: '2026-08-09T12:10:01.000Z',
      type: 'stdout',
      text: 'Nmap scan report for app.example.com (192.0.2.20)\n',
      state: null,
    },
    {
      sequence: 2,
      timestamp: '2026-08-09T12:10:02.000Z',
      type: 'stdout',
      text: '443/tcp open https nginx 1.25\n',
      state: null,
    },
    {
      sequence: 3,
      timestamp: '2026-08-09T12:10:03.000Z',
      type: 'stdout',
      text: 'https://app.example.com\nHTTP/1.1 200 OK\n',
      state: null,
    },
    { sequence: 4, timestamp: '2026-08-09T12:10:04.000Z', type: 'completion', text: null, state: 'succeeded' },
  ]
  const { investigation, graphStore, synchronizer } = await fixture(output)
  await synchronizer.synchronizeInvestigation(OWNER, investigation.investigationId)
  const first = await graphStore.summary(OWNER, investigation.investigationId)
  await synchronizer.synchronizeInvestigation(OWNER, investigation.investigationId)
  const second = await graphStore.summary(OWNER, investigation.investigationId)
  assert.ok(first)
  assert.deepEqual(second, first)
  assert.equal(second.entitiesByType.host, 1)
  assert.equal(second.entitiesByType.service, 1)
  assert.equal(second.entitiesByType.url, 1)
  assert.ok((await graphStore.getProcessedSequences(OWNER, investigation.investigationId, EXECUTION_ID))?.size === 4)
})

test('incremental synchronization survives replacement synchronizers and appends only new output', async () => {
  const output: TTYBrowserOutputEvent[] = [
    {
      sequence: 1,
      timestamp: '2026-08-09T12:10:01.000Z',
      type: 'stdout',
      text: 'Nmap scan report for incremental.example.com (192.0.2.21)\n',
      state: null,
    },
  ]
  const fixtureData = await fixture(output)
  await fixtureData.synchronizer.synchronizeExecution(OWNER, fixtureData.investigation.investigationId, EXECUTION_ID)
  const first = await fixtureData.graphStore.summary(OWNER, fixtureData.investigation.investigationId)
  output.push({
    sequence: 2,
    timestamp: '2026-08-09T12:10:02.000Z',
    type: 'stdout',
    text: '8080/tcp open http Caddy 2.7\n',
    state: null,
  })
  const replacement = new EvidenceGraphSynchronizer(
    fixtureData.graphStore,
    source(output, fixtureData.investigationStore),
  )
  await replacement.synchronizeExecution(OWNER, fixtureData.investigation.investigationId, EXECUTION_ID)
  const second = await fixtureData.graphStore.summary(OWNER, fixtureData.investigation.investigationId)
  assert.ok(first && second)
  assert.equal(first.entitiesByType.host, 1)
  assert.equal(second.entitiesByType.host, 1)
  assert.equal(second.entitiesByType.port, 1)
})

test('concurrent graph synchronization is idempotent and malformed output is ignored safely', async () => {
  const output: TTYBrowserOutputEvent[] = [
    {
      sequence: 1,
      timestamp: '2026-08-09T12:10:01.000Z',
      type: 'stdout',
      text: '\u0000\u0001 malformed\n',
      state: null,
    },
    { sequence: 2, timestamp: '2026-08-09T12:10:02.000Z', type: 'stdout', text: 'CVE-2024-9999\n', state: null },
  ]
  const { investigation, graphStore, synchronizer } = await fixture(output)
  await Promise.all([
    synchronizer.synchronizeExecution(OWNER, investigation.investigationId, EXECUTION_ID),
    synchronizer.synchronizeExecution(OWNER, investigation.investigationId, EXECUTION_ID),
    synchronizer.synchronizeExecution(OWNER, investigation.investigationId, EXECUTION_ID),
  ])
  const summary = await graphStore.summary(OWNER, investigation.investigationId)
  assert.equal(summary?.entitiesByType.vulnerability, 1)
  assert.equal((await graphStore.getProcessedSequences(OWNER, investigation.investigationId, EXECUTION_ID))?.size, 2)
})
