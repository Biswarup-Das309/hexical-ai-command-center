import assert from 'node:assert/strict'
import { test } from 'node:test'

import { InvestigationExecutionSynchronizer } from '../../lib/investigations/investigation-execution-sync'
import { InvestigationStore } from '../../lib/investigations/investigation-store'
import type { TTYBrowserExecutionView, TTYBrowserOutputEvent } from '../../lib/tty/tty-execution-api'
import { FakeInvestigationRedis } from './fake-investigation-redis'

const OWNER = 'hydration-owner'
const SESSION_ID = '00000000-0000-4000-8000-000000000921'
const EXECUTION_ID = '00000000-0000-4000-8000-000000000922'
const CREATED_AT = '2026-08-09T11:00:00.000Z'

function execution(state: TTYBrowserExecutionView['state']): TTYBrowserExecutionView {
  return {
    executionId: EXECUTION_ID as never,
    sessionId: SESSION_ID as never,
    state,
    timestamps: { queuedAt: CREATED_AT, updatedAt: '2026-08-09T11:00:03.000Z', leasedAt: CREATED_AT, startedAt: '2026-08-09T11:00:01.000Z', finishedAt: '2026-08-09T11:00:03.000Z' },
    outputSummary: { eventCount: 3, stdoutBytes: 4, stderrBytes: 0, totalBytes: 4, lastEventAt: '2026-08-09T11:00:03.000Z' },
    resourceUsage: { queueWaitMs: 0, startupMs: 0, durationMs: 2 }
  }
}

function output(): readonly TTYBrowserOutputEvent[] {
  return [
    { sequence: 1, timestamp: '2026-08-09T11:00:01.000Z', type: 'state', text: null, state: 'running' },
    { sequence: 2, timestamp: '2026-08-09T11:00:02.000Z', type: 'stdout', text: 'done', state: null },
    { sequence: 3, timestamp: '2026-08-09T11:00:03.000Z', type: 'completion', text: null, state: 'succeeded' }
  ]
}

test('hydration projects durable TTY state and output into an investigation timeline', async () => {
  const redis = new FakeInvestigationRedis()
  const store = new InvestigationStore(redis)
  const created = await store.create(OWNER, { title: 'Hydration', description: '' }, CREATED_AT)
  await store.attachExecution(OWNER, created.investigationId, { executionId: EXECUTION_ID, sessionId: SESSION_ID, attachedAt: CREATED_AT })
  const source = { getExecution: async () => execution('succeeded'), getOutput: async () => output() }
  const synchronizer = new InvestigationExecutionSynchronizer(store, source)

  await synchronizer.synchronize(OWNER, created.investigationId)
  await synchronizer.synchronize(OWNER, created.investigationId)
  const hydrated = await store.get(OWNER, created.investigationId)

  assert.equal(hydrated?.executions[0]?.state, 'succeeded')
  assert.equal(hydrated?.timeline.filter(event => event.type === 'stdout').length, 1)
  assert.equal(hydrated?.timeline.filter(event => event.type === 'execution_started').length, 1)
  assert.equal(hydrated?.timeline.filter(event => event.type === 'execution_completed').length, 1)
  assert.equal(hydrated?.timeline.find(event => event.type === 'stdout')?.payload.text, 'done')
})

test('a replacement synchronizer can replay after reconnect without duplicating evidence', async () => {
  const redis = new FakeInvestigationRedis()
  const firstStore = new InvestigationStore(redis)
  const created = await firstStore.create(OWNER, { title: 'Reconnect', description: '' }, CREATED_AT)
  await firstStore.attachExecution(OWNER, created.investigationId, { executionId: EXECUTION_ID, sessionId: SESSION_ID, attachedAt: CREATED_AT })
  const source = { getExecution: async () => execution('succeeded'), getOutput: async () => output() }
  await new InvestigationExecutionSynchronizer(firstStore, source).synchronize(OWNER, created.investigationId)

  const replacementStore = new InvestigationStore(redis)
  await new InvestigationExecutionSynchronizer(replacementStore, source).synchronize(OWNER, created.investigationId)
  const hydrated = await replacementStore.get(OWNER, created.investigationId)
  assert.equal(hydrated?.timeline.filter(event => event.type === 'stdout').length, 1)
})
