/**
 * Immutable execution state machine for the live TTY runtime.
 *
 * Only the execution coordinator may persist these records. This module is a
 * pure validator/constructor so illegal transitions can be rejected before a
 * Redis write is attempted.
 */

import type { TTYExecutionId, TTYSessionId } from './tty-types'
import type { TTYLeaseId, TTYWorkerId } from './tty-worker-types'

export const TTY_EXECUTION_STATES = [
  'queued',
  'leased',
  'starting',
  'running',
  'streaming',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'expired',
] as const

export type TTYExecutionState = (typeof TTY_EXECUTION_STATES)[number]
export type TTYTerminalExecutionState = Extract<
  TTYExecutionState,
  'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'expired'
>

export const TTY_EXECUTION_TRANSITIONS: Readonly<Record<TTYExecutionState, readonly TTYExecutionState[]>> = {
  queued: ['queued', 'leased', 'failed', 'cancelled', 'expired'],
  leased: ['leased', 'starting', 'failed', 'cancelled', 'expired'],
  starting: ['starting', 'running', 'failed', 'cancelled', 'timed_out', 'expired'],
  running: ['running', 'streaming', 'succeeded', 'failed', 'cancelled', 'timed_out', 'expired'],
  streaming: ['streaming', 'succeeded', 'failed', 'cancelled', 'timed_out', 'expired'],
  succeeded: ['succeeded'],
  failed: ['failed'],
  cancelled: ['cancelled'],
  timed_out: ['timed_out'],
  expired: ['expired'],
}

const RECOVERABLE_EXECUTION_STATES: readonly TTYExecutionState[] = ['leased', 'starting', 'running', 'streaming']

export interface TTYExecutionStateRecord {
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  readonly state: TTYExecutionState
  readonly queuedAt: string
  readonly updatedAt: string
  readonly leasedAt: string | null
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly workerId: TTYWorkerId | null
  readonly leaseId: TTYLeaseId | null
  readonly exitCode: number | null
  readonly signal: string | null
  readonly failureCode: string | null
  readonly outputBytes: number
  readonly stdoutBytes: number
  readonly stderrBytes: number
  readonly queueWaitMs: number | null
  readonly startupMs: number | null
  readonly durationMs: number | null
  readonly completionReason: string | null
}

export interface TTYExecutionStatePatch {
  readonly workerId?: TTYWorkerId | null
  readonly leaseId?: TTYLeaseId | null
  readonly exitCode?: number | null
  readonly signal?: string | null
  readonly failureCode?: string | null
  readonly outputBytes?: number
  readonly stdoutBytes?: number
  readonly stderrBytes?: number
  readonly completionReason?: string | null
}

export class IllegalTTYExecutionTransitionError extends Error {
  constructor(
    readonly from: TTYExecutionState,
    readonly to: TTYExecutionState,
  ) {
    super(`Illegal TTY execution transition: ${from} -> ${to}.`)
    this.name = 'IllegalTTYExecutionTransitionError'
  }
}

export function isTTYExecutionState(value: string): value is TTYExecutionState {
  return (TTY_EXECUTION_STATES as readonly string[]).includes(value)
}

export function isTerminalTTYExecutionState(state: TTYExecutionState): state is TTYTerminalExecutionState {
  return (
    state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'timed_out' || state === 'expired'
  )
}

export function canTransitionTTYExecutionState(from: TTYExecutionState, to: TTYExecutionState): boolean {
  return TTY_EXECUTION_TRANSITIONS[from].includes(to)
}

export function canRecoverTTYExecutionState(from: TTYExecutionState, to: TTYExecutionState): boolean {
  return to === 'queued' && RECOVERABLE_EXECUTION_STATES.includes(from)
}

export function createQueuedTTYExecutionState(
  executionId: TTYExecutionId,
  sessionId: TTYSessionId,
  queuedAt: string,
): TTYExecutionStateRecord {
  return Object.freeze({
    executionId,
    sessionId,
    state: 'queued' as const,
    queuedAt,
    updatedAt: queuedAt,
    leasedAt: null,
    startedAt: null,
    finishedAt: null,
    workerId: null,
    leaseId: null,
    exitCode: null,
    signal: null,
    failureCode: null,
    outputBytes: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    queueWaitMs: null,
    startupMs: null,
    durationMs: null,
    completionReason: null,
  })
}

export function transitionTTYExecutionState(
  current: TTYExecutionStateRecord,
  next: TTYExecutionState,
  at: string,
  patch: TTYExecutionStatePatch = {},
): TTYExecutionStateRecord {
  if (!canTransitionTTYExecutionState(current.state, next))
    throw new IllegalTTYExecutionTransitionError(current.state, next)
  const queuedAtMs = Date.parse(current.queuedAt)
  const leasedAt = next === 'leased' && current.leasedAt === null ? at : current.leasedAt
  const startedAt = next === 'running' && current.startedAt === null ? at : current.startedAt
  const finishedAt = isTerminalTTYExecutionState(next) && current.finishedAt === null ? at : current.finishedAt
  const startedAtMs = startedAt === null ? Number.NaN : Date.parse(startedAt)
  const leasedAtMs = leasedAt === null ? Number.NaN : Date.parse(leasedAt)
  const durationMs =
    finishedAt !== null && startedAt !== null ? Math.max(0, Date.parse(finishedAt) - startedAtMs) : current.durationMs
  const queueWaitMs =
    leasedAt !== null && Number.isFinite(queuedAtMs) && Number.isFinite(leasedAtMs)
      ? Math.max(0, leasedAtMs - queuedAtMs)
      : current.queueWaitMs
  const startupMs =
    next === 'running' && startedAt !== null && leasedAt !== null
      ? Math.max(0, startedAtMs - leasedAtMs)
      : current.startupMs
  return Object.freeze({
    ...current,
    ...patch,
    state: next,
    updatedAt: at,
    leasedAt,
    startedAt,
    finishedAt,
    queueWaitMs,
    startupMs,
    durationMs,
  })
}

export function recoverTTYExecutionState(
  current: TTYExecutionStateRecord,
  at: string,
  patch: TTYExecutionStatePatch = {},
): TTYExecutionStateRecord {
  if (!canRecoverTTYExecutionState(current.state, 'queued'))
    throw new IllegalTTYExecutionTransitionError(current.state, 'queued')
  return Object.freeze({
    ...current,
    ...patch,
    state: 'queued' as const,
    updatedAt: at,
    leasedAt: null,
    workerId: null,
    leaseId: null,
    finishedAt: null,
  })
}
