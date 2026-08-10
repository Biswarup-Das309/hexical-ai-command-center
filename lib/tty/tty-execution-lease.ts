import type { Redis } from '@upstash/redis'
import { hasAuthenticatedTTYLeaseCapability } from './tty-execution-admission'
import type { TTYExecutionId, TTYExecutionKind, TTYSessionId } from './tty-types'
import {
  ttyExecutionJobKey,
  ttyPendingExecutionIndexKey,
  ttySessionKey as workerSessionKey,
  ttyWorkerActiveLeaseIndexKey,
  ttyWorkerActiveLeasesKey,
  ttyWorkerLeaseIndexMember,
} from './tty-worker-keys'
import type { TTYLeaseObserver } from './tty-worker-observer'
import { parseTTYWorkerId, type TTYLeaseId, type TTYWorkerAuthContext, type TTYWorkerId } from './tty-worker-types'

export const TTY_LEASE_DURATION_MS = 30_000
export const TTY_MAX_LEASE_DURATION_MS = 5 * 60_000
export const TTY_MAX_LEASE_ATTEMPTS = 3
const JOB_TTL_SECONDS = 24 * 60 * 60

/*
 * Each script receives the job key first, followed by the session keys it
 * must fence against. Redis executes each script atomically; no caller may
 * split these checks into GET/inspect/SET operations.
 *
 * Claim ARGV: workerId, leaseToken, nowMs, maxAttempts, leaseMs,
 *             maxLeaseMs, jobTtlSeconds, sessionId.
 * Renew ARGV: workerId, leaseToken, nowMs, leaseMs, jobTtlSeconds, sessionId.
 * Release ARGV: workerId, leaseToken, nowMs, jobTtlSeconds, executionId,
 *               maxAttempts, sessionId.
 * Recover ARGV: executionId, workerId, nowMs, maxAttempts, jobTtlSeconds,
 *               sessionId.
 * Complete ARGV: workerId, leaseToken, nowMs, executionId, sessionId.
 */

export interface TTYLeasedJob {
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  readonly ownerUserId: string
  readonly kind: TTYExecutionKind
  readonly status: 'leased'
  readonly createdAt: string
  readonly admittedAt: string
  readonly authorizationScopeId: string | null
  readonly argv?: readonly string[]
  readonly resource: {
    readonly maxExecutionDurationMs: number
    readonly maxOutputBytes: number
  }
  readonly attempt: number
  readonly lease: {
    readonly workerId: TTYWorkerId
    readonly token: string
    readonly leaseId: TTYLeaseId
    readonly claimedAtMs: number
    readonly renewedAtMs: number
    readonly expiresAtMs: number
    readonly maxExpiresAtMs: number
  }
}

export interface TTYRecoverableJob {
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  readonly ownerUserId: string
  readonly kind: TTYExecutionKind
  readonly status: 'queued'
  readonly createdAt: string
  readonly admittedAt: string
  readonly authorizationScopeId: string | null
  readonly argv?: readonly string[]
  readonly resource: {
    readonly maxExecutionDurationMs: number
    readonly maxOutputBytes: number
  }
  readonly attempt: number
}

export type TTYLeaseClaimResult =
  | { readonly claimed: true; readonly job: TTYLeasedJob }
  | {
      readonly claimed: false
      readonly reason:
        | 'missing_job'
        | 'not_queued'
        | 'session_terminated'
        | 'attempts_exhausted'
        | 'unauthorized_worker'
        | 'internal_error'
    }

export type TTYLeaseRenewResult =
  | { readonly renewed: true; readonly job: TTYLeasedJob }
  | {
      readonly renewed: false
      readonly reason: 'missing_job' | 'not_owner' | 'lease_expired' | 'session_terminated' | 'internal_error'
    }

export type TTYLeaseReleaseResult =
  | { readonly released: true; readonly job: TTYRecoverableJob }
  | {
      readonly released: false
      readonly reason:
        | 'missing_job'
        | 'not_owner'
        | 'lease_expired'
        | 'session_terminated'
        | 'attempts_exhausted'
        | 'internal_error'
    }

export type TTYLeaseRecoveryResult =
  | { readonly recovered: true; readonly job: TTYRecoverableJob }
  | {
      readonly recovered: false
      readonly reason:
        | 'missing_job'
        | 'not_expired'
        | 'not_leased'
        | 'session_terminated'
        | 'attempts_exhausted'
        | 'internal_error'
    }

export type TTYLeaseCompletionState = 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'expired'

export type TTYLeaseCompleteResult =
  | { readonly completed: true; readonly job: TTYLeasedJob }
  | {
      readonly completed: false
      readonly reason: 'missing_job' | 'not_owner' | 'lease_expired' | 'session_terminated' | 'internal_error'
    }

interface LeaseDependencies {
  readonly now?: () => number
  readonly token?: () => string
  readonly leaseId?: () => string
  readonly observer?: TTYLeaseObserver
}

const CLAIM_SCRIPT = `
-- tty-lease-claim
local raw = redis.call('GET', KEYS[1])
if not raw then return {0, 'missing_job'} end
local job = cjson.decode(raw)
if job.status ~= 'queued' then return {0, 'not_queued'} end
if job.sessionId ~= ARGV[8] then return {0, 'session_terminated'} end
if redis.call('EXISTS', KEYS[4]) == 1 or redis.call('EXISTS', KEYS[2]) == 0 or redis.call('EXISTS', KEYS[3]) == 0 then
  -- A lazy idle expiry has no terminate request to clean queued jobs.  Once
  -- the matching worker observes the dead session, remove the job and repair
  -- both admission counters atomically so it cannot remain orphaned forever.
  redis.call('DECR', KEYS[5])
  if tonumber(redis.call('GET', KEYS[5]) or '0') < 0 then redis.call('SET', KEYS[5], '0') end
  redis.call('EXPIRE', KEYS[5], ARGV[7])
  redis.call('DECR', KEYS[6])
  if tonumber(redis.call('GET', KEYS[6]) or '0') < 0 then redis.call('SET', KEYS[6], '0') end
  redis.call('EXPIRE', KEYS[6], ARGV[7])
  redis.call('DEL', KEYS[1])
  redis.call('SREM', KEYS[9], job.executionId)
  redis.call('SREM', KEYS[10], job.executionId)
  return {0, 'session_terminated'}
end
local attempt = tonumber(job.attempt or '0') + 1
if attempt > tonumber(ARGV[4]) then return {0, 'attempts_exhausted'} end
local now = tonumber(ARGV[3])
job.status = 'leased'
job.attempt = attempt
local credential = cjson.decode(ARGV[2])
job.lease = { workerId = ARGV[1], token = credential.token, leaseId = credential.leaseId, claimedAtMs = now, renewedAtMs = now, expiresAtMs = now + tonumber(ARGV[5]), maxExpiresAtMs = now + tonumber(ARGV[6]) }
redis.call('DECR', KEYS[5])
if tonumber(redis.call('GET', KEYS[5]) or '0') < 0 then redis.call('SET', KEYS[5], '0') end
redis.call('EXPIRE', KEYS[5], ARGV[7])
redis.call('SET', KEYS[1], cjson.encode(job), 'EX', ARGV[7])
redis.call('SADD', KEYS[6], job.executionId)
redis.call('SADD', KEYS[7], ARGV[1] .. '|' .. job.executionId)
redis.call('SREM', KEYS[10], job.executionId)
return {1, cjson.encode(job)}
`

const RENEW_SCRIPT = `
-- tty-lease-renew
local raw = redis.call('GET', KEYS[1])
if not raw then return {0, 'missing_job'} end
local job = cjson.decode(raw)
if job.status ~= 'leased' or not job.lease then return {0, 'not_owner'} end
if job.sessionId ~= ARGV[6] then return {0, 'not_owner'} end
if job.lease.workerId ~= ARGV[1] or job.lease.token ~= ARGV[2] then return {0, 'not_owner'} end
local now = tonumber(ARGV[3])
if tonumber(job.lease.expiresAtMs) <= now or tonumber(job.lease.maxExpiresAtMs) <= now then return {0, 'lease_expired'} end
if redis.call('EXISTS', KEYS[4]) == 1 or redis.call('EXISTS', KEYS[2]) == 0 or redis.call('EXISTS', KEYS[3]) == 0 then return {0, 'session_terminated'} end
local nextExpiry = now + tonumber(ARGV[4])
if nextExpiry > tonumber(job.lease.maxExpiresAtMs) then nextExpiry = tonumber(job.lease.maxExpiresAtMs) end
job.lease.expiresAtMs = nextExpiry
job.lease.renewedAtMs = now
redis.call('SET', KEYS[1], cjson.encode(job), 'EX', ARGV[5])
return {1, cjson.encode(job)}
`

const RELEASE_SCRIPT = `
-- tty-lease-release
local raw = redis.call('GET', KEYS[1])
if not raw then return {0, 'missing_job'} end
local job = cjson.decode(raw)
if job.status ~= 'leased' or not job.lease then return {0, 'not_owner'} end
if job.sessionId ~= ARGV[7] then return {0, 'not_owner'} end
if job.lease.workerId ~= ARGV[1] or job.lease.token ~= ARGV[2] then return {0, 'not_owner'} end
if tonumber(job.lease.expiresAtMs) <= tonumber(ARGV[3]) then return {0, 'lease_expired'} end
if redis.call('EXISTS', KEYS[4]) == 1 or redis.call('EXISTS', KEYS[2]) == 0 or redis.call('EXISTS', KEYS[3]) == 0 then return {0, 'session_terminated'} end
local attempt = tonumber(job.attempt or '0')
if attempt >= tonumber(ARGV[6]) then
  redis.call('DECR', KEYS[5])
  if tonumber(redis.call('GET', KEYS[5]) or '0') < 0 then redis.call('SET', KEYS[5], '0') end
  redis.call('EXPIRE', KEYS[5], ARGV[4])
  job.status = 'abandoned'
  job.lease = nil
  redis.call('SET', KEYS[1], cjson.encode(job), 'EX', ARGV[4])
  redis.call('SREM', KEYS[6], ARGV[5])
  redis.call('SREM', KEYS[7], ARGV[1] .. '|' .. ARGV[5])
  redis.call('SREM', KEYS[8], ARGV[5])
  redis.call('SREM', KEYS[9], ARGV[5])
  return {0, 'attempts_exhausted'}
end
job.status = 'queued'
job.attempt = attempt + 1
job.lease = nil
redis.call('INCR', KEYS[5])
redis.call('EXPIRE', KEYS[5], ARGV[4])
redis.call('SET', KEYS[1], cjson.encode(job), 'EX', ARGV[4])
redis.call('SREM', KEYS[6], ARGV[5])
redis.call('SREM', KEYS[7], ARGV[1] .. '|' .. ARGV[5])
redis.call('SADD', KEYS[9], ARGV[5])
return {1, cjson.encode(job)}
`

const RECOVER_SCRIPT = `
-- tty-lease-recover
local raw = redis.call('GET', KEYS[1])
if not raw then return {0, 'missing_job'} end
local job = cjson.decode(raw)
if job.status ~= 'leased' or not job.lease then return {0, 'not_leased'} end
if job.sessionId ~= ARGV[6] then return {0, 'session_terminated'} end
local now = tonumber(ARGV[3])
if tonumber(job.lease.expiresAtMs) > now then return {0, 'not_expired'} end
local expiredWorkerId = job.lease.workerId
local expiredToken = job.lease.token
if redis.call('EXISTS', KEYS[4]) == 1 or redis.call('EXISTS', KEYS[2]) == 0 or redis.call('EXISTS', KEYS[3]) == 0 then
  redis.call('DECR', KEYS[6])
  if tonumber(redis.call('GET', KEYS[6]) or '0') < 0 then redis.call('SET', KEYS[6], '0') end
  redis.call('EXPIRE', KEYS[6], ARGV[5])
  redis.call('DEL', KEYS[1])
  redis.call('SREM', KEYS[8], expiredWorkerId .. '|' .. job.executionId)
  redis.call('SREM', KEYS[9], job.executionId)
  return {0, 'session_terminated', expiredWorkerId .. '|' .. job.executionId .. '|' .. expiredToken}
end
local attempt = tonumber(job.attempt or '0')
if attempt >= tonumber(ARGV[4]) then
  redis.call('DECR', KEYS[6])
  if tonumber(redis.call('GET', KEYS[6]) or '0') < 0 then redis.call('SET', KEYS[6], '0') end
  redis.call('EXPIRE', KEYS[6], ARGV[5])
  job.status = 'abandoned'
  job.lease = nil
  redis.call('SET', KEYS[1], cjson.encode(job), 'EX', ARGV[5])
  redis.call('SREM', KEYS[8], expiredWorkerId .. '|' .. job.executionId)
  redis.call('SREM', KEYS[9], job.executionId)
  return {0, 'attempts_exhausted', expiredWorkerId .. '|' .. job.executionId .. '|' .. expiredToken}
end
job.status = 'queued'
-- The next claim consumes the next attempt. Recovery itself does not.
job.attempt = attempt
job.lease = nil
redis.call('INCR', KEYS[5])
redis.call('EXPIRE', KEYS[5], ARGV[5])
redis.call('SET', KEYS[1], cjson.encode(job), 'EX', ARGV[5])
redis.call('SREM', KEYS[8], expiredWorkerId .. '|' .. job.executionId)
redis.call('SADD', KEYS[9], job.executionId)
return {1, cjson.encode(job), expiredWorkerId .. '|' .. job.executionId .. '|' .. expiredToken}
`

const COMPLETE_SCRIPT = `
-- tty-lease-complete
local raw = redis.call('GET', KEYS[1])
if not raw then return {0, 'missing_job'} end
local job = cjson.decode(raw)
if job.status ~= 'leased' or not job.lease then return {0, 'not_owner'} end
if job.sessionId ~= ARGV[5] then return {0, 'not_owner'} end
if job.lease.workerId ~= ARGV[1] or job.lease.token ~= ARGV[2] then return {0, 'not_owner'} end
if tonumber(job.lease.expiresAtMs) <= tonumber(ARGV[3]) then return {0, 'lease_expired'} end
if redis.call('EXISTS', KEYS[4]) == 1 or redis.call('EXISTS', KEYS[2]) == 0 or redis.call('EXISTS', KEYS[3]) == 0 then return {0, 'session_terminated'} end
redis.call('DECR', KEYS[5])
if tonumber(redis.call('GET', KEYS[5]) or '0') < 0 then redis.call('SET', KEYS[5], '0') end
redis.call('SREM', KEYS[6], ARGV[4])
redis.call('SREM', KEYS[7], ARGV[1] .. '|' .. ARGV[4])
redis.call('SREM', KEYS[8], ARGV[4])
redis.call('SREM', KEYS[9], ARGV[4])
redis.call('DEL', KEYS[1])
return {1, raw}
`

function parseResult(result: unknown): [number, unknown, string | undefined] {
  if (!Array.isArray(result) || typeof result[0] !== 'number' || result.length < 2)
    return [0, 'internal_error', undefined]
  return [result[0], result[1], typeof result[2] === 'string' ? result[2] : undefined]
}

function resultReason(value: unknown): string {
  return typeof value === 'string' ? value : 'internal_error'
}

function decodeJsonResult<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T
  if (typeof value === 'object' && value !== null) return value as T
  throw new Error('Invalid JSON result from TTY lease script.')
}

export class TTYExecutionLeaseManager {
  private readonly workerId: TTYWorkerId
  private readonly workerContext: TTYWorkerAuthContext
  private readonly now: () => number
  private readonly token: () => string
  private readonly leaseId: () => string

  constructor(
    private readonly redis: Redis,
    workerContext: TTYWorkerAuthContext,
    private readonly dependencies: LeaseDependencies = {},
  ) {
    const normalizedWorkerId = parseTTYWorkerId(workerContext.workerId)
    if (normalizedWorkerId === null) throw new Error('Invalid trusted worker identity.')
    this.workerId = normalizedWorkerId
    this.workerContext = workerContext
    this.now = dependencies.now ?? (() => Date.now())
    this.token = dependencies.token ?? (() => crypto.randomUUID())
    this.leaseId = dependencies.leaseId ?? (() => crypto.randomUUID())
  }

  async claim(executionId: TTYExecutionId, sessionId: TTYSessionId): Promise<TTYLeaseClaimResult> {
    if (!this.authorized('claim_lease')) return { claimed: false, reason: 'unauthorized_worker' }
    try {
      const now = this.now()
      const token = this.token()
      const leaseId = this.leaseId()
      if (leaseId === token) return { claimed: false, reason: 'internal_error' }
      const credential = JSON.stringify({ token, leaseId })
      const result = parseResult(
        await this.redis.eval(
          CLAIM_SCRIPT,
          [
            ttyExecutionJobKey(executionId),
            workerSessionKey(sessionId, 'core'),
            workerSessionKey(sessionId, 'status'),
            workerSessionKey(sessionId, 'terminal'),
            workerSessionKey(sessionId, 'queue-depth'),
            workerSessionKey(sessionId, 'active-executions'),
            ttyWorkerActiveLeasesKey(this.workerId),
            ttyWorkerActiveLeaseIndexKey(),
            workerSessionKey(sessionId, 'jobs'),
            ttyPendingExecutionIndexKey(),
          ],
          [
            this.workerId,
            credential,
            String(now),
            String(TTY_MAX_LEASE_ATTEMPTS),
            String(TTY_LEASE_DURATION_MS),
            String(TTY_MAX_LEASE_DURATION_MS),
            String(JOB_TTL_SECONDS),
            sessionId,
          ],
        ),
      )
      if (result[0] !== 1) return { claimed: false, reason: claimReason(resultReason(result[1])) }
      const job = decodeJsonResult<TTYLeasedJob>(result[1])
      await this.notify(() => this.dependencies.observer?.observeLeaseClaimed(job))
      return { claimed: true, job }
    } catch {
      return { claimed: false, reason: 'internal_error' }
    }
  }

  async renew(executionId: TTYExecutionId, sessionId: TTYSessionId, leaseToken: string): Promise<TTYLeaseRenewResult> {
    if (!this.authorized('renew_lease')) return { renewed: false, reason: 'internal_error' }
    try {
      const result = parseResult(
        await this.redis.eval(
          RENEW_SCRIPT,
          [
            ttyExecutionJobKey(executionId),
            workerSessionKey(sessionId, 'core'),
            workerSessionKey(sessionId, 'status'),
            workerSessionKey(sessionId, 'terminal'),
          ],
          [
            this.workerId,
            leaseToken,
            String(this.now()),
            String(TTY_LEASE_DURATION_MS),
            String(JOB_TTL_SECONDS),
            sessionId,
          ],
        ),
      )
      if (result[0] !== 1) {
        if (result[1] === 'lease_expired')
          await this.notify(
            () =>
              this.dependencies.observer?.observeLeaseExpired(
                this.workerId,
                executionId,
                leaseToken as TTYLeaseId,
                sessionId,
              ),
          )
        return { renewed: false, reason: renewReason(resultReason(result[1])) }
      }
      const job = decodeJsonResult<TTYLeasedJob>(result[1])
      await this.notify(() => this.dependencies.observer?.observeLeaseRenewed(job))
      return { renewed: true, job }
    } catch {
      return { renewed: false, reason: 'internal_error' }
    }
  }

  async release(
    executionId: TTYExecutionId,
    sessionId: TTYSessionId,
    leaseToken: string,
  ): Promise<TTYLeaseReleaseResult> {
    if (!this.authorized('renew_lease')) return { released: false, reason: 'internal_error' }
    try {
      const result = parseResult(
        await this.redis.eval(
          RELEASE_SCRIPT,
          [
            ttyExecutionJobKey(executionId),
            workerSessionKey(sessionId, 'core'),
            workerSessionKey(sessionId, 'status'),
            workerSessionKey(sessionId, 'terminal'),
            workerSessionKey(sessionId, 'queue-depth'),
            ttyWorkerActiveLeasesKey(this.workerId),
            ttyWorkerActiveLeaseIndexKey(),
            workerSessionKey(sessionId, 'jobs'),
            ttyPendingExecutionIndexKey(),
          ],
          [
            this.workerId,
            leaseToken,
            String(this.now()),
            String(JOB_TTL_SECONDS),
            executionId,
            String(TTY_MAX_LEASE_ATTEMPTS),
            sessionId,
          ],
        ),
      )
      if (result[0] !== 1) return { released: false, reason: releaseReason(resultReason(result[1])) }
      const job = decodeJsonResult<TTYRecoverableJob>(result[1])
      await this.notify(
        () => this.dependencies.observer?.observeLeaseReleased(job, this.workerId, leaseToken as TTYLeaseId),
      )
      return { released: true, job }
    } catch {
      return { released: false, reason: 'internal_error' }
    }
  }

  async recover(executionId: TTYExecutionId, sessionId: TTYSessionId): Promise<TTYLeaseRecoveryResult> {
    if (!this.authorized('claim_lease')) return { recovered: false, reason: 'internal_error' }
    try {
      const result = parseResult(
        await this.redis.eval(
          RECOVER_SCRIPT,
          [
            ttyExecutionJobKey(executionId),
            workerSessionKey(sessionId, 'core'),
            workerSessionKey(sessionId, 'status'),
            workerSessionKey(sessionId, 'terminal'),
            workerSessionKey(sessionId, 'queue-depth'),
            workerSessionKey(sessionId, 'active-executions'),
            workerSessionKey(sessionId, 'jobs'),
            ttyWorkerActiveLeaseIndexKey(),
            ttyPendingExecutionIndexKey(),
          ],
          [
            executionId,
            this.workerId,
            String(this.now()),
            String(TTY_MAX_LEASE_ATTEMPTS),
            String(JOB_TTL_SECONDS),
            sessionId,
          ],
        ),
      )
      await this.notifyExpired(result[2], executionId, sessionId)
      if (result[0] !== 1) return { recovered: false, reason: recoveryReason(resultReason(result[1])) }
      return { recovered: true, job: decodeJsonResult<TTYRecoverableJob>(result[1]) }
    } catch {
      return { recovered: false, reason: 'internal_error' }
    }
  }

  async complete(
    executionId: TTYExecutionId,
    sessionId: TTYSessionId,
    leaseToken: string,
    terminalState: TTYLeaseCompletionState,
  ): Promise<TTYLeaseCompleteResult> {
    if (!this.authorized('renew_lease')) return { completed: false, reason: 'internal_error' }
    if (terminalState === 'expired') return { completed: false, reason: 'lease_expired' }
    try {
      const result = parseResult(
        await this.redis.eval(
          COMPLETE_SCRIPT,
          [
            ttyExecutionJobKey(executionId),
            workerSessionKey(sessionId, 'core'),
            workerSessionKey(sessionId, 'status'),
            workerSessionKey(sessionId, 'terminal'),
            workerSessionKey(sessionId, 'active-executions'),
            ttyWorkerActiveLeasesKey(this.workerId),
            ttyWorkerActiveLeaseIndexKey(),
            workerSessionKey(sessionId, 'jobs'),
            ttyPendingExecutionIndexKey(),
          ],
          [this.workerId, leaseToken, String(this.now()), executionId, sessionId],
        ),
      )
      if (result[0] !== 1) return { completed: false, reason: completeReason(resultReason(result[1])) }
      const job = decodeJsonResult<TTYLeasedJob>(result[1])
      await this.notify(
        () => this.dependencies.observer?.observeLeaseCompleted(job, leaseToken as TTYLeaseId, terminalState),
      )
      return { completed: true, job }
    } catch {
      return { completed: false, reason: 'internal_error' }
    }
  }

  private authorized(capability: 'claim_lease' | 'renew_lease'): boolean {
    return hasAuthenticatedTTYLeaseCapability(this.workerContext, capability, this.now())
  }

  private async notify(action: () => Promise<void> | undefined): Promise<void> {
    try {
      await action()
    } catch {
      // Observation is deliberately non-blocking; the job record remains the
      // authoritative source and can be reconciled by listWorkerLeases().
    }
  }

  private async notifyExpired(
    value: string | undefined,
    executionId: TTYExecutionId,
    sessionId: TTYSessionId,
  ): Promise<void> {
    if (!value || !this.dependencies.observer) return
    const parts = value.split('|')
    if (parts.length !== 3) return
    const workerId = parseTTYWorkerId(parts[0])
    if (workerId === null) return
    await this.notify(
      () => this.dependencies.observer?.observeLeaseExpired(workerId, executionId, parts[2] as TTYLeaseId, sessionId),
    )
  }
}

function claimReason(value: string): Exclude<TTYLeaseClaimResult, { claimed: true }>['reason'] {
  if (
    value === 'missing_job' ||
    value === 'not_queued' ||
    value === 'session_terminated' ||
    value === 'attempts_exhausted' ||
    value === 'unauthorized_worker'
  )
    return value
  return 'internal_error'
}

function renewReason(value: string): Exclude<TTYLeaseRenewResult, { renewed: true }>['reason'] {
  if (value === 'missing_job' || value === 'not_owner' || value === 'lease_expired' || value === 'session_terminated')
    return value
  return 'internal_error'
}

function releaseReason(value: string): Exclude<TTYLeaseReleaseResult, { released: true }>['reason'] {
  if (
    value === 'missing_job' ||
    value === 'not_owner' ||
    value === 'lease_expired' ||
    value === 'session_terminated' ||
    value === 'attempts_exhausted'
  )
    return value
  return 'internal_error'
}

function recoveryReason(value: string): Exclude<TTYLeaseRecoveryResult, { recovered: true }>['reason'] {
  if (
    value === 'missing_job' ||
    value === 'not_expired' ||
    value === 'not_leased' ||
    value === 'session_terminated' ||
    value === 'attempts_exhausted'
  )
    return value
  return 'internal_error'
}

function completeReason(value: string): Exclude<TTYLeaseCompleteResult, { completed: true }>['reason'] {
  if (value === 'missing_job' || value === 'not_owner' || value === 'lease_expired' || value === 'session_terminated')
    return value
  return 'internal_error'
}
