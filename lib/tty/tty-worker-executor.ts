import { log } from '@/lib/hexical/telemetry'

import type { TTYExecutionCoordinator, TTYExecutionCoordinatorRunHooks, TTYExecutionCancellationReason } from './tty-execution-coordinator'
import type { TTYExecutionStateRecord } from './tty-execution-state'
import type { TTYWorkerClaimService, TTYWorkerCoordinatorClaimResult, TTYWorkerOwnership } from './tty-worker-claim'
import type { TTYWorkerPoller } from './tty-worker-poller'
import type { TTYWorkerRecoveryService } from './tty-worker-recovery'
import type { TTYExecutionId } from './tty-types'
import type { TTYWorkerId } from './tty-worker-types'

export type TTYWorkerExecutorState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'

export interface TTYWorkerExecutorMetrics {
  readonly executionsStarted: number
  readonly executionsCompleted: number
  readonly executionsFailed: number
  readonly executionsCancelled: number
  readonly averageDurationMs: number
  readonly leaseRenewals: number
  readonly leaseLosses: number
  readonly recoveriesDuringExecution: number
}

export interface TTYWorkerExecutorStatus {
  readonly state: TTYWorkerExecutorState
  readonly running: boolean
  readonly activeExecutionId: TTYExecutionId | null
  readonly metrics: TTYWorkerExecutorMetrics
  readonly lastError: string | null
}

export type TTYWorkerExecutionSkipReason =
  | 'worker_stopped'
  | 'worker_busy'
  | 'missing_execution_context'
  | 'missing_job'
  | 'not_queued'
  | 'session_terminated'
  | 'attempts_exhausted'
  | 'unauthorized_worker'
  | 'internal_error'
  | 'lease_expired'

export type TTYWorkerExecutionOutcome =
  | { readonly executionId: TTYExecutionId; readonly status: 'completed' | 'cancelled' | 'failed' | 'expired'; readonly state: TTYExecutionStateRecord | null }
  | { readonly executionId: TTYExecutionId; readonly status: 'skipped'; readonly state: TTYExecutionStateRecord | null; readonly reason: TTYWorkerExecutionSkipReason }

export interface TTYWorkerExecutorPoller {
  startPolling(): Promise<unknown>
  stopPolling(): Promise<unknown>
}

export interface TTYWorkerExecutorRecovery {
  recoverNow(): Promise<unknown>
}

export interface TTYWorkerExecutorLogger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void
  error(event: string, fields?: Readonly<Record<string, unknown>>): void
}

export interface TTYWorkerExecutorDependencies {
  readonly workerId: TTYWorkerId
  readonly poller: TTYWorkerExecutorPoller | Pick<TTYWorkerPoller, 'startPolling' | 'stopPolling'>
  readonly claim: Pick<TTYWorkerClaimService, 'claimExecutionForCoordinator' | 'releaseOwnership' | 'forgetOwnership'>
  readonly coordinator: Pick<TTYExecutionCoordinator, 'runClaimed' | 'cancelExecution'>
  readonly recovery?: TTYWorkerExecutorRecovery | Pick<TTYWorkerRecoveryService, 'recoverNow'>
  readonly now?: () => number
  readonly logger?: TTYWorkerExecutorLogger
}

const defaultLogger: TTYWorkerExecutorLogger = {
  info: (event, fields) => log.info(event, { component: 'tty-worker-executor', ...fields }),
  warn: (event, fields) => log.warn(event, { component: 'tty-worker-executor', ...fields }),
  error: (event, fields) => log.error(event, { component: 'tty-worker-executor', ...fields })
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) return error.name.slice(0, 80)
  return 'unknown_error'
}

function freezeMetrics(metrics: TTYWorkerExecutorMetrics): TTYWorkerExecutorMetrics {
  return Object.freeze({ ...metrics })
}

function freezeStatus(status: TTYWorkerExecutorStatus): TTYWorkerExecutorStatus {
  return Object.freeze({ ...status, metrics: status.metrics })
}

interface ActiveExecution {
  readonly executionId: TTYExecutionId
  readonly promise: Promise<TTYWorkerExecutionOutcome>
  readonly ownership: TTYWorkerOwnership | null
}

export class TTYWorkerExecutor {
  private readonly now: () => number
  private readonly logger: TTYWorkerExecutorLogger
  private state: TTYWorkerExecutorState = 'stopped'
  private active = false
  private startPromise: Promise<TTYWorkerExecutorStatus> | null = null
  private stopPromise: Promise<TTYWorkerExecutorStatus> | null = null
  private activeExecution: ActiveExecution | null = null
  private totalDurationMs = 0
  private durationSamples = 0
  private metrics: TTYWorkerExecutorMetrics = freezeMetrics({
    executionsStarted: 0,
    executionsCompleted: 0,
    executionsFailed: 0,
    executionsCancelled: 0,
    averageDurationMs: 0,
    leaseRenewals: 0,
    leaseLosses: 0,
    recoveriesDuringExecution: 0
  })
  private lastError: string | null = null

  constructor(private readonly dependencies: TTYWorkerExecutorDependencies) {
    this.now = dependencies.now ?? (() => Date.now())
    this.logger = dependencies.logger ?? defaultLogger
  }

  async start(): Promise<TTYWorkerExecutorStatus> {
    if (this.active && this.startPromise !== null) return this.startPromise
    if (this.active) return this.getStatus()
    if (this.state === 'stopping' && this.stopPromise !== null) await this.stopPromise

    this.active = true
    this.state = 'starting'
    this.lastError = null
    this.logger.info('executor_starting', { workerId: this.dependencies.workerId })
    this.startPromise = this.startInternal()
    try {
      return await this.startPromise
    } catch (error) {
      this.active = false
      this.state = 'failed'
      this.lastError = safeErrorCode(error)
      this.logger.error('executor_start_failed', { workerId: this.dependencies.workerId, errorCode: this.lastError })
      throw error
    } finally {
      this.startPromise = null
    }
  }

  async stop(): Promise<TTYWorkerExecutorStatus> {
    if (!this.active && this.state === 'stopped') return this.getStatus()
    if (this.state === 'stopping' && this.stopPromise !== null) return this.stopPromise

    this.active = false
    this.state = 'stopping'
    this.stopPromise = this.stopInternal()
    try {
      return await this.stopPromise
    } finally {
      this.stopPromise = null
    }
  }

  async cancelActive(reason: TTYExecutionCancellationReason = 'worker_cancellation'): Promise<TTYWorkerExecutionOutcome | null> {
    const active = this.activeExecution
    if (active === null || active.ownership === null) return null
    this.logger.info('execution_cancellation_requested', { executionId: active.executionId, reason })
    try {
      const cancellation = await this.dependencies.coordinator.cancelExecution(active.executionId, reason)
      if (cancellation.state === null) return null
      return this.outcomeFromState(active.executionId, cancellation.state)
    } catch (error) {
      this.lastError = 'cancellation_failed'
      this.logger.error('execution_cancellation_failed', { executionId: active.executionId, errorCode: safeErrorCode(error) })
      return null
    }
  }

  async executeExecution(executionId: TTYExecutionId): Promise<TTYWorkerExecutionOutcome> {
    if (!this.active) return { executionId, status: 'skipped', state: null, reason: 'worker_stopped' }
    const current = this.activeExecution
    if (current !== null) {
      if (current.executionId === executionId) return current.promise
      return { executionId, status: 'skipped', state: null, reason: 'worker_busy' }
    }

    const promise = this.executeInternal(executionId)
    this.activeExecution = { executionId, promise, ownership: null }
    try {
      return await promise
    } finally {
      if (this.activeExecution?.promise === promise) this.activeExecution = null
    }
  }

  async handlePendingExecutionIds(executionIds: readonly string[]): Promise<readonly TTYWorkerExecutionOutcome[]> {
    const outcomes: TTYWorkerExecutionOutcome[] = []
    for (const rawExecutionId of executionIds) {
      if (!this.active) break
      const executionId = rawExecutionId.trim() as TTYExecutionId
      if (executionId.length === 0) continue
      outcomes.push(await this.executeExecution(executionId))
    }
    return Object.freeze(outcomes)
  }

  getStatus(): TTYWorkerExecutorStatus {
    return freezeStatus({
      state: this.state,
      running: this.active,
      activeExecutionId: this.activeExecution?.executionId ?? null,
      metrics: this.metrics,
      lastError: this.lastError
    })
  }

  private async startInternal(): Promise<TTYWorkerExecutorStatus> {
    if (this.dependencies.recovery) {
      await this.dependencies.recovery.recoverNow()
      if (!this.active) return this.getStatus()
    }
    await this.dependencies.poller.startPolling()
    if (this.active) this.state = 'running'
    return this.getStatus()
  }

  private async stopInternal(): Promise<TTYWorkerExecutorStatus> {
    if (this.startPromise !== null) await this.startPromise.catch(() => undefined)
    const execution = this.activeExecution
    if (execution !== null) {
      await this.cancelActive('worker_cancellation')
      await execution.promise.catch(() => undefined)
    }
    await this.dependencies.poller.stopPolling()
    this.state = 'stopped'
    this.logger.info('executor_stopped', { workerId: this.dependencies.workerId })
    return this.getStatus()
  }

  private async executeInternal(executionId: TTYExecutionId): Promise<TTYWorkerExecutionOutcome> {
    let ownership: TTYWorkerOwnership | null = null
    const startedAtMs = this.now()
    let leaseLost = false
    let coordinatorStarted = false
    try {
      const claimed = await this.dependencies.claim.claimExecutionForCoordinator(executionId)
      if (!claimed.claimed) {
        this.logger.info('execution_not_claimed', { executionId, reason: claimed.reason })
        return { executionId, status: 'skipped', state: null, reason: claimed.reason }
      }
      ownership = claimed.ownership
      this.activeExecution = this.updateActiveOwnership(ownership)
      if (ownership.workerId !== this.dependencies.workerId || claimed.job.lease.workerId !== this.dependencies.workerId || claimed.job.lease.leaseId !== ownership.leaseId) {
        this.logger.error('execution_ownership_mismatch', { executionId })
        return { executionId, status: 'skipped', state: null, reason: 'unauthorized_worker' }
      }

      this.incrementMetrics('executionsStarted')
      coordinatorStarted = true
      this.logger.info('execution_started', { executionId, workerId: this.dependencies.workerId, leaseId: ownership.leaseId })
      const hooks: TTYExecutionCoordinatorRunHooks = {
        onLeaseRenewed: () => {
          this.incrementMetrics('leaseRenewals')
          this.logger.info('lease_renewed', { executionId, leaseId: ownership?.leaseId })
        },
        onLeaseLost: (_id, _sessionId, reason) => {
          leaseLost = true
          this.incrementMetrics('leaseLosses')
          this.logger.warn('lease_lost', { executionId, leaseId: ownership?.leaseId, reason })
        }
      }
      const result = await this.dependencies.coordinator.runClaimed(claimed.job, hooks)
      const state = result.state
      if (state === null) {
        this.incrementMetrics('executionsFailed')
        return { executionId, status: 'failed', state: null }
      }
      const outcome = this.outcomeFromState(executionId, state)
      this.recordTerminalMetrics(outcome, startedAtMs)
      if (leaseLost) await this.recoverAfterInterruption(executionId)
      this.logger.info('execution_completed', { executionId, workerId: this.dependencies.workerId, state: state.state, durationMs: Math.max(0, this.now() - startedAtMs) })
      return outcome
    } catch (error) {
      this.lastError = 'execution_failed'
      if (coordinatorStarted) this.incrementMetrics('executionsFailed')
      this.logger.error('execution_failed', { executionId, workerId: this.dependencies.workerId, errorCode: safeErrorCode(error) })
      if (coordinatorStarted) await this.recoverAfterInterruption(executionId)
      return { executionId, status: 'failed', state: null }
    } finally {
      if (ownership !== null) await this.releaseOwnership(ownership)
    }
  }

  private updateActiveOwnership(ownership: TTYWorkerOwnership): ActiveExecution | null {
    const active = this.activeExecution
    return active === null ? null : { ...active, ownership }
  }

  private async releaseOwnership(ownership: TTYWorkerOwnership): Promise<void> {
    try {
      const result = await this.dependencies.claim.releaseOwnership(ownership)
      if (result.released) this.logger.info('lease_released', { executionId: ownership.executionId, leaseId: ownership.leaseId })
      else if (result.reason !== 'unknown_ownership' && result.reason !== 'missing_job' && result.reason !== 'not_owner') {
        this.logger.warn('lease_release_failed', { executionId: ownership.executionId, leaseId: ownership.leaseId, reason: result.reason })
      }
    } catch (error) {
      this.logger.error('lease_release_error', { executionId: ownership.executionId, errorCode: safeErrorCode(error) })
    } finally {
      this.dependencies.claim.forgetOwnership(ownership)
    }
  }

  private async recoverAfterInterruption(executionId: TTYExecutionId): Promise<void> {
    if (!this.dependencies.recovery) return
    this.incrementMetrics('recoveriesDuringExecution')
    try {
      await this.dependencies.recovery.recoverNow()
    } catch (error) {
      this.logger.warn('execution_recovery_failed', { executionId, errorCode: safeErrorCode(error) })
    }
  }

  private outcomeFromState(executionId: TTYExecutionId, state: TTYExecutionStateRecord): TTYWorkerExecutionOutcome {
    if (state.state === 'succeeded') return { executionId, status: 'completed', state }
    if (state.state === 'cancelled') return { executionId, status: 'cancelled', state }
    if (state.state === 'expired') return { executionId, status: 'expired', state }
    return { executionId, status: 'failed', state }
  }

  private recordTerminalMetrics(outcome: TTYWorkerExecutionOutcome, startedAtMs: number): void {
    if (outcome.status === 'skipped') return
    if (outcome.status === 'completed') this.incrementMetrics('executionsCompleted')
    else if (outcome.status === 'cancelled') this.incrementMetrics('executionsCancelled')
    else this.incrementMetrics('executionsFailed')
    this.totalDurationMs += Math.max(0, this.now() - startedAtMs)
    this.durationSamples += 1
    this.metrics = freezeMetrics({ ...this.metrics, averageDurationMs: Math.round(this.totalDurationMs / this.durationSamples) })
  }

  private incrementMetrics(key: 'executionsStarted' | 'executionsCompleted' | 'executionsFailed' | 'executionsCancelled' | 'leaseRenewals' | 'leaseLosses' | 'recoveriesDuringExecution'): void {
    this.metrics = freezeMetrics({ ...this.metrics, [key]: this.metrics[key] + 1 })
  }
}

export function createTTYWorkerExecutor(dependencies: TTYWorkerExecutorDependencies): TTYWorkerExecutor {
  return new TTYWorkerExecutor(dependencies)
}
