import assert from 'node:assert/strict'
import test from 'node:test'
import { TTYPersistentRecoveryService } from '../../lib/tty/tty-persistent-recovery-service'
import type { TTYPersistentExecutionRecord } from '../../lib/tty/tty-persistent-session-manager'
import type { TTYExecutionId, TTYSessionId } from '../../lib/tty/tty-types'
import type { TTYWorkerId } from '../../lib/tty/tty-worker-types'

const workerId = 'worker-persistent-recovery' as TTYWorkerId
const oldWorkerId = 'worker-old-persistent-recovery' as TTYWorkerId
const sessionId = '00000000-0000-4000-8000-000000009401' as TTYSessionId
const executionId = '00000000-0000-4000-8000-000000009402' as TTYExecutionId

function record(overrides: Partial<TTYPersistentExecutionRecord> = {}): TTYPersistentExecutionRecord {
  return {
    version: 1,
    sessionId,
    executionId,
    ownerUserId: 'user-one',
    workerId: oldWorkerId,
    runtimeId: 'runtime-old',
    token: '0123456789abcdef0123456789abcdef',
    state: 'running',
    startedAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:01.000Z',
    pid: 1234,
    cwd: '/runtime/session',
    ...overrides,
  }
}

test('persistent recovery adopts an expired foreign PTY lease and reattaches the original execution', async () => {
  const attached: Array<{ executionId: TTYExecutionId; sessionId: TTYSessionId; ownerUserId: string }> = []
  const service = new TTYPersistentRecoveryService(
    workerId,
    {
      listActiveExecutionRecords: async () => [record()],
      recoverExecution: async (input) => {
        attached.push(input)
        return {
          metadata: {
            handleId: 'handle-recovered',
            executionId: input.executionId,
            sessionId: input.sessionId,
            workerId,
            pid: 1234,
            cwd: '/runtime/session',
            startedAt: '2026-08-11T00:00:00.000Z',
          },
          exit: new Promise(() => undefined),
          onData: () => () => undefined,
          interrupt: async () => undefined,
          forceTerminate: async () => undefined,
          dispose: () => undefined,
        }
      },
    },
    {
      adoptPersistent: async () => ({ adopted: true, job: undefined as never }),
    },
  )

  const result = await service.recoverNow()

  assert.deepEqual(result, { scanned: 1, adopted: 0, attached: 1, skipped: 0, failed: 0 })
  assert.deepEqual(attached, [{ executionId, sessionId, ownerUserId: 'user-one' }])
})

test('persistent recovery skips local, unexpired, and completed records without reattaching', async () => {
  let adoptionCalls = 0
  let attachCalls = 0
  const service = new TTYPersistentRecoveryService(
    workerId,
    {
      listActiveExecutionRecords: async () => [
        record({ workerId }),
        record({ executionId: '00000000-0000-4000-8000-000000009403' as TTYExecutionId }),
        record({ executionId: '00000000-0000-4000-8000-000000009404' as TTYExecutionId, state: 'completed' }),
      ],
      recoverExecution: async () => {
        attachCalls += 1
        return null
      },
    },
    {
      adoptPersistent: async (_executionId) => {
        adoptionCalls += 1
        return _executionId.endsWith('9403')
          ? { adopted: false, reason: 'not_expired' as const }
          : { adopted: true, job: undefined as never }
      },
    },
  )

  const result = await service.recoverNow()

  assert.deepEqual(result, { scanned: 3, adopted: 1, attached: 0, skipped: 2, failed: 0 })
  assert.equal(adoptionCalls, 2)
  assert.equal(attachCalls, 0)
})

test('persistent recovery hands the adopted PTY handle to the coordinator without redispatching', async () => {
  const coordinatorCalls: Array<{ executionId: TTYExecutionId; handle: unknown }> = []
  let attachCalls = 0
  const persistentHandle = {
    metadata: {
      handleId: 'persistent-recovered',
      executionId,
      sessionId,
      workerId,
      pid: 1234,
      cwd: '/runtime/session',
      startedAt: '2026-08-11T00:00:00.000Z',
    },
    exit: new Promise<never>(() => undefined),
    onData: () => () => undefined,
    interrupt: async () => undefined,
    forceTerminate: async () => undefined,
    dispose: () => undefined,
  }
  const processHandle = { handleId: 'process-recovered' }
  const service = new TTYPersistentRecoveryService(
    workerId,
    {
      listActiveExecutionRecords: async () => [record()],
      recoverExecution: async () => persistentHandle,
    },
    {
      adoptPersistent: async () => ({
        adopted: true as const,
        job: {
          executionId,
          sessionId,
          ownerUserId: 'user-one',
          kind: 'diagnostic',
          status: 'leased' as const,
          createdAt: '2026-08-11T00:00:00.000Z',
          admittedAt: '2026-08-11T00:00:00.000Z',
          authorizationScopeId: null,
          argv: ['debug'],
          resource: { maxExecutionDurationMs: 1000, maxOutputBytes: 1000 },
          attempt: 1,
          lease: {
            workerId,
            token: 'new-token',
            leaseId: 'new-lease' as never,
            claimedAtMs: 1,
            renewedAtMs: 1,
            expiresAtMs: 10_000,
            maxExpiresAtMs: 20_000,
          },
        },
      }),
    },
    {
      coordinator: {
        runRecoveredPersistent: async (input) => {
          coordinatorCalls.push({ executionId: input.record.executionId, handle: input.handle })
          return { accepted: true as const, state: undefined as never }
        },
      },
      processRuntime: {
        attachRecovered: async (input) => {
          attachCalls += 1
          assert.equal(input.executionId, executionId)
          assert.equal(input.persistent, persistentHandle)
          return processHandle as never
        },
      },
    },
  )

  const result = await service.recoverNow()

  assert.deepEqual(result, { scanned: 1, adopted: 0, attached: 1, skipped: 0, failed: 0 })
  assert.equal(attachCalls, 1)
  assert.deepEqual(coordinatorCalls, [{ executionId, handle: processHandle }])
})
