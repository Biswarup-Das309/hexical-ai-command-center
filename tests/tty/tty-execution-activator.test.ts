import test from 'node:test'
import assert from 'node:assert/strict'

import { TTYExecutionActivator } from '../../lib/tty/tty-execution-activator'
import { createQueuedTTYExecutionState, type TTYExecutionStateRecord } from '../../lib/tty/tty-execution-state'
import type { TTYExecutionCoordinatorRunOptions } from '../../lib/tty/tty-execution-coordinator'

const executionId = '00000000-0000-4000-8000-000000000601' as never
const sessionId = '00000000-0000-4000-8000-000000000602' as never
const leasedState: TTYExecutionStateRecord = {
  ...createQueuedTTYExecutionState(executionId, sessionId, '2026-08-09T00:00:00.000Z'),
  state: 'leased',
  updatedAt: '2026-08-09T00:00:01.000Z',
  leasedAt: '2026-08-09T00:00:01.000Z',
  workerId: 'worker-activation-test' as never,
  leaseId: 'lease-activation-test' as never
}

test('activation resolves only after the coordinator has persisted acceptance and deduplicates concurrent calls', async () => {
  let calls = 0
  let options: TTYExecutionCoordinatorRunOptions | undefined
  let finish!: () => void
  const running = new Promise<void>(resolve => { finish = resolve })
  const activator = new TTYExecutionActivator({
    coordinator: {
      getState: async () => null,
      run: async (_executionId: typeof executionId, _sessionId: typeof sessionId, receivedOptions: TTYExecutionCoordinatorRunOptions = {}) => {
        calls += 1
        options = receivedOptions
        await running
        return { accepted: true, state: leasedState }
      }
    } as never
  })

  const first = activator.activate(executionId, sessionId)
  const second = activator.activate(executionId, sessionId)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  options?.onAccepted?.(leasedState)
  assert.deepEqual(await first, { accepted: true, state: leasedState })
  assert.deepEqual(await second, { accepted: true, state: leasedState })
  finish()
})

test('activation surfaces coordinator rejection and logs its reason', async () => {
  const failures: string[] = []
  const activator = new TTYExecutionActivator({
    coordinator: {
      getState: async () => null,
      run: async () => ({ accepted: false, reason: 'missing_job', state: null })
    } as never,
    onFailure: failure => { failures.push(`${failure.phase}:${failure.reason}`) }
  })

  assert.deepEqual(await activator.activate(executionId, sessionId), { accepted: false, state: null, reason: 'missing_job' })
  assert.deepEqual(failures, ['run:missing_job'])
})

test('activation accepts a state atomically claimed by another process without a second execution', async () => {
  let calls = 0
  const activator = new TTYExecutionActivator({
    coordinator: {
      getState: async () => null,
      run: async () => {
        calls += 1
        return { accepted: false, reason: 'not_queued', state: leasedState }
      }
    } as never
  })

  assert.deepEqual(await activator.activate(executionId, sessionId), { accepted: true, state: leasedState })
  assert.equal(calls, 1)
})
