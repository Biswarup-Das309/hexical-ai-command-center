/**
 * ============================================================================
 * HEXICAL AI — ADVANCED TTY SANDBOX — PHASE 1.3 SESSION STORE
 * ============================================================================
 * Server-only. Owns TTY session lifecycle and the trusted usage counters
 * tty-policy.ts's evaluateExecutionPolicy() consumes as InternalTTYSession
 * .usage. This module does NOT decide policy (allow/deny) and does NOT
 * execute anything — no shell, no child_process, no container/VM code.
 * "Policy decides, store records" — the same decides/does split this
 * codebase already uses for planner.ts vs executor.ts.
 *
 * SOURCE OF TRUTH: Upstash Redis only. No in-memory Map, no per-instance
 * cache of mutable state — every read/write goes to Redis, so this is safe
 * across any number of concurrent serverless/Vercel instances. The `Redis`
 * client is injected (constructor param), mirroring the exact dependency-
 * injection pattern lib/hexical/authorization.ts already uses for
 * `verifyAuthorization({ supabase, redis, ... })` — this module has no
 * global singleton of its own and does not instantiate a client.
 *
 * BROWSER-WRITE BOUNDARY: this module is imported only from server code
 * (future API routes / server actions), never from a 'use client' file.
 * No public method accepts a raw partial-session or partial-usage object
 * to merge in — every mutation is a specific, narrow, server-computed
 * operation (touch, terminate, recordExecutionStarted, ...). A hypothetical
 * future API route therefore cannot pass client JSON through into a
 * trusted field even by accident, because there is no method whose shape
 * would let it.
 *
 * OWNERSHIP ISOLATION: every read/mutate method that targets an existing
 * session requires the caller's own userId and treats an owner mismatch
 * IDENTICALLY to "session not found" (returns null / acknowledged: false)
 * — never a distinct error — so a caller can never use response shape to
 * enumerate whether a session exists or belongs to someone else. This
 * mirrors the same defense-in-depth principle already stated in
 * tty-policy.ts's evaluateExecutionPolicy step 2.
 *
 * LAZY, SELF-HEALING EXPIRATION (no reaper/cron in this phase — none
 * requested): every read/touch path checks, on the fly:
 *   (a) has an explicit "terminal latch" already been set for this
 *       session (see below)?
 *   (b) has wall-clock time since creation exceeded limits
 *       .maxSessionDurationMs (absolute cap)?
 *   (c) has the session's own idle-TTL'd status key vanished from Redis
 *       (idle cap, enforced natively by Redis TTL)?
 * The first true condition encountered wins, and — for (b)/(c) — the
 * store LATCHES the terminal state right then, so the discovery is
 * permanent rather than needing to be rediscovered on every future call.
 *
 * TERMINAL LATCH — "cannot be revived": a session becomes permanently
 * non-revivable via a single `SET ... NX` on a dedicated
 * `...:terminal` key. NX is atomic: only the first caller to set it
 * succeeds, so concurrent terminate/expire attempts from different
 * instances can never race into an inconsistent state, and no other
 * method in this file ever overwrites or deletes that key once set
 * (its own TTL is the only thing that ever removes it). Every mutating
 * method checks for this key's presence BEFORE acting, and a JSON
 * "status" field elsewhere in Redis is never treated as authoritative
 * over it — so even a stale/racing write to the status key can never
 * resurrect a session whose terminal key exists.
 *
 * DETERMINISTIC KEYS (sessionId is a TTYSessionId; userId is the trusted,
 * already-resolved owner id):
 *   tty:session:{sessionId}:core             JSON, immutable after create.
 *                                             TTL = maxSessionDurationMs
 *                                             (absolute session cap —
 *                                             Redis itself deletes it).
 *   tty:session:{sessionId}:status            JSON {status,lastActiveAt}.
 *                                             TTL = maxSessionIdleMs,
 *                                             refreshed on every touch.
 *                                             Its disappearance IS the
 *                                             idle-timeout signal.
 *   tty:session:{sessionId}:terminal          JSON {status,reason,
 *                                             terminatedAt}. Written once
 *                                             via SET NX. TTL = fixed
 *                                             audit-retention constant,
 *                                             independent of session
 *                                             limits.
 *   tty:session:{sessionId}:active-executions Integer counter (INCR/DECR,
 *                                             floor 0). TTL = fixed
 *                                             backstop constant, refreshed
 *                                             on every mutation; also
 *                                             explicitly deleted on
 *                                             terminate.
 *   tty:session:{sessionId}:queue-depth       Same shape as above.
 *   tty:session:{sessionId}:exec-window       Sorted set, member =
 *                                             executionId, score = start
 *                                             time (ms). Pruned to the
 *                                             trailing 60s on every read
 *                                             via ZREMRANGEBYSCORE, then
 *                                             ZCARD for the count —
 *                                             matches the "executions in
 *                                             the last minute" naming
 *                                             exactly. TTL = same fixed
 *                                             backstop constant.
 *   tty:user:{userId}:sessions                Redis SET of sessionIds
 *                                             owned by userId. No TTL
 *                                             (durable index); staleness
 *                                             is corrected lazily by
 *                                             countActiveSessionsForUser,
 *                                             which prunes entries whose
 *                                             session is no longer live.
 *
 * RACE-SAFETY DESIGN CHOICE: this module deliberately builds every
 * atomicity guarantee from single-command Redis primitives (SET NX,
 * INCR, DECR, ZADD, ZREMRANGEBYSCORE, ZCARD — each atomic individually)
 * rather than a Lua EVAL script or a MULTI/pipeline transaction. The one
 * property that genuinely requires cross-instance atomicity — "a
 * terminated/expired session can never be revived" — is achieved via the
 * SET-NX terminal latch above, which is sufficient on its own without
 * needing a broader transaction. Usage counters (active executions,
 * queue depth) are read via GET immediately before a policy decision and
 * mutated via INCR/DECR immediately after — the same soft-consistency,
 * TOCTOU-tolerant posture this codebase already accepts for its other
 * usage counters (see RATE_LIMITS / MESSAGE_QUOTA_LIMITS in
 * lib/hexical/types.ts), not a correctness gap introduced by this file.
 * ============================================================================
 */

import type { Redis } from '@upstash/redis'

import { VALID_TIERS, type Tier } from '@/lib/hexical/types'

import {
  createTTYSessionId,
  type TTYSessionId,
  type TTYExecutionId,
  type TTYPrincipal,
  type TTYSessionStatus,
  type TTYSession,
  type InternalTTYSession,
  type TTYResourceLimits,
  type TTYResourceUsageSnapshot,
  type TTYTerminationReason,
  type TTYTerminationResult
} from './tty-types'
import { ttyExecutionJobKey, ttyWorkerActiveLeasesKey, ttyWorkerActiveLeaseIndexKey, ttyWorkerLeaseIndexMember } from './tty-worker-keys'
import { parseTTYWorkerId, type TTYLeaseId, type TTYWorkerExecutionMetadata } from './tty-worker-types'

// ============================================================================
// 1. CONSTANTS
// ============================================================================

const SESSION_KEY_PREFIX = 'tty:session:'
const USER_INDEX_KEY_PREFIX = 'tty:user:'

/** Sliding window width for "executions in the last minute" — matches the
 * field name in TTYResourceUsageSnapshot exactly. */
const EXEC_WINDOW_MS = 60_000

/** Audit retention for a terminal record, independent of any session's own
 * duration limit — termination is a fact worth keeping inspectable for a
 * bounded window after the session itself is gone. */
const TERMINAL_RECORD_RETENTION_SECS = 24 * 60 * 60

/** Backstop TTL for the ephemeral usage-counter keys. The correct/expected
 * cleanup path is explicit (terminateSession's cleanup deletes these
 * immediately); this TTL only protects against a session whose terminate
 * path never ran for some reason. Deliberately generous and decoupled
 * from a session's own idle/duration limits to avoid an extra Redis read
 * on every single accounting call. */
const EXECUTION_COUNTER_TTL_SECS = 24 * 60 * 60

// ============================================================================
// 2. ERRORS / LOGGING
// ============================================================================

/** Thrown only by createSession, for genuine infrastructure failures or a
 * (practically impossible with UUIDv4) session id collision — cases where
 * there is no safe "fail closed to null" return, since creation must
 * either produce a definite session or the caller needs to know it
 * didn't. Every other public method fails closed to null/false instead of
 * throwing; see the file banner. */
export class TTYSessionStoreError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'TTYSessionStoreError'
  }
}

export interface TTYSessionStoreLogger {
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

const NOOP_LOGGER: TTYSessionStoreLogger = { warn: () => {}, error: () => {} }

// ============================================================================
// 3. PERSISTED RECORD SHAPES (internal storage detail — not exported; the
//    public surface only ever returns InternalTTYSession/TTYResourceUsage
//    Snapshot from tty-types.ts)
// ============================================================================

interface PersistedCoreRecord {
  readonly sessionId: TTYSessionId
  readonly ownerUserId: string
  readonly tier: Tier
  readonly createdAt: string
  readonly limits: TTYResourceLimits
}

interface PersistedStatusRecord {
  readonly status: TTYSessionStatus
  readonly lastActiveAt: string
}

interface PersistedTerminalRecord {
  readonly status: Extract<TTYSessionStatus, 'terminated' | 'expired'>
  readonly reason: TTYTerminationReason
  readonly terminatedAt: string
}

// ============================================================================
// 4. PUBLIC INPUT TYPES
// ============================================================================

export interface TTYSessionCreateInput {
  readonly principal: TTYPrincipal
  /** Already resolved by the caller (tty-policy.ts's
   * evaluateSessionCreationPolicy / a future ResolveTTYResourceLimits
   * implementation) — this store persists limits, it does not decide
   * them. */
  readonly limits: TTYResourceLimits
  /** Optional, for testability / idempotent replay. Defaults to a fresh
   * createTTYSessionId(). */
  readonly sessionId?: TTYSessionId
}

// ============================================================================
// 5. SESSION STORE
// ============================================================================

export class TTYSessionStore {
  private readonly redis: Redis
  private readonly logger: TTYSessionStoreLogger

  constructor(redis: Redis, options?: { logger?: TTYSessionStoreLogger }) {
    this.redis = redis
    this.logger = options?.logger ?? NOOP_LOGGER
  }

  // --------------------------------------------------------------------
  // Key builders
  // --------------------------------------------------------------------

  private coreKey(id: TTYSessionId): string {
    return `${SESSION_KEY_PREFIX}${id}:core`
  }
  private statusKey(id: TTYSessionId): string {
    return `${SESSION_KEY_PREFIX}${id}:status`
  }
  private terminalKey(id: TTYSessionId): string {
    return `${SESSION_KEY_PREFIX}${id}:terminal`
  }
  private activeExecKey(id: TTYSessionId): string {
    return `${SESSION_KEY_PREFIX}${id}:active-executions`
  }
  private queueDepthKey(id: TTYSessionId): string {
    return `${SESSION_KEY_PREFIX}${id}:queue-depth`
  }
  private execWindowKey(id: TTYSessionId): string {
    return `${SESSION_KEY_PREFIX}${id}:exec-window`
  }
  private userIndexKey(userId: string): string {
    return `${USER_INDEX_KEY_PREFIX}${userId}:sessions`
  }

  // --------------------------------------------------------------------
  // Low-level helpers
  // --------------------------------------------------------------------

  private toTtlSeconds(ms: number): number {
    return Math.max(1, Math.ceil(ms / 1000))
  }

  private parseNonNegativeInt(raw: number | null): number {
    if (raw === null) return 0
    return Number.isFinite(raw) && raw > 0 ? raw : 0
  }

  private isValidPrincipalShape(principal: TTYPrincipal): boolean {
    const userId = principal.userId?.trim()
    if (!userId || userId.length > 200) return false
    return VALID_TIERS.includes(principal.tier)
  }

  private async readCore(sessionId: TTYSessionId): Promise<PersistedCoreRecord | null> {
    try {
      return await this.redis.get<PersistedCoreRecord>(this.coreKey(sessionId))
    } catch (error) {
      this.logger.error('Failed to read TTY session core record.', { sessionId, error })
      return null
    }
  }

  private async readStatusRecord(sessionId: TTYSessionId): Promise<PersistedStatusRecord | null> {
    try {
      return await this.redis.get<PersistedStatusRecord>(this.statusKey(sessionId))
    } catch (error) {
      this.logger.error('Failed to read TTY session status record.', { sessionId, error })
      return null
    }
  }

  private async readTerminalRecord(sessionId: TTYSessionId): Promise<PersistedTerminalRecord | null> {
    try {
      return await this.redis.get<PersistedTerminalRecord>(this.terminalKey(sessionId))
    } catch (error) {
      this.logger.error('Failed to read TTY session terminal record.', { sessionId, error })
      return null
    }
  }

  private async writeStatusRecord(
    sessionId: TTYSessionId,
    record: PersistedStatusRecord,
    idleMs: number
  ): Promise<void> {
    try {
      await this.redis.set(this.statusKey(sessionId), JSON.stringify(record), {
        ex: this.toTtlSeconds(idleMs)
      })
    } catch (error) {
      this.logger.error('Failed to write TTY session status record.', { sessionId, error })
    }
  }

  private async isTerminal(sessionId: TTYSessionId): Promise<boolean> {
    return (await this.readTerminalRecord(sessionId)) !== null
  }

  /**
   * Atomically latches a session as permanently terminal via SET NX. If
   * another instance already won the race, reads back and returns ITS
   * record rather than overwriting — terminateSession()/lazy-expiration
   * are therefore idempotent under concurrent callers. Runs best-effort
   * cleanup of the ephemeral counter keys and the user-session index
   * whenever this call is the one that actually wins the latch.
   */
  private async latchTerminal(
    sessionId: TTYSessionId,
    ownerUserId: string,
    status: Extract<TTYSessionStatus, 'terminated' | 'expired'>,
    reason: TTYTerminationReason
  ): Promise<{ latched: boolean; record: PersistedTerminalRecord }> {
    const record: PersistedTerminalRecord = { status, reason, terminatedAt: new Date().toISOString() }

    let result: string | null
    try {
      result = await this.redis.set(this.terminalKey(sessionId), JSON.stringify(record), {
        nx: true,
        ex: TERMINAL_RECORD_RETENTION_SECS
      })
    } catch (error) {
      // Fail closed: treat as terminated even though we could not confirm
      // the latch persisted — never fail open into "still usable" here.
      this.logger.error('Failed to latch TTY session terminal state.', { sessionId, error })
      return { latched: false, record }
    }

    const latched = result !== null
    if (latched) {
      await this.cleanupAfterTerminal(sessionId, ownerUserId)
      return { latched, record }
    }

    const existing = await this.readTerminalRecord(sessionId)
    return { latched: false, record: existing ?? record }
  }

  private async cleanupAfterTerminal(sessionId: TTYSessionId, ownerUserId: string): Promise<void> {
    // Deliberately does NOT delete the :core record — it remains
    // inspectable/auditable until its own absolute TTL (maxSessionDurationMs
    // from creation) naturally expires it.
    try {
      const jobIds = await this.redis.smembers(this.jobsKey(sessionId)).catch(() => [] as string[])
      const idempotencyKeys = await this.redis.smembers(this.idempotenciesKey(sessionId)).catch(() => [] as string[])
      const workerLeases = (await Promise.all(jobIds.map(async jobId => {
        const raw = await this.redis.get<unknown>(`tty:job:${jobId}`).catch(() => null)
        return raw === null ? null : workerLeaseFromRawJob(raw, sessionId)
      }))).filter((lease): lease is TTYWorkerExecutionMetadata & { readonly workerId: NonNullable<TTYWorkerExecutionMetadata['workerId']> } => lease !== null && lease.workerId !== null)
      await Promise.all([
        this.redis.del(this.activeExecKey(sessionId)),
        this.redis.del(this.queueDepthKey(sessionId)),
        this.redis.del(this.execWindowKey(sessionId)),
        this.redis.del(this.statusKey(sessionId)),
        this.redis.del(this.jobsKey(sessionId)),
        this.redis.del(this.idempotenciesKey(sessionId)),
        ...(jobIds.length > 0 ? [this.redis.del(...jobIds.map(id => `tty:job:${id}`))] : []),
        ...(idempotencyKeys.length > 0 ? [this.redis.del(...idempotencyKeys)] : []),
        this.redis.srem(this.userIndexKey(ownerUserId), sessionId),
        ...workerLeases.flatMap(lease => [
          this.redis.srem(ttyWorkerActiveLeasesKey(lease.workerId), lease.executionId),
          this.redis.srem(ttyWorkerActiveLeaseIndexKey(), ttyWorkerLeaseIndexMember(lease.workerId, lease.executionId))
        ])
      ])
    } catch (error) {
      this.logger.warn(
        'TTY session cleanup after termination encountered an error; counters may linger until their backstop TTL.',
        { sessionId, error }
      )
    }
  }

  private async incrWithBackstopTtl(key: string): Promise<number> {
    const value = await this.redis.incr(key)
    await this.redis.expire(key, EXECUTION_COUNTER_TTL_SECS)
    return value
  }

  /** DECR floored at 0 — self-corrects if a decrement ever outpaces its
   * matching increment (e.g. a missed/duplicate call), rather than
   * letting the counter go permanently negative. */
  private async decrFloor0(key: string): Promise<void> {
    const value = await this.redis.decr(key)
    if (value < 0) {
      await this.redis.set(key, 0)
    }
    await this.redis.expire(key, EXECUTION_COUNTER_TTL_SECS)
  }

  private jobsKey(id: TTYSessionId): string {
    return `${SESSION_KEY_PREFIX}${id}:jobs`
  }

  private idempotenciesKey(id: TTYSessionId): string {
    return `${SESSION_KEY_PREFIX}${id}:idempotencies`
  }

  private async countRecentExecutions(sessionId: TTYSessionId, nowMs: number): Promise<number> {
    const key = this.execWindowKey(sessionId)
    try {
      await this.redis.zremrangebyscore(key, 0, nowMs - EXEC_WINDOW_MS)
      return await this.redis.zcard(key)
    } catch (error) {
      this.logger.error('Failed to compute recent TTY execution count.', { sessionId, error })
      return 0
    }
  }

  private async isSessionLive(sessionId: TTYSessionId): Promise<boolean> {
    const [core, terminal] = await Promise.all([this.readCore(sessionId), this.readTerminalRecord(sessionId)])
    if (core === null || terminal !== null) return false
    return Date.now() - new Date(core.createdAt).getTime() <= core.limits.maxSessionDurationMs
  }

  // --------------------------------------------------------------------
  // Usage snapshot (trusted, server-computed — never accepts client input)
  // --------------------------------------------------------------------

  /**
   * `activeSessions` reflects the owner's total count of currently-live
   * sessions (all of them, not just this one) — the one field in
   * TTYResourceUsageSnapshot that is principal-scoped rather than
   * session-scoped. It mirrors what evaluateSessionCreationPolicy would
   * want as `currentActiveSessionCount` for this same user's NEXT session
   * creation; nothing in the current evaluateExecutionPolicy actually
   * gates on it (see tty-policy.ts's evaluateResourceLimits, which checks
   * only the other three fields) — it is populated here for accuracy and
   * observability regardless.
  */
  async getUsageSnapshot(sessionId: TTYSessionId, ownerUserId: string): Promise<TTYResourceUsageSnapshot> {
    const nowMs = Date.now()
    const core = await this.readCore(sessionId)
    if (core === null || core.ownerUserId !== ownerUserId) {
      return {
        activeSessions: 0,
        activeExecutionsInSession: 0,
        queueDepth: 0,
        executionsInLastMinute: 0,
        capturedAt: new Date(nowMs).toISOString()
      }
    }

    const [activeExecutionsRaw, queueDepthRaw, executionsInLastMinute, activeSessions] = await Promise.all([
      this.redis.get<number>(this.activeExecKey(sessionId)).catch(() => null),
      this.redis.get<number>(this.queueDepthKey(sessionId)).catch(() => null),
      this.countRecentExecutions(sessionId, nowMs),
      this.countActiveSessionsForUser(ownerUserId)
    ])

    return {
      activeSessions,
      activeExecutionsInSession: this.parseNonNegativeInt(activeExecutionsRaw),
      queueDepth: this.parseNonNegativeInt(queueDepthRaw),
      executionsInLastMinute,
      capturedAt: new Date(nowMs).toISOString()
    }
  }

  /** Counts + lazily prunes the owner's session index. Never trusts a
   * caller-supplied count anywhere else in this system — this is the one
   * authoritative computation of it. */
  async countActiveSessionsForUser(userId: string): Promise<number> {
    let memberIds: string[]
    try {
      memberIds = await this.redis.smembers(this.userIndexKey(userId))
    } catch (error) {
      this.logger.error('Failed to read TTY session index for user.', { userId, error })
      return 0
    }
    if (memberIds.length === 0) return 0

    const sessionIds = memberIds as TTYSessionId[]
    const liveFlags = await Promise.all(sessionIds.map(id => this.isSessionLive(id)))

    const staleIds = sessionIds.filter((_id, index) => !liveFlags[index])
    if (staleIds.length > 0) {
      this.redis.srem(this.userIndexKey(userId), ...staleIds).catch(error => {
        this.logger.warn('Failed to prune stale entries from TTY session index.', { userId, error })
      })
    }

    return liveFlags.filter(Boolean).length
  }

  // --------------------------------------------------------------------
  // Lifecycle: create / get / touch / terminate
  // --------------------------------------------------------------------

  /**
   * Creates a new session. `input.limits` is trusted as already resolved
   * by the caller (tty-policy.ts) — this store does not decide tier
   * ceilings. Throws TTYSessionStoreError on genuine infrastructure
   * failure or an (essentially impossible) session id collision; every
   * other method in this class fails closed to null/false instead.
   */
  async createSession(input: TTYSessionCreateInput): Promise<InternalTTYSession> {
    if (!this.isValidPrincipalShape(input.principal)) {
      throw new TTYSessionStoreError('Refusing to create a TTY session for a structurally invalid principal.')
    }

    const sessionId = input.sessionId ?? createTTYSessionId()
    const nowIso = new Date().toISOString()
    const core: PersistedCoreRecord = {
      sessionId,
      ownerUserId: input.principal.userId,
      tier: input.principal.tier,
      createdAt: nowIso,
      limits: input.limits
    }

    let created: string | null
    try {
      created = await this.redis.set(this.coreKey(sessionId), JSON.stringify(core), {
        nx: true,
        ex: this.toTtlSeconds(input.limits.maxSessionDurationMs)
      })
    } catch (error) {
      throw new TTYSessionStoreError('Failed to persist new TTY session core record.', error)
    }
    if (created === null) {
      throw new TTYSessionStoreError(`TTY session id collision for '${sessionId}'; refusing to overwrite.`)
    }

    await this.writeStatusRecord(sessionId, { status: 'active', lastActiveAt: nowIso }, input.limits.maxSessionIdleMs)

    try {
      await this.redis.sadd(this.userIndexKey(input.principal.userId), sessionId)
    } catch (error) {
      this.logger.warn('Failed to index new TTY session under its owner.', { sessionId, error })
    }

    const usage = await this.getUsageSnapshot(sessionId, input.principal.userId)

    return {
      sessionId,
      status: 'active',
      tier: input.principal.tier,
      createdAt: nowIso,
      lastActiveAt: nowIso,
      limits: input.limits,
      ownerUserId: input.principal.userId,
      usage
    }
  }

  /**
   * Loads a session, enforcing ownership and lazily discovering/latching
   * expiration. Returns null for: session never existed, session belongs
   * to a different owner (never distinguished from "not found"), or any
   * unexpected read failure. A session that IS terminated/expired is
   * still returned (with its real status) rather than null — tty-policy
   * .ts's own step 3 is what turns that into a 'session_terminated'
   * denial; collapsing it to null here would take that decision away
   * from the policy layer.
   */
  async getSession(sessionId: TTYSessionId, expectedOwnerUserId: string): Promise<InternalTTYSession | null> {
    const core = await this.readCore(sessionId)
    if (core === null || core.ownerUserId !== expectedOwnerUserId) {
      return null
    }

    const nowMs = Date.now()
    const exceededMaxDuration = nowMs - new Date(core.createdAt).getTime() > core.limits.maxSessionDurationMs

    let terminal = await this.readTerminalRecord(sessionId)

    if (terminal === null && exceededMaxDuration) {
      terminal = (await this.latchTerminal(sessionId, core.ownerUserId, 'expired', 'duration_limit_exceeded')).record
    }

    const statusRecord = terminal === null ? await this.readStatusRecord(sessionId) : null

    if (terminal === null && statusRecord === null) {
      // Idle-TTL'd status key is gone -> idle timeout, discovered lazily.
      terminal = (await this.latchTerminal(sessionId, core.ownerUserId, 'expired', 'idle_timeout')).record
    }

    const status: TTYSessionStatus = terminal?.status ?? statusRecord?.status ?? 'active'
    const lastActiveAt = statusRecord?.lastActiveAt ?? core.createdAt
    const usage = await this.getUsageSnapshot(sessionId, core.ownerUserId)

    return {
      sessionId,
      status,
      tier: core.tier,
      createdAt: core.createdAt,
      lastActiveAt,
      limits: core.limits,
      ownerUserId: core.ownerUserId,
      usage
    }
  }

  /**
   * Returns safe worker attribution for executions belonging to an owned
   * session. Lease tokens are intentionally omitted. The job record remains
   * the source of truth and the result is sorted for deterministic replay.
   */
  async getWorkerExecutionMetadata(
    sessionId: TTYSessionId,
    expectedOwnerUserId: string
  ): Promise<readonly TTYWorkerExecutionMetadata[]> {
    const session = await this.getSession(sessionId, expectedOwnerUserId)
    if (session === null) return []
    try {
      const jobIds = await this.redis.smembers(this.jobsKey(sessionId))
      const metadata = (await Promise.all(jobIds.map(async jobId => {
        const raw = await this.redis.get<unknown>(ttyExecutionJobKey(jobId as TTYExecutionId))
        return raw === null ? null : workerLeaseFromRawJob(raw, sessionId)
      }))).filter((item): item is TTYWorkerExecutionMetadata => item !== null)
      return metadata.sort((left, right) => left.executionId.localeCompare(right.executionId))
    } catch (error) {
      this.logger.error('Failed to read worker-aware TTY execution metadata.', { sessionId, error })
      return []
    }
  }

  /**
   * Records activity and refreshes the idle window. Returns null (never
   * revives) if the session doesn't exist, isn't owned by
   * `ownerUserId`, is already terminal, or has newly exceeded its
   * absolute duration cap (which this call itself latches before
   * returning null).
   */
  async touchSession(sessionId: TTYSessionId, ownerUserId: string): Promise<InternalTTYSession | null> {
    const core = await this.readCore(sessionId)
    if (core === null || core.ownerUserId !== ownerUserId) return null

    if (await this.isTerminal(sessionId)) return null

    const nowMs = Date.now()
    if (nowMs - new Date(core.createdAt).getTime() > core.limits.maxSessionDurationMs) {
      await this.latchTerminal(sessionId, ownerUserId, 'expired', 'duration_limit_exceeded')
      return null
    }

    const lastActiveAt = new Date(nowMs).toISOString()
    await this.writeStatusRecord(sessionId, { status: 'active', lastActiveAt }, core.limits.maxSessionIdleMs)

    const usage = await this.getUsageSnapshot(sessionId, ownerUserId)
    return {
      sessionId,
      status: 'active',
      tier: core.tier,
      createdAt: core.createdAt,
      lastActiveAt,
      limits: core.limits,
      ownerUserId,
      usage
    }
  }

  /**
   * Explicitly ends a session. Idempotent: calling this on an
   * already-terminal session returns `acknowledged: true` with the
   * ORIGINAL terminatedAt rather than erroring or re-latching. Returns
   * `acknowledged: false` only when there is nothing this caller is
   * entitled to terminate (session doesn't exist, or isn't owned by
   * `ownerUserId`).
   */
  async terminateSession(
    sessionId: TTYSessionId,
    ownerUserId: string,
    reason: TTYTerminationReason
  ): Promise<TTYTerminationResult> {
    const core = await this.readCore(sessionId)
    if (core === null || core.ownerUserId !== ownerUserId) {
      return { sessionId, acknowledged: false }
    }

    const existing = await this.readTerminalRecord(sessionId)
    if (existing !== null) {
      return { sessionId, acknowledged: true, terminatedAt: existing.terminatedAt }
    }

    const outcome = await this.latchTerminal(sessionId, ownerUserId, 'terminated', reason)
    return { sessionId, acknowledged: true, terminatedAt: outcome.record.terminatedAt }
  }

  // --------------------------------------------------------------------
  // Execution accounting (trusted server-only counters — see file banner
  // for the "policy decides, store records" trust boundary: these assume
  // sessionId was already validated by a getSession()/evaluateExecution
  // Policy() call earlier in the same request, and perform no independent
  // ownership check of their own)
  // --------------------------------------------------------------------

  /** Increments are guarded against reviving an already-terminal session's
   * counters (which cleanupAfterTerminal already deleted) — see the
   * decrement methods below for why they don't need the same guard. */
  async recordExecutionQueued(sessionId: TTYSessionId): Promise<void> {
    if (await this.isTerminal(sessionId)) {
      this.logger.warn('Ignored recordExecutionQueued for an already-terminal TTY session.', { sessionId })
      return
    }
    await this.incrWithBackstopTtl(this.queueDepthKey(sessionId))
  }

  async recordExecutionDequeued(sessionId: TTYSessionId): Promise<void> {
    // No terminal guard needed: decrFloor0 clamps at 0, so decrementing an
    // already-cleaned-up (deleted) counter is safe and self-correcting.
    await this.decrFloor0(this.queueDepthKey(sessionId))
  }

  async recordExecutionStarted(sessionId: TTYSessionId, executionId: TTYExecutionId): Promise<void> {
    if (await this.isTerminal(sessionId)) {
      this.logger.warn('Ignored recordExecutionStarted for an already-terminal TTY session.', { sessionId })
      return
    }
    const key = this.execWindowKey(sessionId)
    await Promise.all([
      this.incrWithBackstopTtl(this.activeExecKey(sessionId)),
      this.redis.zadd(key, { score: Date.now(), member: executionId })
    ])
    await this.redis.expire(key, EXECUTION_COUNTER_TTL_SECS)
  }

  async recordExecutionFinished(sessionId: TTYSessionId): Promise<void> {
    await this.decrFloor0(this.activeExecKey(sessionId))
  }
}

// ============================================================================
// 6. FACTORY (DI-style construction, consistent with createSupabaseClient
//    elsewhere in this codebase)
// ============================================================================

export function createTTYSessionStore(redis: Redis, options?: { logger?: TTYSessionStoreLogger }): TTYSessionStore {
  return new TTYSessionStore(redis, options)
}

// ============================================================================
// 7. BROWSER-SAFE PROJECTION
// ============================================================================

/** Strips ownerUserId/usage down to the browser-safe TTYSession shape.
 * Reinforces, at the type level, the "browser-safe vs internal" split
 * tty-types.ts's file banner requires — a future API route should send
 * this, never the raw InternalTTYSession, to a client. */
export function toBrowserSafeSession(session: InternalTTYSession): TTYSession {
  const { ownerUserId: _ownerUserId, usage: _usage, ...browserSafe } = session
  return browserSafe
}

function workerLeaseFromRawJob(raw: unknown, sessionId: TTYSessionId): TTYWorkerExecutionMetadata | null {
  try {
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const executionId = typeof record.executionId === 'string' ? record.executionId as TTYExecutionId : null
    const status = record.status
    if (executionId === null || (status !== 'queued' && status !== 'leased' && status !== 'abandoned')) return null
    if (status === 'queued' || status === 'abandoned') {
      return { executionId, sessionId, workerId: null, leaseId: null, claimedAt: null, renewedAt: null, leaseAgeMs: null, executionState: status }
    }
    if (typeof record.lease !== 'object' || record.lease === null) return null
    const lease = record.lease as Record<string, unknown>
    const workerId = typeof lease.workerId === 'string' ? parseTTYWorkerId(lease.workerId) : null
    const token = typeof lease.token === 'string' ? lease.token : null
    const claimedAtMs = typeof lease.claimedAtMs === 'number' ? lease.claimedAtMs : null
    const renewedAtMs = typeof lease.renewedAtMs === 'number' ? lease.renewedAtMs : claimedAtMs
    if (workerId === null || token === null || claimedAtMs === null || renewedAtMs === null) return null
    return {
      executionId,
      sessionId,
      workerId,
      leaseId: (typeof lease.leaseId === 'string' ? lease.leaseId : token) as TTYLeaseId,
      claimedAt: new Date(claimedAtMs).toISOString(),
      renewedAt: new Date(renewedAtMs).toISOString(),
      leaseAgeMs: Math.max(0, Date.now() - claimedAtMs),
      executionState: 'leased'
    }
  } catch {
    return null
  }
}
