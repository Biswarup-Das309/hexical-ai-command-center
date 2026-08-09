/**
 * Single owner of live execution orchestration and persisted execution state.
 *
 * Admission decides whether a job may exist. The lease manager decides which
 * authenticated worker owns it. This coordinator is the only layer that may
 * advance the runtime state, attach process streams, enforce runtime limits,
 * and finalize the lease.
 */

import type { Redis } from '@upstash/redis'

import { log, withSpan } from '@/lib/hexical/telemetry'

import {
  TTY_EXECUTION_STATES,
  canTransitionTTYExecutionState,
  createQueuedTTYExecutionState,
  isTerminalTTYExecutionState,
  transitionTTYExecutionState,
  type TTYExecutionStatePatch,
  type TTYExecutionStateRecord,
  type TTYTerminalExecutionState
} from './tty-execution-state'
import {
  DIAGNOSTIC_KEYWORDS,
  FUZZ_PROBE_KEYWORDS,
  NETWORK_PROBE_KEYWORDS,
  RECON_PROBE_KEYWORDS,
  SESSION_UTILITY_KEYWORDS,
  isTargetGatedExecutionKind
} from './tty-policy'
import type { TTYExecutionId, TTYExecutionKind, TTYSessionId } from './tty-types'
import { TTYSessionStore } from './tty-session-store'
import { TTYExecutionLeaseManager, type TTYLeasedJob, type TTYLeaseRenewResult } from './tty-execution-lease'
import { TTYOutputStreamManager } from './tty-output-stream'
import { TTYProcessRuntime, type TTYProcessHandle } from './tty-process-runtime'
import { TTYResourceGuard, type TTYResourceReservation } from './tty-resource-guard'
import { ttyExecutionActiveIndexKey, ttyExecutionRuntimeKey, ttyExecutionStateKey } from './tty-worker-keys'
import { appendTTYWorkerAuditEvent, type TTYWorkerAuditSink } from './tty-worker-audit'
import type { TTYWorkerId } from './tty-worker-types'

const STATE_TTL_SECONDS = 24 * 60 * 60
const MAX_STREAM_CHUNK_BYTES = 48 * 1024
const DEFAULT_LEASE_RENEW_INTERVAL_MS = 15_000
const DEFAULT_STOP_GRACE_MS = 1_000
const DEFAULT_CONTEXT_WAIT_TIMEOUT_MS = 30_000

const STATE_TRANSITION_SCRIPT = `
-- tty-execution-state-transition
local raw = redis.call('GET', KEYS[1])
if ARGV[1] == '__missing__' then
  if raw then return {0, raw} end
  redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[6])
  return {1, ARGV[3]}
end
if not raw then return {0, 'missing'} end
local current = cjson.decode(raw)
if current.state ~= ARGV[1] then return {0, raw} end
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[6])
if ARGV[4] == '1' then redis.call('SADD', KEYS[2], ARGV[5]) else redis.call('SREM', KEYS[2], ARGV[5]) end
return {1, ARGV[3]}
`

const DEFAULT_COMMANDS: Readonly<Record<TTYExecutionKind, readonly string[]>> = {
  session_utility: SESSION_UTILITY_KEYWORDS,
  recon_probe: RECON_PROBE_KEYWORDS,
  fuzz_probe: FUZZ_PROBE_KEYWORDS,
  network_probe: NETWORK_PROBE_KEYWORDS,
  diagnostic: DIAGNOSTIC_KEYWORDS,
  unsupported: []
}

export interface TTYExecutionLeaseOperations {
  claim(executionId: TTYExecutionId, sessionId: TTYSessionId): ReturnType<TTYExecutionLeaseManager['claim']>
  renew(executionId: TTYExecutionId, sessionId: TTYSessionId, leaseToken: string): ReturnType<TTYExecutionLeaseManager['renew']>
  complete(executionId: TTYExecutionId, sessionId: TTYSessionId, leaseToken: string, terminalState: TTYTerminalExecutionState): ReturnType<TTYExecutionLeaseManager['complete']>
  recover(executionId: TTYExecutionId, sessionId: TTYSessionId): ReturnType<TTYExecutionLeaseManager['recover']>
}

/** Trusted per-run signals used by the worker executor for metrics only. */
export interface TTYExecutionCoordinatorRunHooks {
  readonly onLeaseRenewed?: (executionId: TTYExecutionId, sessionId: TTYSessionId) => void
  readonly onLeaseLost?: (executionId: TTYExecutionId, sessionId: TTYSessionId, reason: string) => void
}

/**
 * Optional lifecycle notification for callers that need to return as soon as
 * the coordinator has accepted a run, while the process continues streaming.
 * It does not alter execution state or ownership; the coordinator remains the
 * sole authority for both.
 */
export interface TTYExecutionCoordinatorRunOptions {
  readonly onAccepted?: (state: TTYExecutionStateRecord) => void
}

export interface TTYExecutionCoordinatorDependencies {
  readonly redis: Redis
  readonly workerId: TTYWorkerId
  readonly sessionStore: Pick<TTYSessionStore, 'getSession' | 'recordExecutionStarted' | 'recordExecutionFinished'>
  readonly leaseManager: TTYExecutionLeaseOperations
  readonly processRuntime: Pick<TTYProcessRuntime, 'start' | 'stop' | 'kill' | 'cleanup' | 'getMetadata'>
  readonly resourceGuard: TTYResourceGuard
  readonly outputStream: TTYOutputStreamManager
  readonly audit?: TTYWorkerAuditSink
  readonly now?: () => Date
  readonly leaseRenewIntervalMs?: number
  readonly stopGraceMs?: number
  readonly commandAllowlist?: Partial<Readonly<Record<TTYExecutionKind, readonly string[]>>>
}

export type TTYExecutionCoordinatorFailureReason =
  | 'missing_job'
  | 'not_queued'
  | 'session_terminated'
  | 'attempts_exhausted'
  | 'unauthorized_worker'
  | 'already_running'
  | 'invalid_job'
  | 'resource_denied'
  | 'internal_error'

export type TTYExecutionRunResult =
  | { readonly accepted: true; readonly state: TTYExecutionStateRecord }
  | { readonly accepted: false; readonly reason: TTYExecutionCoordinatorFailureReason; readonly state: TTYExecutionStateRecord | null }

export type TTYExecutionCancellationReason = 'user_cancellation' | 'worker_cancellation' | 'system_timeout'

export interface TTYExecutionCancellationResult {
  readonly acknowledged: boolean
  readonly state: TTYExecutionStateRecord | null
}

interface ExecutionContext {
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  stateTail: Promise<void>
  leaseToken: string | null
  handle: TTYProcessHandle | null
  reservation: TTYResourceReservation | null
  startedRecorded: boolean
  cancelReason: TTYExecutionCancellationReason | 'resource_limit' | 'lease_expired' | null
  failureCode: string | null
  leaseLost: boolean
  outputFailed: boolean
  renewTimer: ReturnType<typeof setInterval> | undefined
  killTimer: ReturnType<typeof setTimeout> | undefined
  stopPromise: Promise<void> | null
  streaming: boolean
  outputBytes: number
  stdoutBytes: number
  stderrBytes: number
  readonly hooks: TTYExecutionCoordinatorRunHooks
}

function commandName(file: string): string {
  const normalized = file.replaceAll('\\', '/')
  const name = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  return name.endsWith('.exe') ? name.slice(0, -4) : name
}

function isExecutionStateActive(state: string): boolean {
  return state === 'starting' || state === 'running' || state === 'streaming'
}

function parseState(value: unknown): TTYExecutionStateRecord | null {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (typeof record.executionId !== 'string' || typeof record.sessionId !== 'string' || typeof record.state !== 'string' || !TTY_EXECUTION_STATES.includes(record.state as TTYExecutionStateRecord['state'])) return null
    if (typeof record.queuedAt !== 'string' || typeof record.updatedAt !== 'string') return null
    return Object.freeze(record as unknown as TTYExecutionStateRecord)
  } catch {
    return null
  }
}

function parseScriptResult(value: unknown): { readonly ok: boolean; readonly value: string } {
  if (!Array.isArray(value) || value.length < 2) return { ok: false, value: 'internal_error' }
  return { ok: Number(value[0]) === 1, value: typeof value[1] === 'string' ? value[1] : 'internal_error' }
}

function safeRecordPatch(patch: TTYExecutionStatePatch): TTYExecutionStatePatch {
  const result: TTYExecutionStatePatch = {
    ...(patch.workerId !== undefined ? { workerId: patch.workerId } : {}),
    ...(patch.leaseId !== undefined ? { leaseId: patch.leaseId } : {}),
    ...(patch.exitCode !== undefined ? { exitCode: patch.exitCode } : {}),
    ...(patch.signal !== undefined ? { signal: patch.signal } : {}),
    ...(patch.failureCode !== undefined ? { failureCode: patch.failureCode } : {}),
    ...(patch.outputBytes !== undefined ? { outputBytes: Math.max(0, Math.floor(patch.outputBytes)) } : {}),
    ...(patch.stdoutBytes !== undefined ? { stdoutBytes: Math.max(0, Math.floor(patch.stdoutBytes)) } : {}),
    ...(patch.stderrBytes !== undefined ? { stderrBytes: Math.max(0, Math.floor(patch.stderrBytes)) } : {}),
    ...(patch.completionReason !== undefined ? { completionReason: patch.completionReason } : {})
  }
  return result
}

export class TTYExecutionCoordinator {
  private readonly contexts = new Map<TTYExecutionId, ExecutionContext>()
  private readonly now: () => Date
  private readonly leaseRenewIntervalMs: number
  private readonly stopGraceMs: number
  private readonly commandAllowlist: Readonly<Record<TTYExecutionKind, readonly string[]>>

  constructor(private readonly dependencies: TTYExecutionCoordinatorDependencies) {
    this.now = dependencies.now ?? (() => new Date())
    this.leaseRenewIntervalMs = Math.max(100, Math.floor(dependencies.leaseRenewIntervalMs ?? DEFAULT_LEASE_RENEW_INTERVAL_MS))
    this.stopGraceMs = Math.max(50, Math.floor(dependencies.stopGraceMs ?? DEFAULT_STOP_GRACE_MS))
    this.commandAllowlist = Object.freeze({ ...DEFAULT_COMMANDS, ...(dependencies.commandAllowlist ?? {}) })
  }

  async getState(executionId: TTYExecutionId): Promise<TTYExecutionStateRecord | null> {
    try {
      return parseState(await this.dependencies.redis.get<unknown>(ttyExecutionStateKey(executionId)))
    } catch {
      return null
    }
  }

  async run(executionId: TTYExecutionId, sessionId: TTYSessionId, options: TTYExecutionCoordinatorRunOptions = {}): Promise<TTYExecutionRunResult> {
    const existing = await this.getState(executionId)
    if (existing && isTerminalTTYExecutionState(existing.state)) return { accepted: true, state: existing }
    if (this.contexts.has(executionId)) return { accepted: false, reason: 'already_running', state: existing }

    const context = this.createContext(executionId, sessionId)
    this.contexts.set(executionId, context)
    try {
      return await withSpan('tty.execution.run', { executionId, sessionId, workerId: this.dependencies.workerId }, async () => this.execute(context, undefined, options))
    } finally {
      this.clearContext(context)
    }
  }

  /**
   * Executes a lease already claimed by TTYWorkerClaimService. The existing
   * run() path remains the coordinator-owned claim-and-run contract; this
   * additive handoff prevents a worker loop from claiming the same job twice.
   */
  async runClaimed(job: TTYLeasedJob, hooks: TTYExecutionCoordinatorRunHooks = {}): Promise<TTYExecutionRunResult> {
    const existing = await this.getState(job.executionId)
    if (existing && isTerminalTTYExecutionState(existing.state)) return { accepted: true, state: existing }
    if (this.contexts.has(job.executionId)) return { accepted: false, reason: 'already_running', state: existing }
    if (job.status !== 'leased' || job.sessionId.length === 0 || job.lease.workerId !== this.dependencies.workerId) {
      return { accepted: false, reason: 'unauthorized_worker', state: existing }
    }

    const context = this.createContext(job.executionId, job.sessionId, hooks)
    this.contexts.set(job.executionId, context)
    try {
      return await withSpan('tty.execution.run_claimed', { executionId: job.executionId, sessionId: job.sessionId, workerId: this.dependencies.workerId }, async () => this.execute(context, job))
    } finally {
      this.clearContext(context)
    }
  }

  async cancelExecution(executionId: TTYExecutionId, reason: TTYExecutionCancellationReason = 'user_cancellation'): Promise<TTYExecutionCancellationResult> {
    const context = this.contexts.get(executionId)
    if (context) {
      context.cancelReason = reason
      await this.requestStop(context)
      const result = await this.waitForContext(context)
      return { acknowledged: result.accepted && isTerminalTTYExecutionState(result.state.state), state: result.state }
    }

    const state = await this.getState(executionId)
    if (state === null || isTerminalTTYExecutionState(state.state)) return { acknowledged: state !== null, state }
    if (state.state === 'queued') {
      const cancelled = await this.transitionWithoutContext(state, 'cancelled', { completionReason: reason })
      await this.safeAppendCompletion(cancelled)
      return { acknowledged: true, state: cancelled }
    }

    // A worker-local context is required to possess the secret lease token and
    // process handle. Without it, the safe recovery state is expired; a
    // reaper can then clean the persisted runtime metadata and recover the job.
    const expired = await this.transitionWithoutContext(state, 'expired', { failureCode: 'WORKER_CONTEXT_MISSING', completionReason: 'worker_context_missing' })
    await this.safeAppendCompletion(expired)
    return { acknowledged: true, state: expired }
  }

  /**
   * Reconciles a worker crash after the recovery worker has removed any
   * orphaned process tree. The lease manager decides whether the Redis lease
   * is expired and requeues the job; this method then resets only the
   * coordinator-owned state record to queued for a fresh claim.
   */
  async recoverExecution(executionId: TTYExecutionId, sessionId: TTYSessionId): Promise<TTYExecutionStateRecord | null> {
    const current = await this.getState(executionId)
    if (!current || current.sessionId !== sessionId) return null
    if (isTerminalTTYExecutionState(current.state) && current.state !== 'expired') return current
    const recovery = await this.dependencies.leaseManager.recover(executionId, sessionId)
    if (!recovery.recovered) {
      if (recovery.reason === 'not_expired') return current
      if (!isTerminalTTYExecutionState(current.state)) {
        const expired = await this.transitionWithoutContext(current, 'expired', { failureCode: `RECOVERY_${recovery.reason.toUpperCase()}`, completionReason: 'worker_recovery_failed' })
        await this.safeAppendState(expired)
        await this.safeAppendCompletion(expired)
        return expired
      }
      return current
    }
    if (!canTransitionTTYExecutionState(current.state, 'queued')) return current
    const queued = await this.transitionWithoutContext(current, 'queued', {
      workerId: null,
      leaseId: null,
      failureCode: null,
      completionReason: 'worker_crash_recovered'
    })
    await this.safeAppendState(queued)
    if (this.dependencies.audit) {
      try {
        await appendTTYWorkerAuditEvent(this.dependencies.audit, {
          eventType: 'execution_recovered',
          timestamp: queued.updatedAt,
          workerId: this.dependencies.workerId,
          sessionId,
          executionId,
          leaseId: null,
          metadata: { state: queued.state, completionReason: queued.completionReason }
        })
      } catch {
        // Recovery remains safe if audit persistence is temporarily unavailable.
      }
    }
    try {
      await this.dependencies.redis.del(ttyExecutionRuntimeKey(executionId))
    } catch {
      // The recovery scan can retry this cleanup.
    }
    return queued
  }

  private createContext(executionId: TTYExecutionId, sessionId: TTYSessionId, hooks: TTYExecutionCoordinatorRunHooks = {}): ExecutionContext {
    return {
      executionId,
      sessionId,
      stateTail: Promise.resolve(),
      leaseToken: null,
      handle: null,
      reservation: null,
      startedRecorded: false,
      cancelReason: null,
      failureCode: null,
      leaseLost: false,
      outputFailed: false,
      renewTimer: undefined,
      killTimer: undefined,
      stopPromise: null,
      streaming: false,
      outputBytes: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      hooks
    }
  }

  private async execute(context: ExecutionContext, preclaimedJob?: TTYLeasedJob, options: TTYExecutionCoordinatorRunOptions = {}): Promise<TTYExecutionRunResult> {
    let state = await this.ensureQueued(context)
    if (state === null) return { accepted: false, reason: 'internal_error', state: null }
    if (context.cancelReason) {
      state = await this.finalize(context, 'cancelled', { completionReason: context.cancelReason })
      return { accepted: true, state }
    }

    const claimed = preclaimedJob
      ? { claimed: true as const, job: preclaimedJob }
      : await this.dependencies.leaseManager.claim(context.executionId, context.sessionId)
    if (!claimed.claimed) return { accepted: false, reason: claimed.reason === 'internal_error' ? 'internal_error' : claimed.reason, state: await this.getState(context.executionId) }
    if (claimed.job.executionId !== context.executionId || claimed.job.sessionId !== context.sessionId || claimed.job.lease.workerId !== this.dependencies.workerId) {
      return { accepted: false, reason: 'unauthorized_worker', state }
    }

    context.leaseToken = claimed.job.lease.token
    state = await this.transition(context, 'leased', { workerId: this.dependencies.workerId, leaseId: claimed.job.lease.leaseId ?? claimed.job.lease.token })
    await this.safeAppendState(state)
    try {
      options.onAccepted?.(state)
    } catch {
      // Acceptance observers are transport coordination only and must never
      // change execution ownership or state.
    }
    if (context.cancelReason) {
      state = await this.finalize(context, 'cancelled', { completionReason: context.cancelReason })
      return { accepted: true, state }
    }

    const session = await this.dependencies.sessionStore.getSession(claimed.job.sessionId, claimed.job.ownerUserId)
    if (session === null || (session.status !== 'active' && session.status !== 'idle')) {
      state = await this.finalize(context, 'expired', { failureCode: 'SESSION_TERMINATED', completionReason: 'session_terminated' })
      return { accepted: true, state }
    }

    const argv = claimed.job.argv
    if (!this.validJob(claimed.job, argv)) {
      state = await this.finalize(context, 'failed', { failureCode: 'INVALID_ADMITTED_JOB', completionReason: 'invalid_admitted_job' })
      return { accepted: true, state }
    }

    const reservationResult = this.dependencies.resourceGuard.reserve(context.executionId, {
      maxExecutionDurationMs: claimed.job.resource.maxExecutionDurationMs,
      maxOutputBytesPerExecution: claimed.job.resource.maxOutputBytes
    })
    if (!reservationResult.allowed) {
      state = await this.finalize(context, 'failed', { failureCode: reservationResult.reason.toUpperCase(), completionReason: 'resource_denied' })
      return { accepted: true, state }
    }
    context.reservation = reservationResult.reservation

    state = await this.transition(context, 'starting')
    await this.safeAppendState(state)
    if (context.cancelReason) {
      state = await this.finalize(context, 'cancelled', { completionReason: context.cancelReason })
      return { accepted: true, state }
    }

    try {
      context.handle = await this.dependencies.processRuntime.start({
        executionId: context.executionId,
        sessionId: context.sessionId,
        workerId: this.dependencies.workerId,
        file: argv[0],
        args: argv.slice(1),
        env: {}
      })
      const metadata = this.dependencies.processRuntime.getMetadata(context.handle)
      await this.persistRuntimeMetadata(metadata)
      state = await this.transition(context, 'running')
      await this.safeAppendState(state)
      await this.dependencies.sessionStore.recordExecutionStarted(context.sessionId, context.executionId)
      context.startedRecorded = true
      context.reservation.armTimeout(() => {
        context.cancelReason = 'system_timeout'
        context.failureCode = 'EXECUTION_TIMEOUT'
        void this.requestStop(context)
      })
      this.startLeaseRenewal(context)

      const stdoutPump = this.pumpOutput(context, 'stdout', context.handle.stdout)
      const stderrPump = this.pumpOutput(context, 'stderr', context.handle.stderr)
      const exit = await context.handle.exit
      await Promise.all([stdoutPump, stderrPump])
      const terminal = this.terminalForExit(context, exit)
      const patch: TTYExecutionStatePatch = {
        exitCode: exit.code,
        signal: exit.signal,
        failureCode: context.failureCode ?? (exit.error ? 'PROCESS_SPAWN_FAILED' : terminal === 'failed' ? 'PROCESS_EXIT_NONZERO' : null),
        outputBytes: context.outputBytes,
        stdoutBytes: context.stdoutBytes,
        stderrBytes: context.stderrBytes,
        completionReason: this.completionReasonFor(terminal, context)
      }
      state = await this.finalize(context, terminal, patch)
      return { accepted: true, state }
    } catch (error) {
      context.failureCode = 'RUNTIME_INTERNAL_ERROR'
      log.error('tty.execution.runtime_failure', { executionId: context.executionId, sessionId: context.sessionId, workerId: this.dependencies.workerId, error: error instanceof Error ? error.message : String(error) })
      state = await this.finalize(context, 'failed', { failureCode: context.failureCode, completionReason: 'runtime_internal_error' })
      return { accepted: true, state }
    }
  }

  private validJob(job: TTYLeasedJob, argv: readonly string[] | undefined): argv is readonly [string, ...string[]] {
    if (!argv || argv.length === 0 || job.kind === 'unsupported') return false
    if (isTargetGatedExecutionKind(job.kind) && !job.authorizationScopeId) return false
    const command = commandName(argv[0])
    return this.commandAllowlist[job.kind].some(candidate => command === candidate.toLowerCase())
  }

  private terminalForExit(context: ExecutionContext, exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly error?: string }): TTYTerminalExecutionState {
    if (context.leaseLost || context.cancelReason === 'lease_expired') return 'expired'
    if (context.cancelReason === 'system_timeout') return 'timed_out'
    if (context.failureCode === 'OUTPUT_LIMIT_EXCEEDED' || context.failureCode === 'STDOUT_RATE_EXCEEDED' || context.failureCode === 'STDERR_RATE_EXCEEDED' || context.failureCode === 'OUTPUT_STREAM_FAILURE') return 'failed'
    if (context.cancelReason === 'user_cancellation' || context.cancelReason === 'worker_cancellation') return 'cancelled'
    return exit.error || (exit.code !== 0 && exit.code !== null) ? 'failed' : 'succeeded'
  }

  private completionReasonFor(state: TTYTerminalExecutionState, context: ExecutionContext): string {
    if (context.failureCode) return context.failureCode
    if (state === 'succeeded') return 'process_exit'
    if (state === 'cancelled') return context.cancelReason ?? 'cancelled'
    if (state === 'timed_out') return 'execution_timeout'
    if (state === 'expired') return 'lease_expired'
    return 'process_exit_nonzero'
  }

  private async finalize(context: ExecutionContext, requestedState: TTYTerminalExecutionState, patch: TTYExecutionStatePatch): Promise<TTYExecutionStateRecord> {
    let finalState = requestedState
    let finalPatch = safeRecordPatch(patch)
    if (requestedState !== 'expired' && context.leaseToken !== null) {
      const completion = await this.dependencies.leaseManager.complete(context.executionId, context.sessionId, context.leaseToken, requestedState)
      if (!completion.completed) {
        finalState = 'expired'
        finalPatch = { ...finalPatch, failureCode: `LEASE_COMPLETION_${completion.reason.toUpperCase()}`, completionReason: 'lease_finalization_failed' }
      }
    }

    const state = await this.transition(context, finalState, finalPatch)
    await this.safeAppendState(state)
    await this.safeAppendCompletion(state)
    await this.safeAuditForState(state, context)
    this.stopRenewal(context)
    if (context.killTimer) clearTimeout(context.killTimer)
    if (context.reservation) context.reservation.release()
    if (context.startedRecorded) {
      try {
        await this.dependencies.sessionStore.recordExecutionFinished(context.sessionId)
      } catch (error) {
        log.warn('tty.execution.accounting_finish_failed', { executionId: context.executionId, sessionId: context.sessionId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    if (context.handle) {
      try {
        await this.dependencies.processRuntime.cleanup(context.handle)
      } catch (error) {
        log.warn('tty.execution.process_cleanup_failed', { executionId: context.executionId, sessionId: context.sessionId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    try {
      await this.dependencies.redis.del(ttyExecutionRuntimeKey(context.executionId))
    } catch {
      // Recovery can retry runtime-key cleanup.
    }
    return state
  }

  private async ensureQueued(context: ExecutionContext): Promise<TTYExecutionStateRecord | null> {
    const existing = await this.getState(context.executionId)
    if (existing) return existing
    const initial = createQueuedTTYExecutionState(context.executionId, context.sessionId, this.now().toISOString())
    return this.casState(context.executionId, '__missing__', initial)
  }

  private async transition(context: ExecutionContext, next: TTYExecutionStateRecord['state'], patch: TTYExecutionStatePatch = {}): Promise<TTYExecutionStateRecord> {
    const operation = context.stateTail.then(async () => {
      const current = await this.getState(context.executionId)
      if (!current) throw new Error('Execution state is missing.')
      if (current.state === next || canTransitionTTYExecutionState(current.state, next)) {
        const candidate = transitionTTYExecutionState(current, next, this.now().toISOString(), safeRecordPatch(patch))
        const stored = await this.casState(context.executionId, current.state, candidate)
        if (!stored) throw new Error('Execution state transition conflicted.')
        return stored
      }
      if (isTerminalTTYExecutionState(current.state)) return current
      throw new Error(`Illegal execution state transition ${current.state} -> ${next}.`)
    })
    context.stateTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async transitionWithoutContext(current: TTYExecutionStateRecord, next: TTYExecutionStateRecord['state'], patch: TTYExecutionStatePatch): Promise<TTYExecutionStateRecord> {
    if (current.state === next || isTerminalTTYExecutionState(current.state)) return current
    if (!canTransitionTTYExecutionState(current.state, next)) return current
    const candidate = transitionTTYExecutionState(current, next, this.now().toISOString(), safeRecordPatch(patch))
    return (await this.casState(current.executionId, current.state, candidate)) ?? current
  }

  private async casState(executionId: TTYExecutionId, expected: string, candidate: TTYExecutionStateRecord): Promise<TTYExecutionStateRecord | null> {
    const serialized = JSON.stringify(candidate)
    const result = parseScriptResult(await this.dependencies.redis.eval(STATE_TRANSITION_SCRIPT, [ttyExecutionStateKey(executionId), ttyExecutionActiveIndexKey()], [expected, candidate.state, serialized, isExecutionStateActive(candidate.state) ? '1' : '0', executionId, String(STATE_TTL_SECONDS)]))
    if (!result.ok) return parseState(result.value)
    return parseState(result.value)
  }

  private async persistRuntimeMetadata(metadata: { readonly pid: number; readonly cwd: string; readonly handleId: string; readonly executionId: TTYExecutionId; readonly sessionId: TTYSessionId; readonly workerId: TTYWorkerId; readonly startedAt: string }): Promise<void> {
    await this.dependencies.redis.set(ttyExecutionRuntimeKey(metadata.executionId), JSON.stringify(metadata), { ex: STATE_TTL_SECONDS })
  }

  private async pumpOutput(context: ExecutionContext, stream: 'stdout' | 'stderr', source: AsyncIterable<Uint8Array>): Promise<void> {
    try {
      for await (const chunk of source) {
        const bytes = Buffer.from(chunk)
        const accounting = context.reservation?.recordOutput(stream, bytes.byteLength) ?? { allowed: false, acceptedBytes: 0, totalBytes: 0, stdoutBytes: 0, stderrBytes: 0, reason: 'invalid_output_bytes' as const }
        context.outputBytes = accounting.totalBytes
        context.stdoutBytes = accounting.stdoutBytes
        context.stderrBytes = accounting.stderrBytes
        if (accounting.acceptedBytes > 0) {
          if (!context.streaming) {
            context.streaming = true
            const state = await this.transition(context, 'streaming')
            await this.safeAppendState(state)
          }
          const accepted = bytes.subarray(0, accounting.acceptedBytes)
          for (let offset = 0; offset < accepted.byteLength; offset += MAX_STREAM_CHUNK_BYTES) {
            const part = accepted.subarray(offset, Math.min(accepted.byteLength, offset + MAX_STREAM_CHUNK_BYTES))
            await this.dependencies.outputStream.appendOutput({ executionId: context.executionId, sessionId: context.sessionId, stream, text: part.toString('utf8') })
          }
        }
        if (!accounting.allowed) {
          context.failureCode = accounting.reason === 'output_limit_exceeded' ? 'OUTPUT_LIMIT_EXCEEDED' : accounting.reason === 'stdout_rate_exceeded' ? 'STDOUT_RATE_EXCEEDED' : 'STDERR_RATE_EXCEEDED'
          context.cancelReason = 'worker_cancellation'
          await this.requestStop(context)
          return
        }
      }
    } catch (error) {
      context.outputFailed = true
      context.failureCode = 'OUTPUT_STREAM_FAILURE'
      log.warn('tty.execution.output_stream_failed', { executionId: context.executionId, sessionId: context.sessionId, stream, error: error instanceof Error ? error.message : String(error) })
      await this.requestStop(context)
    }
  }

  private startLeaseRenewal(context: ExecutionContext): void {
    context.renewTimer = setInterval(() => { void this.renewLease(context) }, this.leaseRenewIntervalMs)
  }

  private async renewLease(context: ExecutionContext): Promise<void> {
    if (!context.leaseToken || context.leaseLost) return
    let result: TTYLeaseRenewResult
    try {
      result = await this.dependencies.leaseManager.renew(context.executionId, context.sessionId, context.leaseToken)
    } catch {
      this.notifyLeaseLost(context, 'internal_error')
      context.leaseLost = true
      context.cancelReason = 'lease_expired'
      context.failureCode = 'LEASE_RENEWAL_FAILED'
      await this.requestStop(context)
      return
    }
    if (!result.renewed) {
      this.notifyLeaseLost(context, result.reason)
      context.leaseLost = true
      context.cancelReason = 'lease_expired'
      context.failureCode = result.reason === 'lease_expired' ? 'LEASE_EXPIRED' : 'LEASE_RENEWAL_FAILED'
      await this.requestStop(context)
    } else {
      try {
        context.hooks.onLeaseRenewed?.(context.executionId, context.sessionId)
      } catch {
        // Metrics hooks must never change execution ownership or runtime state.
      }
    }
  }

  private notifyLeaseLost(context: ExecutionContext, reason: string): void {
    try {
      context.hooks.onLeaseLost?.(context.executionId, context.sessionId, reason)
    } catch {
      // Metrics hooks must never change execution ownership or runtime state.
    }
  }

  private async requestStop(context: ExecutionContext): Promise<void> {
    if (!context.handle) return
    if (context.stopPromise) return context.stopPromise
    context.stopPromise = (async () => {
      try {
        await this.dependencies.processRuntime.stop(context.handle as TTYProcessHandle)
      } finally {
        context.killTimer = setTimeout(() => {
          if (context.handle) void this.dependencies.processRuntime.kill(context.handle).catch(() => undefined)
        }, this.stopGraceMs)
      }
    })()
    return context.stopPromise
  }

  private stopRenewal(context: ExecutionContext): void {
    if (!context.renewTimer) return
    clearInterval(context.renewTimer)
    context.renewTimer = undefined
  }

  private async waitForContext(context: ExecutionContext): Promise<TTYExecutionRunResult> {
    // run() owns the execution promise only after it registers the context;
    // callers that race cancellation with startup use the state as the safe
    // acknowledgement if the worker has not yet reached a process handle.
    const deadline = Date.now() + DEFAULT_CONTEXT_WAIT_TIMEOUT_MS
    while (this.contexts.has(context.executionId) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    if (this.contexts.has(context.executionId)) {
      log.warn('tty.execution.context_wait_timed_out', { executionId: context.executionId, sessionId: context.sessionId, workerId: this.dependencies.workerId })
      return { accepted: false, reason: 'internal_error', state: null }
    }
    const state = await this.getState(context.executionId)
    return state ? { accepted: true, state } : { accepted: false, reason: 'internal_error', state: null }
  }

  private clearContext(context: ExecutionContext): void {
    this.stopRenewal(context)
    if (context.killTimer) clearTimeout(context.killTimer)
    if (this.contexts.get(context.executionId) === context) this.contexts.delete(context.executionId)
  }

  private async safeAppendState(state: TTYExecutionStateRecord): Promise<void> {
    try {
      await this.dependencies.outputStream.appendState({ executionId: state.executionId, sessionId: state.sessionId, state: state.state, timestamp: state.updatedAt })
    } catch (error) {
      log.warn('tty.execution.state_stream_failed', { executionId: state.executionId, sessionId: state.sessionId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async safeAppendCompletion(state: TTYExecutionStateRecord): Promise<void> {
    try {
      await this.dependencies.outputStream.appendCompletion({ executionId: state.executionId, sessionId: state.sessionId, state: state.state, timestamp: state.finishedAt ?? state.updatedAt })
    } catch (error) {
      log.warn('tty.execution.completion_stream_failed', { executionId: state.executionId, sessionId: state.sessionId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async safeAuditForState(state: TTYExecutionStateRecord, context: ExecutionContext): Promise<void> {
    if (!this.dependencies.audit) return
    const eventType = state.state === 'succeeded' ? 'execution_completed' : state.state === 'cancelled' ? 'execution_cancelled' : state.state === 'timed_out' ? 'execution_timed_out' : state.state === 'failed' ? 'execution_failed' : 'execution_recovered'
    try {
      await appendTTYWorkerAuditEvent(this.dependencies.audit, {
        eventType,
        timestamp: state.updatedAt,
        workerId: this.dependencies.workerId,
        sessionId: state.sessionId,
        executionId: state.executionId,
        leaseId: state.leaseId,
        metadata: {
          state: state.state,
          failureCode: state.failureCode,
          completionReason: state.completionReason,
          outputBytes: state.outputBytes,
          workerContext: context.leaseToken !== null
        }
      })
    } catch {
      // State and lease records remain authoritative; audit is replayable.
    }
  }
}
