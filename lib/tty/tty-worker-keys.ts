/** Central Redis key schema for the trusted TTY worker plane. */

import type { TTYExecutionId, TTYSessionId } from './tty-types'
import type { TTYWorkerId } from './tty-worker-types'

/** Set of all registered worker IDs. */
export function ttyWorkerRegistryKey(): string {
  return 'tty:workers:registry'
}

/** JSON metadata record for one worker. */
export function ttyWorkerMetadataKey(workerId: TTYWorkerId): string {
  return `tty:worker:${workerId}:metadata`
}

/** JSON record containing the most recently accepted heartbeat. */
export function ttyWorkerHeartbeatKey(workerId: TTYWorkerId): string {
  return `tty:worker:${workerId}:heartbeat`
}

/** JSON derived health record for one worker. */
export function ttyWorkerHealthKey(workerId: TTYWorkerId): string {
  return `tty:worker:${workerId}:health`
}

/** Set of execution IDs currently attributed to a worker. */
export function ttyWorkerActiveLeasesKey(workerId: TTYWorkerId): string {
  return `tty:worker:${workerId}:active-leases`
}

/** Global reconciliation index of worker ID and execution ID pairs. */
export function ttyWorkerActiveLeaseIndexKey(): string {
  return 'tty:workers:active-lease-index'
}

/** Append-only Redis Stream containing structured worker-plane events. */
export function ttyWorkerAuditStreamKey(): string {
  return 'tty:workers:audit'
}

/** Existing TTY execution job record key, shared by lease observation. */
export function ttyExecutionJobKey(executionId: TTYExecutionId): string {
  return `tty:job:${executionId}`
}

/** Current immutable execution state record. */
export function ttyExecutionStateKey(executionId: TTYExecutionId): string {
  return `tty:execution:${executionId}:state`
}

/** Append-only execution output and lifecycle stream. */
export function ttyExecutionOutputStreamKey(executionId: TTYExecutionId): string {
  return `tty:execution:${executionId}:output`
}

/** Monotonic per-execution stream sequence. */
export function ttyExecutionOutputSequenceKey(executionId: TTYExecutionId): string {
  return `tty:execution:${executionId}:output-sequence`
}

/** Append-only browser-safe live stream used by the Phase 2.1 broker. */
export function ttyExecutionLiveStreamKey(executionId: TTYExecutionId): string {
  return `tty:execution:${executionId}:live-stream`
}

/** Monotonic sequence for the browser-safe live stream. */
export function ttyExecutionLiveSequenceKey(executionId: TTYExecutionId): string {
  return `tty:execution:${executionId}:live-sequence`
}

/** Worker-internal process metadata for recovery and orphan cleanup. */
export function ttyExecutionRuntimeKey(executionId: TTYExecutionId): string {
  return `tty:execution:${executionId}:runtime`
}

/** Short-lived owner cancellation request consumed by the worker context. */
export function ttyExecutionCancellationKey(executionId: TTYExecutionId): string {
  return `tty:execution:${executionId}:cancellation`
}

/** Set of executions with a non-terminal runtime state. */
export function ttyExecutionActiveIndexKey(): string {
  return 'tty:executions:active'
}

/** Set of execution IDs admitted and waiting for a worker claim. */
export function ttyPendingExecutionIndexKey(): string {
  return 'tty:executions:pending'
}

/** Existing TTY session key helper, shared only for worker-aware reads. */
export function ttySessionKey(sessionId: TTYSessionId, suffix: string): string {
  return `tty:session:${sessionId}:${suffix}`
}

export function ttyWorkerLeaseIndexMember(workerId: TTYWorkerId, executionId: TTYExecutionId): string {
  return `${workerId}|${executionId}`
}
