import { log } from '@/lib/hexical/telemetry'
import type { TTYExecutionCoordinator } from './tty-execution-coordinator'
import { TTYRecoveryManager, type TTYRecoveryReconcileResult } from './tty-recovery'
import type { TTYExecutionId } from './tty-types'
import { ttyWorkerActiveLeaseIndexKey } from './tty-worker-keys'
import { detectStaleLease, type TTYWorkerLeaseObserver } from './tty-worker-observer'
import { parseTTYWorkerId, type TTYWorkerId } from './tty-worker-types'

export const TTY_WORKER_RECOVERY_DEFAULTS = Object.freeze({
  intervalMs: 15_000,
})

export type TTYWorkerRecoveryState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'

export interface TTYWorkerRecoveryMetrics {
  readonly recoveryRuns: number
  readonly orphanCandidatesScanned: number
  readonly orphanProcessesCleaned: number
  readonly executionsRecovered: number
  readonly recoveryFailures: number
  readonly leaseIndexMembersScanned: number
  readonly expiredLeasesObserved: number
  readonly expiredLeasesRecovered: number
  readonly expiredLeasesFinalized: number
  readonly expiredLeaseFailures: number
  readonly expiredLeasesDeferred: number
  readonly malformedLeaseIndexMembers: number
  readonly lastRunAt: string | null
  readonly lastRunDurationMs: number | null
  readonly lastError: string | null
}

export interface TTYWorkerRecoveryStatus {
  readonly state: TTYWorkerRecoveryState
  readonly running: boolean
  readonly metrics: TTYWorkerRecoveryMetrics
}

export interface TTYWorkerRecoveryRunResult {
  readonly orphan: TTYRecoveryReconcileResult
  readonly leaseIndexMembersScanned: number
  readonly expiredLeasesObserved: number
  readonly expiredLeasesRecovered: number
  readonly expiredLeasesFinalized: number
  readonly expiredLeaseFailures: number
  readonly expiredLeasesDeferred: number
  readonly malformedLeaseIndexMembers: number
  readonly failures: number
  readonly durationMs: number
}

export interface TTYWorkerRecoveryRedis {
  smembers(key: string): Promise<readonly string[]>
}

export interface TTYWorkerRecoveryDependencies {
  readonly redis: TTYWorkerRecoveryRedis
  readonly orphanRecovery: Pick<TTYRecoveryManager, 'reconcile'>
  readonly coordinator: Pick<TTYExecutionCoordinator, 'getState' | 'recoverExecution'>
  readonly observer: Pick<TTYWorkerLeaseObserver, 'getLeaseObservation'>
  readonly intervalMs?: number
  readonly now?: () => number
  readonly setTimeout?: (handler: () => void, delayMs: number) => unknown
  readonly clearTimeout?: (handle: unknown) => void
  readonly logger?: TTYWorkerRecoveryLogger
}

export interface TTYWorkerRecoveryLogger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void
  error(event: string, fields?: Readonly<Record<string, unknown>>): void
}

interface ParsedLeaseIndexMember {
  readonly workerId: TTYWorkerId
  readonly executionId: TTYExecutionId
}

interface ExpiredLeaseScanResult {
  readonly leaseIndexMembersScanned: number
  readonly expiredLeasesObserved: number
  readonly expiredLeasesRecovered: number
  readonly expiredLeasesFinalized: number
  readonly expiredLeaseFailures: number
  readonly expiredLeasesDeferred: number
  readonly malformedLeaseIndexMembers: number
}

const defaultLogger: TTYWorkerRecoveryLogger = {
  info: (event, fields) => log.info(event, { component: 'tty-worker-recovery', ...fields }),
  warn: (event, fields) => log.warn(event, { component: 'tty-worker-recovery', ...fields }),
  error: (event, fields) => log.error(event, { component: 'tty-worker-recovery', ...fields }),
}

function validInterval(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) return error.name.slice(0, 80)
  return 'unknown_error'
}

function emptyOrphanResult(): TTYRecoveryReconcileResult {
  return { scanned: 0, cleaned: 0, recovered: 0, failed: 0 }
}

function parseLeaseIndexMember(value: string): ParsedLeaseIndexMember | null {
  const separator = value.indexOf('|')
  if (separator <= 0 || separator === value.length - 1 || value.indexOf('|', separator + 1) !== -1) return null
  const workerId = parseTTYWorkerId(value.slice(0, separator))
  const executionId = value.slice(separator + 1)
  if (workerId === null || executionId.length === 0) return null
  return { workerId, executionId: executionId as TTYExecutionId }
}

function freezeMetrics(metrics: TTYWorkerRecoveryMetrics): TTYWorkerRecoveryMetrics {
  return Object.freeze({ ...metrics })
}

export class TTYWorkerRecoveryService {
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly setTimer: (handler: () => void, delayMs: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly logger: TTYWorkerRecoveryLogger
  private state: TTYWorkerRecoveryState = 'stopped'
  private active = false
  private timer: unknown = null
  private runInFlight: Promise<TTYWorkerRecoveryRunResult> | null = null
  private startPromise: Promise<TTYWorkerRecoveryStatus> | null = null
  private stopPromise: Promise<TTYWorkerRecoveryStatus> | null = null
  private metrics: TTYWorkerRecoveryMetrics = freezeMetrics({
    recoveryRuns: 0,
    orphanCandidatesScanned: 0,
    orphanProcessesCleaned: 0,
    executionsRecovered: 0,
    recoveryFailures: 0,
    leaseIndexMembersScanned: 0,
    expiredLeasesObserved: 0,
    expiredLeasesRecovered: 0,
    expiredLeasesFinalized: 0,
    expiredLeaseFailures: 0,
    expiredLeasesDeferred: 0,
    malformedLeaseIndexMembers: 0,
    lastRunAt: null,
    lastRunDurationMs: null,
    lastError: null,
  })

  constructor(private readonly dependencies: TTYWorkerRecoveryDependencies) {
    this.intervalMs = dependencies.intervalMs ?? TTY_WORKER_RECOVERY_DEFAULTS.intervalMs
    if (!validInterval(this.intervalMs)) throw new Error('Invalid TTY worker recovery interval.')
    this.now = dependencies.now ?? (() => Date.now())
    this.setTimer = dependencies.setTimeout ?? ((handler, delayMs) => setTimeout(handler, delayMs))
    this.clearTimer = dependencies.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.logger = dependencies.logger ?? defaultLogger
  }

  async start(): Promise<TTYWorkerRecoveryStatus> {
    if (this.active && this.startPromise !== null) {
      const started = await this.startPromise
      return this.statusAfterConcurrentStop(started)
    }
    if (this.active) return this.getStatus()
    if (this.state === 'stopping' && this.stopPromise !== null) await this.stopPromise

    this.active = true
    this.state = 'starting'
    this.metrics = freezeMetrics({ ...this.metrics, lastError: null })
    this.logger.info('recovery_starting', { intervalMs: this.intervalMs })
    this.startPromise = this.startInternal()
    try {
      const started = await this.startPromise
      return this.statusAfterConcurrentStop(started)
    } finally {
      this.startPromise = null
    }
  }

  async stop(): Promise<TTYWorkerRecoveryStatus> {
    if (!this.active && this.state === 'stopped') return this.getStatus()
    if (this.state === 'stopping' && this.stopPromise !== null) return this.stopPromise

    this.active = false
    this.state = 'stopping'
    this.clearScheduledRecovery()
    this.stopPromise = this.stopInternal()
    try {
      return await this.stopPromise
    } finally {
      this.stopPromise = null
    }
  }

  async recoverNow(): Promise<TTYWorkerRecoveryRunResult> {
    if (this.runInFlight !== null) return this.runInFlight
    const operation = this.performRecovery()
    this.runInFlight = operation
    try {
      return await operation
    } finally {
      if (this.runInFlight === operation) this.runInFlight = null
    }
  }

  getStatus(): TTYWorkerRecoveryStatus {
    return Object.freeze({ state: this.state, running: this.active, metrics: this.metrics })
  }

  private async startInternal(): Promise<TTYWorkerRecoveryStatus> {
    await this.recoverNow()
    if (this.active) {
      this.state = 'running'
      this.scheduleNextRecovery()
    }
    return this.getStatus()
  }

  private async stopInternal(): Promise<TTYWorkerRecoveryStatus> {
    if (this.startPromise !== null) await this.startPromise.catch(() => undefined)
    if (this.runInFlight !== null) await this.runInFlight.catch(() => undefined)
    this.clearScheduledRecovery()
    this.state = 'stopped'
    this.logger.info('recovery_stopped', { recoveryRuns: this.metrics.recoveryRuns })
    return this.getStatus()
  }

  private async statusAfterConcurrentStop(status: TTYWorkerRecoveryStatus): Promise<TTYWorkerRecoveryStatus> {
    if (status.state === 'stopping' && this.stopPromise !== null) return this.stopPromise
    return status
  }

  private async performRecovery(): Promise<TTYWorkerRecoveryRunResult> {
    const startedAtMs = this.now()
    let orphan = emptyOrphanResult()
    let failures = 0

    try {
      orphan = await this.dependencies.orphanRecovery.reconcile((executionId, sessionId) =>
        this.dependencies.coordinator.recoverExecution(executionId, sessionId),
      )
    } catch (error) {
      failures += 1
      this.logger.error('orphan_recovery_error', { errorCode: safeErrorCode(error) })
    }

    let leaseScan: ExpiredLeaseScanResult = {
      leaseIndexMembersScanned: 0,
      expiredLeasesObserved: 0,
      expiredLeasesRecovered: 0,
      expiredLeasesFinalized: 0,
      expiredLeaseFailures: 0,
      expiredLeasesDeferred: 0,
      malformedLeaseIndexMembers: 0,
    }
    try {
      leaseScan = await this.recoverExpiredLeases()
    } catch (error) {
      failures += 1
      this.logger.error('expired_lease_scan_error', { errorCode: safeErrorCode(error) })
    }

    failures += orphan.failed + leaseScan.expiredLeaseFailures
    const durationMs = Math.max(0, this.now() - startedAtMs)
    const result: TTYWorkerRecoveryRunResult = Object.freeze({ orphan, ...leaseScan, failures, durationMs })
    this.metrics = freezeMetrics({
      recoveryRuns: this.metrics.recoveryRuns + 1,
      orphanCandidatesScanned: this.metrics.orphanCandidatesScanned + orphan.scanned,
      orphanProcessesCleaned: this.metrics.orphanProcessesCleaned + orphan.cleaned,
      executionsRecovered: this.metrics.executionsRecovered + orphan.recovered,
      recoveryFailures: this.metrics.recoveryFailures + failures,
      leaseIndexMembersScanned: this.metrics.leaseIndexMembersScanned + leaseScan.leaseIndexMembersScanned,
      expiredLeasesObserved: this.metrics.expiredLeasesObserved + leaseScan.expiredLeasesObserved,
      expiredLeasesRecovered: this.metrics.expiredLeasesRecovered + leaseScan.expiredLeasesRecovered,
      expiredLeasesFinalized: this.metrics.expiredLeasesFinalized + leaseScan.expiredLeasesFinalized,
      expiredLeaseFailures: this.metrics.expiredLeaseFailures + leaseScan.expiredLeaseFailures,
      expiredLeasesDeferred: this.metrics.expiredLeasesDeferred + leaseScan.expiredLeasesDeferred,
      malformedLeaseIndexMembers: this.metrics.malformedLeaseIndexMembers + leaseScan.malformedLeaseIndexMembers,
      lastRunAt: new Date(this.now()).toISOString(),
      lastRunDurationMs: durationMs,
      lastError: failures > 0 ? 'recovery_partial_failure' : null,
    })
    this.logger.info('recovery_completed', {
      durationMs,
      orphanCandidates: orphan.scanned,
      orphanCleaned: orphan.cleaned,
      executionsRecovered: orphan.recovered,
      expiredLeasesObserved: leaseScan.expiredLeasesObserved,
      expiredLeasesRecovered: leaseScan.expiredLeasesRecovered,
      expiredLeasesFinalized: leaseScan.expiredLeasesFinalized,
      expiredLeasesDeferred: leaseScan.expiredLeasesDeferred,
      failures,
    })
    return result
  }

  private async recoverExpiredLeases(): Promise<ExpiredLeaseScanResult> {
    const members = [
      ...new Set((await this.dependencies.redis.smembers(ttyWorkerActiveLeaseIndexKey())).map(String)),
    ].sort()
    let expiredLeasesObserved = 0
    let expiredLeasesRecovered = 0
    let expiredLeasesFinalized = 0
    let expiredLeaseFailures = 0
    let expiredLeasesDeferred = 0
    let malformedLeaseIndexMembers = 0

    for (const member of members) {
      const parsed = parseLeaseIndexMember(member)
      if (parsed === null) {
        malformedLeaseIndexMembers += 1
        this.logger.warn('malformed_lease_index_member', { memberLength: member.length })
        continue
      }
      let observation: Awaited<ReturnType<TTYWorkerLeaseObserver['getLeaseObservation']>>
      try {
        observation = await this.dependencies.observer.getLeaseObservation(parsed.executionId)
      } catch (error) {
        expiredLeaseFailures += 1
        this.logger.error('lease_observation_error', {
          executionId: parsed.executionId,
          workerId: parsed.workerId,
          errorCode: safeErrorCode(error),
        })
        continue
      }
      if (observation === null || !detectStaleLease(observation, this.now())) continue
      expiredLeasesObserved += 1
      const state = await this.dependencies.coordinator.getState(parsed.executionId)
      if (state === null || state.sessionId !== observation.sessionId || state.state !== 'leased') {
        expiredLeasesDeferred += 1
        this.logger.warn('expired_lease_deferred', {
          executionId: parsed.executionId,
          workerId: parsed.workerId,
          leaseId: observation.leaseId,
          state: state?.state ?? 'missing',
        })
        continue
      }

      try {
        const recovered = await this.dependencies.coordinator.recoverExecution(
          parsed.executionId,
          observation.sessionId,
        )
        if (recovered?.state === 'queued') {
          expiredLeasesRecovered += 1
          this.logger.info('expired_lease_recovered', {
            executionId: parsed.executionId,
            workerId: parsed.workerId,
            leaseId: observation.leaseId,
          })
        } else if (recovered?.state === 'expired') {
          expiredLeasesFinalized += 1
          this.logger.warn('expired_lease_finalized', {
            executionId: parsed.executionId,
            workerId: parsed.workerId,
            leaseId: observation.leaseId,
          })
        } else {
          expiredLeaseFailures += 1
          this.logger.error('expired_lease_recovery_failed', {
            executionId: parsed.executionId,
            workerId: parsed.workerId,
            leaseId: observation.leaseId,
          })
        }
      } catch (error) {
        expiredLeaseFailures += 1
        this.logger.error('expired_lease_recovery_error', {
          executionId: parsed.executionId,
          workerId: parsed.workerId,
          leaseId: observation.leaseId,
          errorCode: safeErrorCode(error),
        })
      }
    }

    return {
      leaseIndexMembersScanned: members.length,
      expiredLeasesObserved,
      expiredLeasesRecovered,
      expiredLeasesFinalized,
      expiredLeaseFailures,
      expiredLeasesDeferred,
      malformedLeaseIndexMembers,
    }
  }

  private scheduleNextRecovery(): void {
    if (!this.active && this.timer !== null) return
    if (!this.active || this.timer !== null) return
    this.timer = this.setTimer(() => {
      this.timer = null
      void this.runScheduledRecovery()
    }, this.intervalMs)
    this.logger.info('recovery_scheduled', { intervalMs: this.intervalMs })
  }

  private async runScheduledRecovery(): Promise<void> {
    if (!this.active) return
    await this.recoverNow()
    if (this.active) this.scheduleNextRecovery()
  }

  private clearScheduledRecovery(): void {
    if (this.timer === null) return
    this.clearTimer(this.timer)
    this.timer = null
  }
}

export function createTTYWorkerRecoveryService(dependencies: TTYWorkerRecoveryDependencies): TTYWorkerRecoveryService {
  return new TTYWorkerRecoveryService(dependencies)
}
