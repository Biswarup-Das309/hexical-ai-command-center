import test from 'node:test'
import assert from 'node:assert/strict'

import { TTYResourceGuard } from '../../lib/tty/tty-resource-guard'
import type { TTYExecutionId } from '../../lib/tty/tty-types'

const executionOne = '00000000-0000-4000-8000-000000000301' as TTYExecutionId
const executionTwo = '00000000-0000-4000-8000-000000000302' as TTYExecutionId

function guard() {
  return new TTYResourceGuard({
    maxConcurrentProcesses: 1,
    maxStdoutBytesPerSecond: 10,
    maxStderrBytesPerSecond: 6
  })
}

function limits(maxOutputBytesPerExecution = 20) {
  return { maxExecutionDurationMs: 100, maxOutputBytesPerExecution }
}

test('guard enforces concurrent reservations and releases idempotently', () => {
  const resources = guard()
  const first = resources.reserve(executionOne, limits())
  assert.equal(first.allowed, true)
  assert.equal(resources.activeCount, 1)

  const denied = resources.reserve(executionTwo, limits())
  assert.deepEqual(denied, { allowed: false, reason: 'max_concurrent_processes' })

  if (first.allowed) {
    first.reservation.release()
    first.reservation.release()
  }
  assert.equal(resources.activeCount, 0)
  assert.equal(resources.reserve(executionTwo, limits()).allowed, true)
})

test('guard enforces per-stream rates and resets each one-second window', () => {
  const resources = guard()
  const result = resources.reserve(executionOne, limits())
  assert.equal(result.allowed, true)
  if (!result.allowed) return

  assert.equal(result.reservation.recordOutput('stdout', 7, 1_000).allowed, true)
  assert.equal(result.reservation.recordOutput('stdout', 4, 1_100).reason, 'stdout_rate_exceeded')
  assert.equal(result.reservation.recordOutput('stderr', 6, 1_100).allowed, true)
  assert.equal(result.reservation.recordOutput('stderr', 1, 1_101).reason, 'stderr_rate_exceeded')
  assert.equal(result.reservation.recordOutput('stdout', 4, 2_000).allowed, true)
  result.reservation.release()
})

test('guard truncates the accepted output at the execution ceiling and reports the terminal reason', () => {
  const resources = guard()
  const result = resources.reserve(executionOne, limits(5))
  assert.equal(result.allowed, true)
  if (!result.allowed) return

  const accounting = result.reservation.recordOutput('stdout', 8, 1_000)
  assert.equal(accounting.allowed, false)
  assert.equal(accounting.reason, 'output_limit_exceeded')
  assert.equal(accounting.acceptedBytes, 5)
  assert.equal(accounting.totalBytes, 5)
  assert.equal(accounting.stdoutBytes, 5)
  result.reservation.release()
})

test('guard timeout fires once and releasing before the deadline cancels it', async () => {
  const resources = guard()
  const first = resources.reserve(executionOne, { maxExecutionDurationMs: 20, maxOutputBytesPerExecution: 20 })
  assert.equal(first.allowed, true)
  if (!first.allowed) return

  let fired = 0
  first.reservation.armTimeout(() => { fired += 1 })
  await new Promise(resolve => setTimeout(resolve, 45))
  assert.equal(fired, 1)
  first.reservation.release()

  const second = resources.reserve(executionTwo, { maxExecutionDurationMs: 40, maxOutputBytesPerExecution: 20 })
  assert.equal(second.allowed, true)
  if (!second.allowed) return
  second.reservation.armTimeout(() => { fired += 1 })
  second.reservation.release()
  await new Promise(resolve => setTimeout(resolve, 55))
  assert.equal(fired, 1)
})

