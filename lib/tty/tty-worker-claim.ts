import { log } from '@/lib/hexical/telemetry'

import type { TTYExecutionId, TTYSessionId } from './tty-types'
import {
  TTYExecutionLeaseManager,
  type TTYLeaseClaimResult,
  type TTYLeaseReleaseResult,
  type TTYLeaseRecoveryResult,
  type TTYLeasedJob
} from './tty-execution-lease'
import { detectStaleLease, type TTYLeaseObservation, type TTYWorkerLeaseObserver } from './tty-worker-observer'
import type { TTYLeaseId, TTYWorkerId } from './tty-worker-types'

export interface TTYWorkerOwnership {
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  readonly workerId: TTYWorkerId
  readonly leaseId: TTYLeaseId
  readonly claimedAt: string
  readonly renewedAt: string
  readonly expiresAt: string
}

export type TTYWorkerClaimFailure =
  | 'missing_execution_context'
  | 'missing_job'
  | 'not_queued'
  | 'session_terminated'
  | 'attempts_exhausted'
  | 'unauthorized_worker'
  | 'internal_error'
  | 'lease_expired'

export type TTYWorkerClaimResult =
  | { readonly claimed: true; readonly ownership: TTYWorkerOwnership }
  | { readonly claimed: false; readonly reason: TTYWorkerClaimFailure }

export type TTYWorkerReleaseResult =
  | { readonly released: true }
  | { readonly released: false; readonly reason: 'unknown_ownership' | 'missing_job' | 'not_owner' | 'lease_expired' | 'session_terminated' | 'attempts_exhausted' | 'internal_error' }

export interface TTYWorkerClaimLogger {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void
  error(message: string, fields?: Readonly<Record<string, unknown>>): void
}

export interface TTYWorkerClaimStatus {
  readonly claimAttempts: number
  readonly claimSuccesses: number
  readonly claimConflicts: number
  readonly leaseExpirationsObserved: number
  readonly activeOwnerships: readonly TTYWorkerOwnership[]
}

export interface TTYWorkerClaimDependencies {
  readonly workerId: TTYWorkerId
  readonly leaseManager: Pick<TTYExecutionLeaseManager, 'claim' | 'recover' | 'release'>
  readonly observer: Pick<TTYWorkerLeaseObserver, 'getLeaseObservation'>
  readonly resolveSessionId: (executionId: TTYExecutionId) => Promise<TTYSessionId | null>
  readonly now?: () => number
  readonly logger?: TTYWorkerClaimLogger
}

const defaultLogger: TTYWorkerClaimLogger = {
  info: (message, fields) => log.info(message, { component: 'tty-worker-claim', ...fields }),
  warn: (message, fields) => log.warn(message, { component: 'tty-worker-claim', ...fields }),
  error: (message, fields) => log.error(message, { component: 'tty-worker-claim', ...fields })
}

function safeOwnership(ownership: TTYWorkerOwnership): TTYWorkerOwnership {
  return Object.freeze({ ...ownership })
}

function ownershipFromJob(job: TTYLeasedJob): TTYWorkerOwnership {
  return safeOwnership({
    executionId: job.executionId,
    sessionId: job.sessionId,
    workerId: job.lease.workerId,
    leaseId: job.lease.leaseId,
    claimedAt: new Date(job.lease.claimedAtMs).toISOString(),
    renewedAt: new Date(job.lease.renewedAtMs).toISOString(),
    expiresAt: new Date(job.lease.expiresAtMs).toISOString()
  })
}

function ownershipFromObservation(observation: TTYLeaseObservation): TTYWorkerOwnership {
  return safeOwnership({
    executionId: observation.executionId,
    sessionId: observation.sessionId,
    workerId: observation.workerId,
    leaseId: observation.leaseId,
    claimedAt: observation.claimedAt ?? observation.renewedAt ?? new Date().toISOString(),
    renewedAt: observation.renewedAt ?? observation.claimedAt ?? new Date().toISOString(),
    expiresAt: observation.expiresAt
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'Unknown lease claim failure.'
}

export class TTYWorkerClaimService {
  private readonly now: () => number
  private readonly logger: TTYWorkerClaimLogger
  private readonly ownerships = new Map<string, TTYWorkerOwnership>()
  private readonly secrets = new Map<string, { readonly sessionId: TTYSessionId; readonly token: string }>()
  private claimAttempts = 0
  private claimSuccesses = 0
  private claimConflicts = 0
  private leaseExpirationsObserved = 0

  constructor(private readonly dependencies: TTYWorkerClaimDependencies) {
    this.now = dependencies.now ?? (() => Date.now())
    this.logger = dependencies.logger ?? defaultLogger
  }

  async claimPendingExecutionIds(executionIds: readonly string[]): Promise<readonly TTYWorkerOwnership[]> {
    const claimed: TTYWorkerOwnership[] = []
    for (const rawExecutionId of executionIds) {
      const executionId = rawExecutionId.trim() as TTYExecutionId
      if (executionId.length === 0) continue
      const result = await this.claimExecution(executionId)
      if (result.claimed) claimed.push(result.ownership)
    }
    return Object.freeze(claimed)
  }

  async claimExecution(executionId: TTYExecutionId, knownSessionId?: TTYSessionId): Promise<TTYWorkerClaimResult> {
    this.claimAttempts += 1
    const sessionId = knownSessionId ?? await this.resolveSessionId(executionId)
    if (sessionId === null) return { claimed: false, reason: 'missing_execution_context' }

    let result: TTYLeaseClaimResult
    try {
      result = await this.dependencies.leaseManager.claim(executionId, sessionId)
    } catch (error) {
      this.logger.error('lease_claim_error', { executionId, error: errorMessage(error) })
      return { claimed: false, reason: 'internal_error' }
    }

    if (result.claimed) {
      return this.recordClaimedOwnership(result.job)
    }

    if (result.reason === 'not_queued') {
      this.claimConflicts += 1
      const recoveredExpiredLease = await this.observePossibleExpiration(executionId, sessionId)
      this.logger.info('lease_conflict', { executionId })
      if (recoveredExpiredLease) return { claimed: false, reason: 'lease_expired' }
    }
    return { claimed: false, reason: result.reason }
  }

  async releaseOwnership(ownership: TTYWorkerOwnership): Promise<TTYWorkerReleaseResult> {
    const secret = this.secrets.get(ownership.executionId)
    if (secret === undefined) return { released: false, reason: 'unknown_ownership' }
    let result: TTYLeaseReleaseResult
    try {
      result = await this.dependencies.leaseManager.release(ownership.executionId, secret.sessionId, secret.token)
    } catch (error) {
      this.logger.error('lease_release_error', { executionId: ownership.executionId, error: errorMessage(error) })
      return { released: false, reason: 'internal_error' }
    }
    if (!result.released) return { released: false, reason: result.reason }
    this.ownerships.delete(ownership.executionId)
    this.secrets.delete(ownership.executionId)
    this.logger.info('lease_released', this.safeLogFields(ownership))
    return { released: true }
  }

  getOwnership(executionId: TTYExecutionId): TTYWorkerOwnership | null {
    return this.ownerships.get(executionId) ?? null
  }

  getStatus(): TTYWorkerClaimStatus {
    const activeOwnerships = [...this.ownerships.values()].sort((left, right) => left.executionId.localeCompare(right.executionId)).map(safeOwnership)
    return Object.freeze({
      claimAttempts: this.claimAttempts,
      claimSuccesses: this.claimSuccesses,
      claimConflicts: this.claimConflicts,
      leaseExpirationsObserved: this.leaseExpirationsObserved,
      activeOwnerships: Object.freeze(activeOwnerships)
    })
  }

  private async resolveSessionId(executionId: TTYExecutionId): Promise<TTYSessionId | null> {
    try {
      return await this.dependencies.resolveSessionId(executionId)
    } catch (error) {
      this.logger.error('execution_context_error', { executionId, error: errorMessage(error) })
      return null
    }
  }

  private async recordClaimedOwnership(job: TTYLeasedJob): Promise<TTYWorkerClaimResult> {
    let ownership: TTYWorkerOwnership
    try {
      const observation = await this.dependencies.observer.getLeaseObservation(job.executionId)
      ownership = observation === null || observation.workerId !== this.dependencies.workerId || observation.sessionId !== job.sessionId
        ? ownershipFromJob(job)
        : ownershipFromObservation(observation)
    } catch {
      ownership = ownershipFromJob(job)
    }
    this.ownerships.set(job.executionId, ownership)
    this.secrets.set(job.executionId, { sessionId: job.sessionId, token: job.lease.token })
    this.claimSuccesses += 1
    this.logger.info('lease_claimed', this.safeLogFields(ownership))
    return { claimed: true, ownership }
  }

  private async observePossibleExpiration(executionId: TTYExecutionId, sessionId: TTYSessionId): Promise<boolean> {
    let observation: TTYLeaseObservation | null
    try {
      observation = await this.dependencies.observer.getLeaseObservation(executionId)
    } catch {
      return false
    }
    if (observation === null || !detectStaleLease(observation, this.now())) return false
    this.leaseExpirationsObserved += 1
    this.logger.warn('stale_lease_observed', {
      executionId,
      workerId: observation.workerId,
      leaseId: observation.leaseId,
      expiresAt: observation.expiresAt
    })
    try {
      const recovery: TTYLeaseRecoveryResult = await this.dependencies.leaseManager.recover(executionId, sessionId)
      if (!recovery.recovered) return false
      this.ownerships.delete(executionId)
      this.secrets.delete(executionId)
      return true
    } catch (error) {
      this.logger.error('stale_lease_recovery_error', { executionId, error: errorMessage(error) })
      return false
    }
  }

  private safeLogFields(ownership: TTYWorkerOwnership): Readonly<Record<string, unknown>> {
    return {
      executionId: ownership.executionId,
      workerId: ownership.workerId,
      leaseId: ownership.leaseId,
      claimedAt: ownership.claimedAt,
      renewedAt: ownership.renewedAt,
      expiresAt: ownership.expiresAt
    }
  }
}

export function createTTYWorkerClaimService(dependencies: TTYWorkerClaimDependencies): TTYWorkerClaimService {
  return new TTYWorkerClaimService(dependencies)
}
