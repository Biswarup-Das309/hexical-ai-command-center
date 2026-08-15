import type { TTYLeasedJob, TTYRecoverableJob } from './tty-execution-lease'
import type { TTYTerminalExecutionState } from './tty-execution-state'
import type { TTYRuntimeStore as Redis } from './tty-runtime-store'
import { appendTTYWorkerAuditEvent, type TTYWorkerAuditSink } from './tty-worker-audit'
import {
  ttyExecutionJobKey,
  ttyWorkerActiveLeaseIndexKey,
  ttyWorkerActiveLeasesKey,
  ttyWorkerLeaseIndexMember,
} from './tty-worker-keys'
import { computeLeaseAge as computeLeaseAgeFromTimestamp } from './tty-worker-observer-utils'
import {
  parseTTYWorkerId,
  type TTYLeaseId,
  type TTYWorkerExecutionMetadata,
  type TTYWorkerExecutionState,
  type TTYWorkerId,
} from './tty-worker-types'

export interface TTYLeaseObservation {
  readonly executionId: TTYWorkerExecutionMetadata['executionId']
  readonly sessionId: TTYWorkerExecutionMetadata['sessionId']
  readonly workerId: TTYWorkerId
  readonly leaseId: TTYLeaseId
  readonly claimedAt: string | null
  readonly renewedAt: string | null
  readonly leaseAgeMs: number | null
  readonly executionState: TTYWorkerExecutionState | TTYTerminalExecutionState
  readonly expiresAt: string
}

export interface TTYLeaseObserver {
  observeLeaseClaimed(job: TTYLeasedJob): Promise<void>
  observeLeaseRenewed(job: TTYLeasedJob): Promise<void>
  observeLeaseReleased(job: TTYRecoverableJob, previousWorkerId: TTYWorkerId, leaseId: TTYLeaseId): Promise<void>
  observeLeaseCompleted(job: TTYLeasedJob, leaseId: TTYLeaseId, terminalState: TTYTerminalExecutionState): Promise<void>
  observeLeaseExpired(
    workerId: TTYWorkerId,
    executionId: TTYWorkerExecutionMetadata['executionId'],
    leaseId: TTYLeaseId,
    sessionId: TTYWorkerExecutionMetadata['sessionId'],
  ): Promise<void>
}

function parseJob(value: unknown): TTYLeasedJob | TTYRecoverableJob | null {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (
      typeof record.executionId !== 'string' ||
      typeof record.sessionId !== 'string' ||
      (record.status !== 'leased' && record.status !== 'queued' && record.status !== 'abandoned')
    )
      return null
    if (
      typeof record.ownerUserId !== 'string' ||
      typeof record.kind !== 'string' ||
      typeof record.createdAt !== 'string' ||
      typeof record.admittedAt !== 'string' ||
      (record.authorizationScopeId !== null && typeof record.authorizationScopeId !== 'string') ||
      typeof record.resource !== 'object' ||
      record.resource === null
    )
      return null
    if (record.status === 'leased') {
      if (typeof record.lease !== 'object' || record.lease === null) return null
      const lease = record.lease as Record<string, unknown>
      if (
        typeof lease.workerId !== 'string' ||
        parseTTYWorkerId(lease.workerId) === null ||
        typeof lease.token !== 'string' ||
        typeof lease.claimedAtMs !== 'number' ||
        typeof lease.expiresAtMs !== 'number' ||
        typeof lease.maxExpiresAtMs !== 'number'
      )
        return null
    }
    return parsed as TTYLeasedJob | TTYRecoverableJob
  } catch {
    return null
  }
}

function observationFromJob(job: TTYLeasedJob): TTYLeaseObservation {
  const workerId = parseTTYWorkerId(job.lease.workerId)
  if (workerId === null) throw new Error('Lease has an invalid worker identity.')
  const leaseId = (job.lease.leaseId ?? job.lease.token) as TTYLeaseId
  const claimedAt = new Date(job.lease.claimedAtMs).toISOString()
  const renewedAt = new Date(job.lease.renewedAtMs ?? job.lease.claimedAtMs).toISOString()
  return {
    executionId: job.executionId,
    sessionId: job.sessionId,
    workerId,
    leaseId,
    claimedAt,
    renewedAt,
    leaseAgeMs: computeLeaseAgeFromTimestamp(job.lease.claimedAtMs),
    executionState: 'leased',
    expiresAt: new Date(job.lease.expiresAtMs).toISOString(),
  }
}

export function computeLeaseAge(claimedAtMs: number, nowMs: number = Date.now()): number {
  return computeLeaseAgeFromTimestamp(claimedAtMs, nowMs)
}

export function detectStaleLease(
  observation: TTYLeaseObservation,
  nowMs: number = Date.now(),
  staleAfterMs?: number,
): boolean {
  const expiresAtMs = Date.parse(observation.expiresAt)
  const claimedAtMs = observation.claimedAt === null ? Number.NaN : Date.parse(observation.claimedAt)
  const currentAgeMs = Number.isFinite(claimedAtMs) ? Math.max(0, nowMs - claimedAtMs) : null
  return (
    (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) ||
    (staleAfterMs !== undefined && currentAgeMs !== null && currentAgeMs >= staleAfterMs)
  )
}

export class TTYWorkerLeaseObserver implements TTYLeaseObserver {
  constructor(
    private readonly redis: Redis,
    private readonly options: { readonly audit?: TTYWorkerAuditSink } = {},
  ) {}

  async observeLeaseClaimed(job: TTYLeasedJob): Promise<void> {
    const observation = observationFromJob(job)
    await this.index(observation.workerId, job.executionId)
    await this.emit('lease_claimed', observation)
  }

  async observeLeaseRenewed(job: TTYLeasedJob): Promise<void> {
    const observation = observationFromJob(job)
    await this.index(observation.workerId, job.executionId)
    await this.emit('lease_renewed', observation)
  }

  async observeLeaseReleased(
    job: TTYRecoverableJob,
    previousWorkerId: TTYWorkerId,
    leaseId: TTYLeaseId,
  ): Promise<void> {
    await this.removeIndex(previousWorkerId, job.executionId)
    await this.emit('lease_released', {
      executionId: job.executionId,
      sessionId: job.sessionId,
      workerId: previousWorkerId,
      leaseId,
      claimedAt: null,
      renewedAt: null,
      leaseAgeMs: null,
      executionState: job.status,
      expiresAt: new Date().toISOString(),
    })
  }

  async observeLeaseCompleted(
    job: TTYLeasedJob,
    leaseId: TTYLeaseId,
    terminalState: TTYTerminalExecutionState,
  ): Promise<void> {
    await this.removeIndex(job.lease.workerId, job.executionId)
    await this.emit('lease_completed', {
      executionId: job.executionId,
      sessionId: job.sessionId,
      workerId: job.lease.workerId,
      leaseId,
      claimedAt: new Date(job.lease.claimedAtMs).toISOString(),
      renewedAt: new Date(job.lease.renewedAtMs).toISOString(),
      leaseAgeMs: null,
      executionState: terminalState,
      expiresAt: new Date().toISOString(),
    })
  }

  async observeLeaseExpired(
    workerId: TTYWorkerId,
    executionId: TTYWorkerExecutionMetadata['executionId'],
    leaseId: TTYLeaseId,
    sessionId: TTYWorkerExecutionMetadata['sessionId'],
  ): Promise<void> {
    await this.removeIndex(workerId, executionId)
    await this.emit('lease_expired', {
      executionId,
      sessionId,
      workerId,
      leaseId,
      claimedAt: null,
      renewedAt: null,
      leaseAgeMs: null,
      executionState: 'expired',
      expiresAt: new Date().toISOString(),
    })
  }

  async getLeaseObservation(
    executionId: TTYWorkerExecutionMetadata['executionId'],
  ): Promise<TTYLeaseObservation | null> {
    try {
      const raw = await this.redis.get<unknown>(ttyExecutionJobKey(executionId))
      if (raw === null) return null
      const job = parseJob(raw)
      return job?.status === 'leased' ? observationFromJob(job) : null
    } catch {
      return null
    }
  }

  async listWorkerLeases(workerId: TTYWorkerId): Promise<readonly TTYLeaseObservation[]> {
    if (parseTTYWorkerId(workerId) === null) return []
    try {
      const ids = await this.redis.smembers(ttyWorkerActiveLeasesKey(workerId))
      const observations = await Promise.all(
        ids.map(async (id) => {
          const raw = await this.redis.get<unknown>(ttyExecutionJobKey(id as TTYWorkerExecutionMetadata['executionId']))
          if (raw === null) return null
          const job = parseJob(raw)
          if (job?.status !== 'leased' || job.lease.workerId !== workerId) {
            await this.redis.srem(ttyWorkerActiveLeasesKey(workerId), id)
            return null
          }
          return observationFromJob(job)
        }),
      )
      return observations.filter((observation): observation is TTYLeaseObservation => observation !== null)
    } catch {
      return []
    }
  }

  private async index(workerId: TTYWorkerId, executionId: TTYWorkerExecutionMetadata['executionId']): Promise<void> {
    await Promise.all([
      this.redis.sadd(ttyWorkerActiveLeasesKey(workerId), executionId),
      this.redis.sadd(ttyWorkerActiveLeaseIndexKey(), ttyWorkerLeaseIndexMember(workerId, executionId)),
    ])
  }

  private async removeIndex(
    workerId: TTYWorkerId,
    executionId: TTYWorkerExecutionMetadata['executionId'],
  ): Promise<void> {
    await Promise.all([
      this.redis.srem(ttyWorkerActiveLeasesKey(workerId), executionId),
      this.redis.srem(ttyWorkerActiveLeaseIndexKey(), ttyWorkerLeaseIndexMember(workerId, executionId)),
    ])
  }

  private async emit(
    eventType: 'lease_claimed' | 'lease_renewed' | 'lease_released' | 'lease_completed' | 'lease_expired',
    observation: TTYLeaseObservation,
  ): Promise<void> {
    if (!this.options.audit) return
    try {
      await appendTTYWorkerAuditEvent(this.options.audit, {
        eventType,
        timestamp: observation.renewedAt ?? new Date().toISOString(),
        workerId: observation.workerId,
        sessionId: observation.sessionId,
        executionId: observation.executionId,
        leaseId: observation.leaseId,
        metadata: { executionState: observation.executionState, leaseAgeMs: observation.leaseAgeMs },
      })
    } catch {
      // Lease state is stored atomically by the lease manager; audit is retriable.
    }
  }
}
