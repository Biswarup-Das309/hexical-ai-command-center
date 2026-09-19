import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isEngineeringRunId, restoreEngineeringRun } from '@/lib/engineering/run-recovery'

const FIRST_RUN = '804774dc-a0a3-4f98-ade7-19b0194eb6a3'
const SECOND_RUN = '9ce4f9eb-1dbb-4eec-95c3-7b460ef93580'

test('run recovery prefers a valid locally remembered run', async () => {
  const calls: string[] = []
  const detail = { run: { id: FIRST_RUN }, evidence: ['persisted'] }
  const restored = await restoreEngineeringRun({
    preferredRunId: FIRST_RUN,
    listRuns: async () => [{ id: SECOND_RUN }],
    getRun: async (runId) => {
      calls.push(runId)
      return runId === FIRST_RUN ? detail : null
    },
  })

  assert.deepEqual(restored, detail)
  assert.deepEqual(calls, [FIRST_RUN])
})

test('stale or unauthorized local run falls back to the newest owner-scoped run', async () => {
  const calls: string[] = []
  const restored = await restoreEngineeringRun({
    preferredRunId: FIRST_RUN,
    listRuns: async () => [{ id: SECOND_RUN }, { id: FIRST_RUN }],
    getRun: async (runId) => {
      calls.push(runId)
      return runId === SECOND_RUN ? { run: { id: SECOND_RUN }, evidence: ['owner-scoped'] } : null
    },
  })

  assert.equal(restored?.run.id, SECOND_RUN)
  assert.deepEqual(calls, [FIRST_RUN, SECOND_RUN])
})

test('malformed local IDs, empty run lists, and invalid candidates are safe', async () => {
  assert.equal(isEngineeringRunId('not-a-run-id'), false)
  assert.equal(isEngineeringRunId(null), false)

  const restored = await restoreEngineeringRun({
    preferredRunId: 'not-a-run-id',
    listRuns: async () => [{ id: 'also-not-a-run-id' }],
    getRun: async () => {
      throw new Error('invalid IDs must never be fetched')
    },
  })

  assert.equal(restored, null)
})

test('multiple valid runs use the newest list entry without creating a run', async () => {
  let listCalls = 0
  let detailCalls = 0
  const restored = await restoreEngineeringRun({
    listRuns: async () => {
      listCalls += 1
      return [{ id: FIRST_RUN }, { id: SECOND_RUN }]
    },
    getRun: async (runId) => {
      detailCalls += 1
      return { run: { id: runId }, tasks: ['persisted'] }
    },
  })

  assert.equal(restored?.run.id, FIRST_RUN)
  assert.equal(listCalls, 1)
  assert.equal(detailCalls, 1)
})
