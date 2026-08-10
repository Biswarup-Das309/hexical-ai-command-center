import type { Redis } from '@upstash/redis'
import {
  createTTYExecutionId,
  type InternalTTYSession,
  type RawTerminalInput,
  type TTYExecutionId,
  type TTYExecutionKind,
  type TTYExecutionStatus,
  type TTYSessionId,
} from './tty-types'
import type { TTYWorkerAuthContext, TTYWorkerCapability } from './tty-worker-types'

export interface TTYQueuedJob {
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  readonly ownerUserId: string
  readonly kind: TTYExecutionKind
  readonly status: Extract<TTYExecutionStatus, 'queued'>
  readonly createdAt: string
  readonly admittedAt: string
  readonly authorizationScopeId: string | null
  /** Internal argv only. Never included in TTYBrowserJob. */
  readonly argv?: readonly string[]
  readonly resource: {
    readonly maxExecutionDurationMs: number
    readonly maxOutputBytes: number
  }
}

export interface TTYBrowserJob {
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  readonly kind: TTYExecutionKind
  readonly status: 'queued'
  readonly createdAt: string
  readonly admittedAt: string
}

export function toBrowserSafeJob(job: TTYQueuedJob): TTYBrowserJob {
  const {
    ownerUserId: _ownerUserId,
    authorizationScopeId: _authorizationScopeId,
    argv: _argv,
    resource: _resource,
    ...safe
  } = job
  return safe
}

/**
 * Converts already-classified terminal input to literal argv tokens. This is
 * intentionally whitespace-only: quotes, redirects, pipes, substitutions,
 * and shell operators never gain shell semantics at the execution boundary.
 */
export function parseTTYRawInputToArgv(rawInput: RawTerminalInput): readonly string[] {
  const value = rawInput.trim()
  if (value.length === 0 || value.includes('\u0000')) return []
  const argv = value.split(/\s+/)
  if (argv.some((argument) => argument.length === 0 || argument.length > 16_384 || argument.includes('\u0000')))
    return []
  return Object.freeze(argv)
}

export interface TTYAdmissionAuthorization {
  readonly allowed: boolean
  readonly scopeId: string | null
}

export interface TTYAdmissionDependencies {
  readonly authorize: (args: {
    readonly userId: string
    readonly rawInput: RawTerminalInput
    readonly kind: TTYExecutionKind
  }) => Promise<TTYAdmissionAuthorization>
  readonly now?: () => Date
  readonly executionId?: () => TTYExecutionId
}

/**
 * Admission creates user-owned queued work; it never assigns a worker. This
 * gate is the shared lease-ownership seam used by the lease manager so a
 * queued job cannot be claimed by an anonymous or expired worker context.
 */
export function hasAuthenticatedTTYLeaseCapability(
  context: TTYWorkerAuthContext | null,
  capability: Extract<TTYWorkerCapability, 'claim_lease' | 'renew_lease'>,
  nowMs: number = Date.now(),
): boolean {
  if (context === null || !Number.isFinite(nowMs)) return false
  const expiresAtMs = Date.parse(context.expiresAt)
  if (!Number.isFinite(expiresAtMs) || nowMs >= expiresAtMs) return false
  return context.capability === 'execute' || context.capability === capability
}

export type TTYAdmissionResult =
  | { readonly admitted: true; readonly job: TTYQueuedJob; readonly duplicate: boolean }
  | {
      readonly admitted: false
      readonly reason:
        | 'session_terminated'
        | 'concurrency_limit_exceeded'
        | 'rate_limited'
        | 'queue_full'
        | 'internal_error'
        | 'authorization_required'
        | 'input_rejected'
    }

const JOB_TTL_SECONDS = 24 * 60 * 60
const IDEMPOTENCY_TTL_SECONDS = 10 * 60

const RESERVE_JOB_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then return {2, existing} end
if redis.call('EXISTS', KEYS[6]) == 1 or redis.call('EXISTS', KEYS[7]) == 0 or redis.call('EXISTS', KEYS[8]) == 0 then return {0, 'session_terminated'} end
local queue = tonumber(redis.call('GET', KEYS[3]) or '0')
local active = tonumber(redis.call('GET', KEYS[4]) or '0')
local recent = redis.call('ZREMRANGEBYSCORE', KEYS[5], 0, tonumber(ARGV[3]) - 60000)
local rate = tonumber(redis.call('ZCARD', KEYS[5]))
if queue >= tonumber(ARGV[4]) then return {0, 'queue_full'} end
if active >= tonumber(ARGV[5]) then return {0, 'concurrency_limit_exceeded'} end
if rate >= tonumber(ARGV[6]) then return {0, 'rate_limited'} end
redis.call('INCR', KEYS[3])
redis.call('INCR', KEYS[4])
redis.call('EXPIRE', KEYS[3], ARGV[2])
redis.call('EXPIRE', KEYS[4], ARGV[2])
redis.call('ZADD', KEYS[5], ARGV[3], ARGV[1])
redis.call('EXPIRE', KEYS[5], ARGV[2])
redis.call('SET', KEYS[2], ARGV[7], 'EX', ARGV[2])
redis.call('SET', KEYS[1], ARGV[8], 'EX', ARGV[9])
redis.call('SADD', KEYS[9], ARGV[1])
redis.call('SADD', KEYS[10], KEYS[1])
redis.call('EXPIRE', KEYS[9], ARGV[2])
redis.call('EXPIRE', KEYS[10], ARGV[9])
return {1, ARGV[7]}
`

function idempotencyKey(sessionId: TTYSessionId, ownerUserId: string, key: string): string {
  return `tty:admission:idempotency:${ownerUserId}:${sessionId}:${key}`
}

function jobKey(executionId: TTYExecutionId): string {
  return `tty:job:${executionId}`
}

function sessionKey(sessionId: TTYSessionId, suffix: string): string {
  return `tty:session:${sessionId}:${suffix}`
}

export class TTYExecutionAdmission {
  constructor(
    private readonly redis: Redis,
    private readonly dependencies: TTYAdmissionDependencies,
  ) {}

  async admit(args: {
    readonly session: InternalTTYSession
    readonly rawInput: RawTerminalInput
    readonly kind: TTYExecutionKind
    readonly idempotencyKey: string
  }): Promise<TTYAdmissionResult> {
    const argv = parseTTYRawInputToArgv(args.rawInput)
    if (argv.length === 0) return { admitted: false, reason: 'input_rejected' }
    const authorization = await this.dependencies.authorize({
      userId: args.session.ownerUserId,
      rawInput: args.rawInput,
      kind: args.kind,
    })
    if (!authorization.allowed) return { admitted: false, reason: 'authorization_required' }

    const now = (this.dependencies.now ?? (() => new Date()))()
    const executionId = (this.dependencies.executionId ?? createTTYExecutionId)()
    const job: TTYQueuedJob = {
      executionId,
      sessionId: args.session.sessionId,
      ownerUserId: args.session.ownerUserId,
      kind: args.kind,
      status: 'queued',
      createdAt: now.toISOString(),
      admittedAt: now.toISOString(),
      authorizationScopeId: authorization.scopeId,
      argv,
      resource: {
        maxExecutionDurationMs: args.session.limits.maxExecutionDurationMs,
        maxOutputBytes: args.session.limits.maxOutputBytesPerExecution,
      },
    }
    const serialized = JSON.stringify({ job, fingerprint: args.rawInput })
    const idempotency = idempotencyKey(args.session.sessionId, args.session.ownerUserId, args.idempotencyKey)
    const result = (await this.redis.eval(
      RESERVE_JOB_SCRIPT,
      [
        idempotency,
        jobKey(executionId),
        sessionKey(args.session.sessionId, 'queue-depth'),
        sessionKey(args.session.sessionId, 'active-executions'),
        sessionKey(args.session.sessionId, 'exec-window'),
        sessionKey(args.session.sessionId, 'terminal'),
        sessionKey(args.session.sessionId, 'core'),
        sessionKey(args.session.sessionId, 'status'),
        sessionKey(args.session.sessionId, 'jobs'),
        sessionKey(args.session.sessionId, 'idempotencies'),
      ],
      [
        executionId,
        String(JOB_TTL_SECONDS),
        String(now.getTime()),
        String(args.session.limits.maxQueueDepth),
        String(args.session.limits.maxConcurrentExecutionsPerSession),
        String(args.session.limits.maxExecutionsPerMinute),
        JSON.stringify(job),
        serialized,
        String(IDEMPOTENCY_TTL_SECONDS),
      ],
    )) as [number, string]

    if (result[0] === 2) {
      const stored = JSON.parse(result[1]) as { job: TTYQueuedJob; fingerprint: string }
      if (stored.fingerprint !== args.rawInput) return { admitted: false, reason: 'input_rejected' }
      const existing = stored.job
      if (existing.ownerUserId !== args.session.ownerUserId || existing.sessionId !== args.session.sessionId)
        return { admitted: false, reason: 'input_rejected' }
      return { admitted: true, job: existing, duplicate: true }
    }
    if (result[0] === 0) {
      const reason = result[1]
      if (
        reason === 'session_terminated' ||
        reason === 'concurrency_limit_exceeded' ||
        reason === 'rate_limited' ||
        reason === 'queue_full'
      ) {
        return { admitted: false, reason }
      }
      return { admitted: false, reason: 'internal_error' }
    }
    return { admitted: true, job, duplicate: false }
  }
}
