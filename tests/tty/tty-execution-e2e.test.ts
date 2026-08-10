import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import test from 'node:test'
import { WorkerRedisMock } from './worker-redis-mock'
import { TTYExecutionCoordinator, type TTYExecutionLeaseOperations } from '../../lib/tty/tty-execution-coordinator'
import type { TTYLeasedJob } from '../../lib/tty/tty-execution-lease'
import { TTYOutputStreamManager } from '../../lib/tty/tty-output-stream'
import { TTYProcessRuntime } from '../../lib/tty/tty-process-runtime'
import { TTYResourceGuard } from '../../lib/tty/tty-resource-guard'
import type { TTYExecutionId, TTYSessionId, InternalTTYSession } from '../../lib/tty/tty-types'
import type { TTYWorkerId } from '../../lib/tty/tty-worker-types'

const workerId = 'worker-e2e-test' as TTYWorkerId
const sessionId = '00000000-0000-4000-8000-000000000701' as TTYSessionId
const executionId = '00000000-0000-4000-8000-000000000702' as TTYExecutionId

const session: InternalTTYSession = {
  sessionId,
  ownerUserId: 'e2e-owner',
  tier: 'pro',
  status: 'active',
  createdAt: new Date().toISOString(),
  lastActiveAt: new Date().toISOString(),
  limits: {
    maxConcurrentSessions: 1,
    maxConcurrentExecutionsPerSession: 1,
    maxExecutionsPerMinute: 10,
    maxExecutionDurationMs: 5_000,
    maxSessionIdleMs: 900_000,
    maxSessionDurationMs: 3_600_000,
    maxOutputBytesPerExecution: 64_000,
    maxQueueDepth: 10,
  },
  usage: {
    activeSessions: 1,
    activeExecutionsInSession: 0,
    executionsInLastMinute: 0,
    queueDepth: 0,
    capturedAt: new Date().toISOString(),
  },
}

test('real coordinator and process runtime execute an argv command with isolated output streams', async () => {
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const redis = new WorkerRedisMock()
    const rootDir = join(process.cwd(), `.tmp-tty-e2e-${process.pid}-${iteration}`)
    const runtime = new TTYProcessRuntime({ rootDir })
    const file = process.execPath
    const command = basename(file)
      .toLowerCase()
      .replace(/\.exe$/, '')
    const argv = [file, '-e', "process.stdout.write('e2e-out'); process.stderr.write('e2e-err')"]
    const job: TTYLeasedJob = {
      executionId,
      sessionId,
      ownerUserId: session.ownerUserId,
      kind: 'diagnostic',
      status: 'leased',
      createdAt: session.createdAt,
      admittedAt: session.createdAt,
      authorizationScopeId: null,
      argv,
      resource: {
        maxExecutionDurationMs: session.limits.maxExecutionDurationMs,
        maxOutputBytes: session.limits.maxOutputBytesPerExecution,
      },
      attempt: 1,
      lease: {
        workerId,
        token: 'e2e-secret-token',
        leaseId: 'e2e-safe-lease' as never,
        claimedAtMs: Date.now(),
        renewedAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        maxExpiresAtMs: Date.now() + 300_000,
      },
    }
    const leases: TTYExecutionLeaseOperations = {
      claim: async () => ({ claimed: true, job }),
      renew: async () => ({ renewed: true, job }),
      complete: async () => ({ completed: true, job }),
      recover: async () => ({ recovered: true, job: { ...job, status: 'queued' } as never }),
    }
    const coordinator = new TTYExecutionCoordinator({
      redis: redis as never,
      workerId,
      sessionStore: {
        getSession: async () => session,
        recordExecutionStarted: async () => undefined,
        recordExecutionFinished: async () => undefined,
      },
      leaseManager: leases,
      processRuntime: runtime,
      resourceGuard: new TTYResourceGuard({
        maxConcurrentProcesses: 1,
        maxStdoutBytesPerSecond: 64_000,
        maxStderrBytesPerSecond: 64_000,
      }),
      outputStream: new TTYOutputStreamManager(redis as never),
      commandAllowlist: { diagnostic: [command] },
      leaseRenewIntervalMs: 1_000,
    })

    try {
      const result = await coordinator.run(executionId, sessionId)
      assert.equal(result.accepted, true)
      if (!result.accepted) return
      assert.equal(result.state.state, 'succeeded')
      assert.equal(result.state.stdoutBytes, 7)
      assert.equal(result.state.stderrBytes, 7)
      const output = await new TTYOutputStreamManager(redis as never).read(executionId)
      assert.equal(
        output.some((event) => event.type === 'stdout' && event.data.text === 'e2e-out'),
        true,
      )
      assert.equal(
        output.some((event) => event.type === 'stderr' && event.data.text === 'e2e-err'),
        true,
      )
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  }
})
