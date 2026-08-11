import assert from 'node:assert/strict'
import test from 'node:test'
import { TTYExecutionApi } from '@/lib/tty/tty-execution-api'
import { createQueuedTTYExecutionState } from '@/lib/tty/tty-execution-state'
import { createTTYExecutionId, createTTYSessionId } from '@/lib/tty/tty-types'

test('replays an owned execution after the live session record has expired', async () => {
  const executionId = createTTYExecutionId()
  const sessionId = createTTYSessionId()
  const state = createQueuedTTYExecutionState(executionId, sessionId, '2026-08-11T00:00:00.000Z', 'owner')
  const api = new TTYExecutionApi({
    getState: async () => state,
    sessionStore: { getSession: async () => null },
    outputStream: {
      read: async () => [
        {
          eventId: 'event-1',
          sequence: 1,
          timestamp: '2026-08-11T00:00:01.000Z',
          executionId,
          sessionId,
          type: 'stdout' as const,
          data: { text: 'HEXICAL_EXECUTE_SMOKE_TEST\n', byteLength: 27 },
        },
      ],
    },
  })

  const output = await api.getOutput(executionId, 'owner')
  assert.equal(output?.[0]?.text, 'HEXICAL_EXECUTE_SMOKE_TEST\n')
  assert.equal(await api.getOutput(executionId, 'other'), null)
})

test('keeps legacy records session-authorized until they expire', async () => {
  const executionId = createTTYExecutionId()
  const sessionId = createTTYSessionId()
  const state = createQueuedTTYExecutionState(executionId, sessionId, '2026-08-11T00:00:00.000Z')
  const api = new TTYExecutionApi({
    getState: async () => state,
    sessionStore: { getSession: async () => null },
    outputStream: { read: async () => [] },
  })
  assert.equal(await api.getOutput(executionId, 'owner'), null)
})
