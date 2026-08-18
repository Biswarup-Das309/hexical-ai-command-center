/**
 * Worker-local manager for persistent PTY sessions.
 *
 * The manager owns the live PTYs, fences them with a renewable Redis lease,
 * writes a durable session transcript, and fails a previously attached
 * session closed rather than silently replacing it with a fresh shell after
 * worker loss. A fresh shell is not a valid recovery of cwd, jobs, or shell
 * state.
 */

import { TTY_EXECUTION_HISTORY_RETENTION_SECONDS } from './tty-execution-retention'
import type { TTYOutputStreamManager } from './tty-output-stream'
import {
  createTTYPersistentExecutionMarker,
  serializeTTYPersistentShellExecution,
  TTYPersistentExecutionProtocolDecoder,
} from './tty-persistent-execution-protocol'
import type { TTYPersistentSessionHandle } from './tty-persistent-runtime'
import type { TTYProcessTelemetrySnapshot } from './tty-process-telemetry'
import type { TTYRuntimeStore as Redis } from './tty-runtime-store'
import type { TTYSessionControlEntry, TTYSessionControlHandler } from './tty-session-control'
import type { TTYSessionTranscriptData, TTYSessionTranscriptManager } from './tty-session-transcript'
import type { InternalTTYSession, TTYExecutionId, TTYSessionId, TTYTerminationResult } from './tty-types'
import {
  ttyPersistentExecutionActiveIndexKey,
  ttyPersistentSessionIndexKey,
  ttySessionActiveExecutionKey,
  ttySessionRuntimeHistoryKey,
  ttySessionRuntimeOutputOffsetKey,
  ttySessionRuntimeKey,
} from './tty-worker-keys'
import type { TTYWorkerId } from './tty-worker-types'

const DEFAULT_LEASE_TTL_MS = 30_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000
const MAX_COMPLETED_COMMANDS_PER_SESSION = 1_024
const INPUT_TELEMETRY_INTERVAL_MS = 1_000

const CLAIM_RUNTIME_SCRIPT = `
-- hexical:tty-session-runtime-claim
local existing = redis.call('GET', KEYS[1])
if existing then return {0, existing} end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return {1, ARGV[1]}
`

const PROMOTE_RUNTIME_SCRIPT = `
-- hexical:tty-session-runtime-promote
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then return 0 end
local current = cjson.decode(currentRaw)
if current.runtimeId ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[4], 'EX', ARGV[5])
return 1
`

const RENEW_RUNTIME_SCRIPT = `
-- hexical:tty-session-runtime-renew
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then return 0 end
local current = cjson.decode(currentRaw)
if current.runtimeId ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`

const RELEASE_RUNTIME_SCRIPT = `
-- hexical:tty-session-runtime-release
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then return 1 end
local current = cjson.decode(currentRaw)
if current.runtimeId ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`

const CLAIM_ACTIVE_EXECUTION_SCRIPT = `
-- hexical:tty-session-active-execution-claim
local existing = redis.call('GET', KEYS[1])
if existing then return {0, existing} end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('SADD', KEYS[2], ARGV[3])
return {1, ARGV[1]}
`

const UPDATE_ACTIVE_EXECUTION_SCRIPT = `
-- hexical:tty-session-active-execution-update
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then return 0 end
local current = cjson.decode(currentRaw)
if current.sessionId ~= ARGV[1] or current.executionId ~= ARGV[2] or current.token ~= ARGV[3] then return 0 end
redis.call('SET', KEYS[1], ARGV[4], 'EX', ARGV[5])
redis.call('SADD', KEYS[2], ARGV[1])
return 1
`

const RELEASE_ACTIVE_EXECUTION_SCRIPT = `
-- hexical:tty-session-active-execution-release
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then
  redis.call('SREM', KEYS[2], ARGV[1])
  return 1
end
local current = cjson.decode(currentRaw)
if current.sessionId ~= ARGV[1] or current.executionId ~= ARGV[2] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[2], ARGV[1])
return 1
`

export interface TTYPersistentSessionLifecycleStore {
  getSession(sessionId: TTYSessionId, expectedOwnerUserId: string): Promise<InternalTTYSession | null>
  touchSession(sessionId: TTYSessionId, ownerUserId: string): Promise<InternalTTYSession | null>
  terminateSession(
    sessionId: TTYSessionId,
    ownerUserId: string,
    reason: 'resource_limit_exceeded' | 'runtime_exited' | 'system_shutdown',
  ): Promise<TTYTerminationResult>
}

export interface TTYPersistentSessionManagerLogger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void
  error(event: string, fields?: Readonly<Record<string, unknown>>): void
}

export interface TTYPersistentSessionManagerOptions {
  readonly leaseTtlMs?: number
  readonly heartbeatIntervalMs?: number
  readonly maxCompletedCommandsPerSession?: number
  readonly now?: () => Date
  readonly setInterval?: (handler: () => void, timeoutMs: number) => unknown
  readonly clearInterval?: (handle: unknown) => void
  readonly logger?: TTYPersistentSessionManagerLogger
  /** Durable execution output authority for framed PTY bytes. */
  readonly executionOutput?: Pick<TTYOutputStreamManager, 'appendOutput' | 'appendMetric'>
  /** How often a journal-backed PTY is polled for new bytes. */
  readonly journalPollIntervalMs?: number
  /** How often the worker publishes authoritative process-tree samples. */
  readonly telemetryIntervalMs?: number
}

interface RuntimeLeaseRecord {
  readonly version: 1
  readonly state: 'provisioning' | 'active'
  readonly sessionId: TTYSessionId
  readonly ownerUserId: string
  readonly workerId: TTYWorkerId
  readonly runtimeId: string
  readonly startedAt: string
  readonly leaseExpiresAt: string
  readonly pid?: number
  readonly cwd?: string
}

interface RuntimeHistoryRecord {
  readonly version: 1
  readonly sessionId: TTYSessionId
  readonly ownerUserId: string
  readonly workerId: TTYWorkerId
  readonly runtimeId: string
  readonly attachedAt: string
}

export type TTYPersistentExecutionRecordState = 'preparing' | 'dispatched' | 'running' | 'completed'

export interface TTYPersistentExecutionRecord {
  readonly version: 1
  readonly sessionId: TTYSessionId
  readonly executionId: TTYExecutionId
  readonly ownerUserId: string
  readonly workerId: TTYWorkerId
  readonly runtimeId: string
  readonly token: string
  readonly state: TTYPersistentExecutionRecordState
  readonly startedAt: string
  readonly updatedAt: string
  readonly pid: number
  readonly cwd: string
  readonly exitCode?: number | null
  readonly signal?: NodeJS.Signals | null
  readonly error?: string
}

export interface TTYPersistentRuntimeSessionInput {
  readonly sessionId: TTYSessionId
  readonly ownerUserId: string
  readonly workerId: TTYWorkerId
  readonly env?: Readonly<Record<string, string>>
  readonly columns?: number
  readonly rows?: number
  readonly startedAt?: string
  readonly onData?: (data: string) => void
  readonly onExit?: (event: { readonly exitCode: number; readonly signal?: number }) => void
}

export type TTYPersistentRuntimeHandle = Pick<
  TTYPersistentSessionHandle,
  'metadata' | 'write' | 'resize' | 'onData' | 'onExit' | 'terminate'
> & {
  /** Reconnectable backends detach only the client attachment on worker loss. */
  readonly detach?: () => Promise<void>
  /** Read bytes appended while no worker attachment was present. */
  readonly replayOutput?: (afterOffset?: number) => Promise<{ readonly data: string; readonly nextOffset: number }>
}

export interface TTYPersistentRuntimeBackend {
  createSession(input: TTYPersistentRuntimeSessionInput): Promise<TTYPersistentRuntimeHandle>
  recoverSession?(input: TTYPersistentRuntimeSessionInput): Promise<TTYPersistentRuntimeHandle | null>
  getSession(sessionId: TTYSessionId, ownerUserId: string): TTYPersistentRuntimeHandle | null
  hasPersistentSession?(sessionId: TTYSessionId): Promise<boolean>
  getProcessTelemetry?(sessionId: TTYSessionId, ownerUserId: string): Promise<TTYProcessTelemetrySnapshot | null>
}

export interface TTYPersistentExecutionExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: string
}

export interface TTYPersistentExecutionMetadata {
  readonly handleId: string
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  readonly workerId: TTYWorkerId
  readonly pid: number
  readonly cwd: string
  readonly startedAt: string
}

/**
 * A single admitted argv command running inside the session's durable shell.
 * Callers receive only framed command output; protocol frames and raw stdin
 * are deliberately excluded from browser-visible replay data.
 */
export interface TTYPersistentExecutionHandle {
  readonly metadata: TTYPersistentExecutionMetadata
  readonly exit: Promise<TTYPersistentExecutionExit>
  onData(callback: (data: Uint8Array) => void): () => void
  interrupt(): Promise<void>
  forceTerminate(): Promise<void>
  dispose(): void
  readonly durableOutput?: boolean
  finalize?(): Promise<void>
}

export interface TTYPersistentExecutionStartInput {
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  readonly ownerUserId: string
  readonly argv: readonly [string, ...string[]]
}

interface ManagedExecution {
  readonly token: string
  readonly metadata: TTYPersistentExecutionMetadata
  readonly exit: Promise<TTYPersistentExecutionExit>
  readonly resolveExit: (value: TTYPersistentExecutionExit) => void
  readonly listeners: Set<(data: Uint8Array) => void>
  readonly bufferedOutput: Uint8Array[]
  started: boolean
  completed: boolean
  disposed: boolean
  activeRecordFinalized: boolean
}

interface ManagedSession {
  readonly sessionId: TTYSessionId
  readonly ownerUserId: string
  readonly runtimeId: string
  readonly handle: TTYPersistentRuntimeHandle
  readonly maxOutputBytes: number
  outputBytesSinceInput: number
  outputLimitReached: boolean
  lastInputTelemetryAtMs: number
  outputReady: boolean
  bufferedOutput: string[]
  readonly protocol: TTYPersistentExecutionProtocolDecoder
  activeExecution: ManagedExecution | null
  outputTail: Promise<void>
  cleanupPromise: Promise<void> | null
  fencePromise: Promise<void> | null
  fenced: boolean
  readonly journalBacked: boolean
  journalReplayInFlight: boolean
  journalTimer: unknown
}

const NOOP_LOGGER: TTYPersistentSessionManagerLogger = { info: () => {}, warn: () => {}, error: () => {} }

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function responseCode(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'number' ? raw : typeof raw === 'string' && /^-?\d+$/.test(raw) ? Number(raw) : 0
}

function parseRuntimeLease(value: unknown): RuntimeLeaseRecord | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (
      record.version !== 1 ||
      (record.state !== 'provisioning' && record.state !== 'active') ||
      typeof record.sessionId !== 'string' ||
      typeof record.ownerUserId !== 'string' ||
      typeof record.ownerUserId !== 'string' ||
      typeof record.workerId !== 'string' ||
      typeof record.runtimeId !== 'string' ||
      typeof record.startedAt !== 'string' ||
      typeof record.leaseExpiresAt !== 'string'
    )
      return null
    if (
      record.pid !== undefined &&
      (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0)
    )
      return null
    if (record.cwd !== undefined && typeof record.cwd !== 'string') return null
    return record as unknown as RuntimeLeaseRecord
  } catch {
    return null
  }
}

function parseActiveExecutionRecord(value: unknown): TTYPersistentExecutionRecord | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (
      record.version !== 1 ||
      typeof record.sessionId !== 'string' ||
      typeof record.executionId !== 'string' ||
      typeof record.ownerUserId !== 'string' ||
      typeof record.workerId !== 'string' ||
      typeof record.runtimeId !== 'string' ||
      typeof record.token !== 'string' ||
      !['preparing', 'dispatched', 'running', 'completed'].includes(String(record.state)) ||
      typeof record.startedAt !== 'string' ||
      typeof record.updatedAt !== 'string' ||
      typeof record.pid !== 'number' ||
      typeof record.cwd !== 'string'
    )
      return null
    return Object.freeze({
      version: 1,
      sessionId: record.sessionId as TTYSessionId,
      executionId: record.executionId as TTYExecutionId,
      ownerUserId: record.ownerUserId as string,
      workerId: record.workerId as TTYWorkerId,
      runtimeId: record.runtimeId as string,
      token: record.token as string,
      state: record.state as TTYPersistentExecutionRecordState,
      startedAt: record.startedAt as string,
      updatedAt: record.updatedAt as string,
      pid: record.pid as number,
      cwd: record.cwd as string,
      ...(record.exitCode === null || typeof record.exitCode === 'number'
        ? { exitCode: record.exitCode as number | null }
        : {}),
      ...(record.signal === null || typeof record.signal === 'string'
        ? { signal: record.signal as NodeJS.Signals | null }
        : {}),
      ...(typeof record.error === 'string' ? { error: record.error } : {}),
    })
  } catch {
    return null
  }
}

function parseRuntimeHistory(value: unknown): RuntimeHistoryRecord | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (
      record.version !== 1 ||
      typeof record.sessionId !== 'string' ||
      typeof record.ownerUserId !== 'string' ||
      typeof record.workerId !== 'string' ||
      typeof record.runtimeId !== 'string' ||
      typeof record.attachedAt !== 'string'
    )
      return null
    return record as unknown as RuntimeHistoryRecord
  } catch {
    return null
  }
}

function terminal(session: InternalTTYSession): boolean {
  return session.status === 'terminated' || session.status === 'expired' || session.status === 'error'
}

export class TTYPersistentSessionManager implements TTYSessionControlHandler {
  private readonly leaseTtlMs: number
  private readonly heartbeatIntervalMs: number
  private readonly maxCompletedCommands: number
  private readonly now: () => Date
  private readonly setTimer: (handler: () => void, timeoutMs: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly logger: TTYPersistentSessionManagerLogger
  private readonly executionOutput: Pick<TTYOutputStreamManager, 'appendOutput' | 'appendMetric'> | null
  private readonly journalPollIntervalMs: number
  private readonly telemetryIntervalMs: number
  private readonly telemetryLastSampleAt = new Map<TTYSessionId, number>()
  private readonly managed = new Map<TTYSessionId, ManagedSession>()
  private readonly completed = new Map<TTYSessionId, string[]>()
  private readonly outputTails = new Map<TTYSessionId, Promise<void>>()
  private readonly fenceTails = new Map<TTYSessionId, Promise<void>>()
  private timer: unknown = null
  private started = false
  private heartbeatInFlight = false
  private persistentRecoveryInFlight = false

  constructor(
    private readonly redis: Redis,
    private readonly runtime: TTYPersistentRuntimeBackend,
    private readonly sessions: TTYPersistentSessionLifecycleStore,
    private readonly transcript: Pick<TTYSessionTranscriptManager, 'appendOutput' | 'appendSystem'>,
    private readonly workerId: TTYWorkerId,
    options: TTYPersistentSessionManagerOptions = {},
  ) {
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.maxCompletedCommands = options.maxCompletedCommandsPerSession ?? MAX_COMPLETED_COMMANDS_PER_SESSION
    // Journal-backed tmux output is the durable recovery source.  Poll it at
    // a terminal-sized cadence so interactive echo does not inherit a 100ms
    // floor, while transcript writes remain asynchronous behind outputTail.
    this.journalPollIntervalMs = options.journalPollIntervalMs ?? 16
    this.telemetryIntervalMs = options.telemetryIntervalMs ?? 5_000
    if (
      !isPositiveInteger(this.leaseTtlMs) ||
      !isPositiveInteger(this.heartbeatIntervalMs) ||
      this.heartbeatIntervalMs >= this.leaseTtlMs ||
      !isPositiveInteger(this.maxCompletedCommands) ||
      !isPositiveInteger(this.journalPollIntervalMs) ||
      !isPositiveInteger(this.telemetryIntervalMs)
    )
      throw new Error('Invalid persistent TTY session manager timing configuration.')
    this.now = options.now ?? (() => new Date())
    this.setTimer = options.setInterval ?? ((handler, timeoutMs) => setInterval(handler, timeoutMs))
    this.clearTimer = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>))
    this.logger = options.logger ?? NOOP_LOGGER
    this.executionOutput = options.executionOutput ?? null
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.recoverPersistentSessions()
    this.timer = this.setTimer(() => void this.heartbeatOnce(), this.heartbeatIntervalMs)
    const maybeUnref = this.timer as { unref?: () => void }
    maybeUnref.unref?.()
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    this.telemetryLastSampleAt.clear()
    const active = [...this.managed.values()]
    for (const managed of active) await this.fence(managed, 'worker_detached', 'detach')
  }

  async handle(command: TTYSessionControlEntry): Promise<void> {
    if (!this.started) throw new Error('Persistent TTY session manager is not started.')
    if (this.wasCompleted(command.sessionId, command.commandId)) return

    // An already attached session is the interactive hot path.  The control
    // stream has already crossed the authenticated server boundary, and the
    // worker lease/heartbeat is the authority for this local attachment.  Do
    // not make the PTY wait for another Postgres read before accepting a byte.
    // The durable session touch and stdin telemetry are queued after the write.
    if (command.type === 'write') {
      const local = this.managed.get(command.sessionId)
      if (local && local.ownerUserId === command.ownerUserId && !local.fenced && local.cleanupPromise === null) {
        this.writeAttached(command, local)
        this.remember(command.sessionId, command.commandId)
        return
      }
    }

    const session = await this.sessions.getSession(command.sessionId, command.ownerUserId)
    if (session === null) {
      await this.appendSystem(command.sessionId, 'control_rejected', {
        commandId: command.commandId,
        reason: 'session_not_found',
      })
      this.remember(command.sessionId, command.commandId)
      return
    }

    if (command.type === 'terminate') {
      await this.terminate(command, session)
      this.remember(command.sessionId, command.commandId)
      return
    }

    if (terminal(session)) {
      await this.appendSystem(command.sessionId, 'control_rejected', {
        commandId: command.commandId,
        reason: 'session_terminal',
      })
      this.remember(command.sessionId, command.commandId)
      return
    }

    switch (command.type) {
      case 'open':
        await this.ensureAttached(session)
        break
      case 'write':
        await this.write(command, session)
        break
      case 'resize':
        await this.resize(command, session)
        break
    }
    this.remember(command.sessionId, command.commandId)
  }

  async heartbeatOnce(): Promise<void> {
    if (!this.started || this.heartbeatInFlight) return
    this.heartbeatInFlight = true
    const hadManagedSessionsAtStart = this.managed.size > 0
    try {
      for (const managed of [...this.managed.values()]) {
        const currentSession = await this.sessions.getSession(managed.sessionId, managed.ownerUserId).catch(() => null)
        if (currentSession === null) {
          // A null read may be an ownership/idle expiry or a transient store
          // failure. Detach and let the next owner reconcile it; never keep a
          // PTY alive when the authoritative session cannot be verified.
          await this.fence(managed, 'session_authority_unavailable', 'detach')
          continue
        }
        if (terminal(currentSession)) {
          await this.fence(managed, 'session_terminal', 'terminate')
          continue
        }
        if (this.runtime.hasPersistentSession) {
          const persistentShellRemains = await this.runtime.hasPersistentSession(managed.sessionId).catch(() => false)
          if (!persistentShellRemains) {
            await this.fence(managed, 'runtime_shell_unavailable', 'terminate')
            continue
          }
        }
        const renewed = await this.renewLease(managed).catch(() => false)
        if (!renewed) await this.fence(managed, 'runtime_lease_lost', 'detach')
        else await this.sampleProcessTelemetry(managed)
      }
      // A lease-loss fence must remain observable for this heartbeat. Retry
      // adoption on the next pass; startup recovery still runs immediately
      // when the worker process begins with no local attachments.
      if (!hadManagedSessionsAtStart) await this.recoverPersistentSessions()
    } finally {
      this.heartbeatInFlight = false
    }
  }

  /**
   * Rehydrates the worker-local attachment map from the durable session index.
   * A tmux shell outlives the worker process, but node-pty listeners do not;
   * without this pass a restarted worker can report healthy while browser
   * input has nowhere to go. Failed claims remain indexed for the next pass so
   * a short-lived old lease or Supabase outage cannot orphan the shell.
   */
  async recoverPersistentSessions(): Promise<{
    readonly scanned: number
    readonly attached: number
    readonly skipped: number
    readonly failed: number
  }> {
    if (!this.started || this.persistentRecoveryInFlight) return { scanned: 0, attached: 0, skipped: 0, failed: 0 }
    this.persistentRecoveryInFlight = true
    const counters = { scanned: 0, attached: 0, skipped: 0, failed: 0 }
    try {
      const sessionIds = await this.redis.smembers(ttyPersistentSessionIndexKey())
      for (const sessionId of sessionIds as TTYSessionId[]) {
        if (this.managed.has(sessionId)) continue
        counters.scanned += 1
        try {
          const history = parseRuntimeHistory(await this.redis.get<unknown>(ttySessionRuntimeHistoryKey(sessionId)))
          if (history === null) {
            await this.redis.srem(ttyPersistentSessionIndexKey(), sessionId)
            counters.skipped += 1
            continue
          }
          const session = await this.sessions.getSession(sessionId, history.ownerUserId)
          if (session === null || terminal(session)) {
            await this.redis.srem(ttyPersistentSessionIndexKey(), sessionId)
            counters.skipped += 1
            continue
          }
          const managed = await this.ensureAttached(session)
          if (managed === null) {
            await this.redis.srem(ttyPersistentSessionIndexKey(), sessionId)
            counters.skipped += 1
          } else counters.attached += 1
        } catch (error) {
          counters.failed += 1
          this.logger.warn('persistent_session_recovery_retry', {
            workerId: this.workerId,
            sessionId,
            errorCode: error instanceof Error ? error.name : 'unknown_error',
          })
        }
      }
      this.logger.info('persistent_session_recovery_scan_completed', { workerId: this.workerId, ...counters })
      return Object.freeze(counters)
    } finally {
      this.persistentRecoveryInFlight = false
    }
  }

  async flush(sessionId: TTYSessionId): Promise<void> {
    await (this.outputTails.get(sessionId) ?? Promise.resolve())
    await (this.fenceTails.get(sessionId) ?? Promise.resolve())
  }

  activeSessionIds(): readonly TTYSessionId[] {
    return Object.freeze([...this.managed.keys()])
  }

  async getActiveExecutionRecord(sessionId: TTYSessionId): Promise<TTYPersistentExecutionRecord | null> {
    return parseActiveExecutionRecord(await this.redis.get<unknown>(ttySessionActiveExecutionKey(sessionId)))
  }

  async listActiveExecutionRecords(): Promise<readonly TTYPersistentExecutionRecord[]> {
    const sessionIds = await this.redis.smembers(ttyPersistentExecutionActiveIndexKey())
    const records = await Promise.all(
      sessionIds.map((sessionId) => this.getActiveExecutionRecord(sessionId as TTYSessionId)),
    )
    return Object.freeze(records.filter((record): record is TTYPersistentExecutionRecord => record !== null))
  }

  async recoverExecution(input: {
    readonly executionId: TTYExecutionId
    readonly sessionId: TTYSessionId
    readonly ownerUserId: string
  }): Promise<TTYPersistentExecutionHandle | null> {
    if (!this.started) throw new Error('Persistent TTY session manager is not started.')
    const record = await this.getActiveExecutionRecord(input.sessionId)
    if (
      record === null ||
      record.executionId !== input.executionId ||
      record.ownerUserId !== input.ownerUserId ||
      record.state === 'completed'
    )
      return null
    const session = await this.sessions.getSession(input.sessionId, input.ownerUserId)
    if (session === null || terminal(session)) return null
    const managed = await this.ensureAttached(session)
    if (managed?.activeExecution?.metadata.executionId !== input.executionId) return null
    return this.executionHandle(managed, managed.activeExecution)
  }

  /**
   * Dispatches one already-admitted argv command into the live persistent
   * shell.  The manager owns framing so a browser can never smuggle shell
   * syntax into the execution boundary, while builtins (notably cd) still run
   * in the same long-lived shell and preserve state for the next command.
   */
  async startExecution(input: TTYPersistentExecutionStartInput): Promise<TTYPersistentExecutionHandle> {
    if (!this.started) throw new Error('Persistent TTY session manager is not started.')
    if (input.argv.length === 0 || input.argv.some((argument) => argument.length === 0 || argument.includes('\u0000')))
      throw new Error('Invalid persistent TTY execution argv.')
    if (input.argv[0]?.toLowerCase() === 'exit')
      throw new Error('Shell exit must be requested through the terminal termination control.')

    const session = await this.sessions.getSession(input.sessionId, input.ownerUserId)
    if (session === null || terminal(session)) throw new Error('Persistent TTY session is unavailable.')
    const touched = await this.sessions.touchSession(input.sessionId, input.ownerUserId)
    if (touched === null) throw new Error('Persistent TTY session could not be renewed.')
    const managed = await this.ensureAttached(touched)
    if (managed === null) throw new Error('Persistent TTY shell could not be attached.')
    if (managed.activeExecution !== null) {
      if (managed.activeExecution.metadata.executionId === input.executionId)
        return this.executionHandle(managed, managed.activeExecution)
      throw new Error('Persistent TTY session already has an active execution.')
    }

    await this.releaseCompletedActiveExecutionBeforeDispatch(input.sessionId)
    const execution = this.createExecution(managed, input.executionId)
    const claim = await this.claimActiveExecution(managed, execution, 'preparing')
    if (!claim) throw new Error('Persistent TTY session already has a durable active execution.')
    managed.activeExecution = execution
    managed.outputBytesSinceInput = 0
    managed.outputLimitReached = false
    await this.appendSystem(input.sessionId, 'execution_dispatching', {
      executionId: input.executionId,
      argvCount: input.argv.length,
    })
    try {
      managed.handle.write(
        serializeTTYPersistentShellExecution({
          token: execution.token,
          argv: input.argv,
        }),
      )
    } catch (error) {
      this.completeExecution(managed, execution, {
        code: null,
        signal: null,
        error: error instanceof Error ? error.message : 'PTY command dispatch failed.',
      })
      throw error
    }
    await this.updateActiveExecutionRecord(managed, execution, 'dispatched')
    await this.appendSystem(input.sessionId, 'execution_dispatched', { executionId: input.executionId })
    return this.executionHandle(managed, execution)
  }

  async interruptExecution(executionId: TTYExecutionId): Promise<boolean> {
    const match = this.executionById(executionId)
    if (match === null || match.execution.completed) return false
    await this.appendSystem(match.managed.sessionId, 'execution_interrupt_requested', { executionId })
    match.managed.handle.write('\u0003')
    return true
  }

  async forceTerminateExecution(executionId: TTYExecutionId): Promise<boolean> {
    const match = this.executionById(executionId)
    if (match === null || match.execution.completed) return false
    this.completeExecution(match.managed, match.execution, {
      code: null,
      signal: 'SIGKILL',
      error: 'Persistent execution was force-terminated.',
    })
    await this.fence(match.managed, 'execution_force_terminated', 'terminate')
    return true
  }

  private async write(command: TTYSessionControlEntry, session: InternalTTYSession): Promise<void> {
    const managed = await this.ensureAttached(session)
    if (managed === null) return
    this.writeAttached(command, managed)
  }

  /**
   * Writes to the live PTY before any transcript, touch, or analytics work.
   * The queued metadata remains durable and ordered through outputTail, but it
   * cannot add database latency to interactive shell echo.
   */
  private writeAttached(command: TTYSessionControlEntry, managed: ManagedSession): void {
    managed.outputBytesSinceInput = 0
    const data = command.data ?? ''
    const workerReceivedAtMs = this.now().getTime()
    const inputMetadata = {
      commandId: command.commandId,
      streamId: command.streamId,
      byteLength: Buffer.byteLength(data, 'utf8'),
      ...(command.inputEventId ? { inputEventId: command.inputEventId } : {}),
      ...(command.inputSequence !== undefined ? { inputSequence: command.inputSequence } : {}),
      ...(command.browserTimestampMs !== undefined ? { browserTimestampMs: command.browserTimestampMs } : {}),
      workerReceivedAtMs,
    }
    try {
      managed.handle.write(data)
    } catch (error) {
      void this.appendSystem(command.sessionId, 'stdin_write_failed', inputMetadata).catch(() => undefined)
      throw error
    }
    const ptyWriteAtMs = this.now().getTime()
    // PTY bytes remain lossless and immediate, but persisting two transcript
    // rows for every printable batch can put Supabase latency in front of the
    // shell echo. Keep timing telemetry bounded; durable PTY output remains
    // unthrottled.
    if (ptyWriteAtMs - managed.lastInputTelemetryAtMs < INPUT_TELEMETRY_INTERVAL_MS) return
    managed.lastInputTelemetryAtMs = ptyWriteAtMs
    this.queueTranscript(managed, async () => {
      const touched = await this.sessions.touchSession(command.sessionId, command.ownerUserId)
      if (touched === null) {
        await this.appendSystem(command.sessionId, 'control_rejected', {
          commandId: command.commandId,
          reason: 'session_unavailable_after_pty_write',
        })
        return
      }
      await this.appendSystem(command.sessionId, 'stdin_dispatching', { ...inputMetadata, ptyWriteAtMs })
      await this.appendSystem(command.sessionId, 'stdin_accepted', { ...inputMetadata, ptyWriteAtMs })
    })
  }

  private async resize(command: TTYSessionControlEntry, session: InternalTTYSession): Promise<void> {
    const touched = await this.sessions.touchSession(command.sessionId, command.ownerUserId)
    if (touched === null) {
      await this.appendSystem(command.sessionId, 'control_rejected', {
        commandId: command.commandId,
        reason: 'session_unavailable',
      })
      return
    }
    const managed = await this.ensureAttached(touched)
    if (managed === null) return
    managed.handle.resize(command.columns as number, command.rows as number)
    await this.appendSystem(command.sessionId, 'terminal_resized', {
      columns: command.columns as number,
      rows: command.rows as number,
    })
  }

  private async terminate(command: TTYSessionControlEntry, session: InternalTTYSession): Promise<void> {
    let managed: ManagedSession | null | undefined = this.managed.get(command.sessionId)
    await this.appendSystem(command.sessionId, 'termination_requested', { commandId: command.commandId })
    // A terminate request can arrive on a recovery worker after the original
    // attachment has detached. Reattach only when a durable runtime history
    // proves there is an existing shell to destroy; never create a replacement
    // shell solely in order to terminate it.
    if (managed === undefined && (await this.redis.get(ttySessionRuntimeHistoryKey(command.sessionId))) !== null)
      managed = await this.ensureAttached(session)
    if (managed !== undefined && managed !== null && managed.ownerUserId !== session.ownerUserId) {
      await this.appendSystem(command.sessionId, 'control_rejected', {
        commandId: command.commandId,
        reason: 'owner_mismatch',
      })
      return
    }
    await this.sessions.terminateSession(command.sessionId, session.ownerUserId, 'system_shutdown')
    if (managed !== null && managed !== undefined) await this.cleanup(managed, 'terminate')
    await this.appendSystem(command.sessionId, 'pty_terminated')
  }

  private async ensureAttached(session: InternalTTYSession): Promise<ManagedSession | null> {
    const local = this.managed.get(session.sessionId)
    if (local !== undefined) {
      // A durable session record and a local attach are not sufficient proof
      // that the authoritative tmux shell still exists.  The shell can
      // disappear between worker restart recovery and the next browser
      // command.  Fence it before dispatch so the coordinator fails fast and
      // the browser can bind a replacement session instead of waiting for an
      // execution timeout with zero output.
      if (this.runtime.hasPersistentSession) {
        const persistentShellRemains = await this.runtime.hasPersistentSession(session.sessionId).catch(() => false)
        if (!persistentShellRemains) {
          await this.fence(local, 'runtime_shell_unavailable', 'terminate')
          return null
        }
      }
      return local
    }

    const historyRaw = await this.redis.get<unknown>(ttySessionRuntimeHistoryKey(session.sessionId))
    const history = historyRaw === null ? null : parseRuntimeHistory(historyRaw)
    if (historyRaw !== null && (history === null || history.ownerUserId !== session.ownerUserId)) {
      await this.failClosedAfterWorkerLoss(session, 'runtime_history_invalid')
      return null
    }
    if (history !== null && this.runtime.recoverSession === undefined) {
      await this.failClosedAfterWorkerLoss(session, 'runtime_recovery_unavailable')
      return null
    }

    const runtimeId = crypto.randomUUID()
    const claimedAt = this.now()
    const provisional: RuntimeLeaseRecord = {
      version: 1,
      state: 'provisioning',
      sessionId: session.sessionId,
      ownerUserId: session.ownerUserId,
      workerId: this.workerId,
      runtimeId,
      startedAt: claimedAt.toISOString(),
      leaseExpiresAt: new Date(claimedAt.getTime() + this.leaseTtlMs).toISOString(),
    }
    const claim = await this.redis.eval(
      CLAIM_RUNTIME_SCRIPT,
      [ttySessionRuntimeKey(session.sessionId)],
      [JSON.stringify(provisional), String(this.leaseTtlMs)],
    )
    if (responseCode(claim) !== 1) {
      const existingRaw = Array.isArray(claim) ? claim[1] : null
      const existing = parseRuntimeLease(existingRaw)
      if (existing?.workerId === this.workerId && existing.runtimeId === runtimeId)
        return this.managed.get(session.sessionId) ?? null
      throw new Error('Persistent TTY session is assigned to another worker.')
    }

    let managed: ManagedSession | null = null
    let journalBacked = false
    let earlyExit: { readonly exitCode: number; readonly signal?: number } | null = null
    const earlyOutput: string[] = []
    try {
      const runtimeInput: TTYPersistentRuntimeSessionInput = {
        sessionId: session.sessionId,
        ownerUserId: session.ownerUserId,
        workerId: this.workerId,
        startedAt: history?.attachedAt,
        onData: (data) => {
          if (managed === null) {
            earlyOutput.push(data)
            return
          }
          if (journalBacked) return
          this.captureOutput(managed, data)
        },
        onExit: (event) => {
          if (managed === null) {
            earlyExit = event
            return
          }
          void this.handleExit(managed, event)
        },
      }
      const handle =
        history !== null
          ? await this.runtime.recoverSession!(runtimeInput)
          : await this.runtime.createSession(runtimeInput)
      if (handle === null) {
        await this.failClosedAfterWorkerLoss(session, 'runtime_recovery_unavailable')
        await this.releaseLease(session.sessionId, runtimeId).catch(() => undefined)
        return null
      }
      journalBacked = handle.replayOutput !== undefined
      if (journalBacked) earlyOutput.splice(0)
      managed = {
        sessionId: session.sessionId,
        ownerUserId: session.ownerUserId,
        runtimeId,
        handle,
        maxOutputBytes: session.limits.maxOutputBytesPerExecution,
        outputBytesSinceInput: 0,
        outputLimitReached: false,
        lastInputTelemetryAtMs: Number.NEGATIVE_INFINITY,
        outputReady: false,
        bufferedOutput: earlyOutput,
        protocol: new TTYPersistentExecutionProtocolDecoder(),
        activeExecution: null,
        outputTail: Promise.resolve(),
        cleanupPromise: null,
        fencePromise: null,
        fenced: false,
        journalBacked,
        journalReplayInFlight: false,
        journalTimer: null,
      }
      await this.restoreActiveExecution(managed)
      this.managed.set(session.sessionId, managed)
      const promoted = await this.promoteLease(managed, history)
      if (!promoted) throw new Error('Persistent TTY runtime lease was lost during attachment.')
      await this.redis.sadd(ttyPersistentSessionIndexKey(), session.sessionId)
      await this.appendSystem(session.sessionId, history === null ? 'pty_attached' : 'pty_recovered', {
        workerId: this.workerId,
        pid: handle.metadata.pid,
      })
      managed.outputReady = true
      for (const data of managed.bufferedOutput.splice(0)) this.captureOutput(managed, data)
      if (managed.journalBacked) {
        await this.replayJournal(managed)
        managed.journalTimer = this.setTimer(
          () => void this.replayJournal(managed as ManagedSession),
          this.journalPollIntervalMs,
        )
        const maybeUnref = managed.journalTimer as { unref?: () => void }
        maybeUnref.unref?.()
      }
      if (earlyExit !== null) await this.handleExit(managed, earlyExit)
      return this.managed.get(session.sessionId) ?? null
    } catch (error) {
      if (managed !== null) {
        this.managed.delete(session.sessionId)
        await managed.handle.terminate().catch(() => undefined)
      }
      await this.releaseLease(session.sessionId, runtimeId).catch(() => undefined)
      throw error
    }
  }

  private captureOutput(managed: ManagedSession, data: string, eventIdBase?: string): void {
    if (!managed.outputReady) {
      managed.bufferedOutput.push(data)
      return
    }
    const outputTimestampMs = this.now().getTime()
    let outputIndex = 0
    for (const event of managed.protocol.push(data)) {
      const execution = managed.activeExecution
      if (event.type === 'output') {
        const eventId = eventIdBase ? `${eventIdBase}:${outputIndex}` : undefined
        outputIndex += 1
        this.enqueueOutput(managed, event.text, execution?.metadata.executionId, eventId, outputTimestampMs)
        if (execution?.started && !execution.completed) this.emitExecutionOutput(execution, event.text)
        continue
      }
      if (execution === null || execution.token !== event.token || execution.completed) {
        // Never hide a terminal-control sequence merely because it resembles
        // our protocol. Only the per-execution random marker is private.
        const eventId = eventIdBase ? `${eventIdBase}:${outputIndex}` : undefined
        outputIndex += 1
        this.enqueueOutput(managed, event.raw, undefined, eventId, outputTimestampMs)
        continue
      }
      if (event.type === 'started') {
        execution.started = true
        this.queueTranscript(managed, async () => {
          await this.updateActiveExecutionRecord(managed, execution, 'running')
          await this.appendSystem(managed.sessionId, 'execution_started', {
            executionId: execution.metadata.executionId,
          })
        })
        continue
      }
      this.completeExecution(managed, execution, { code: event.exitCode, signal: null })
    }
  }

  private async replayJournal(managed: ManagedSession): Promise<void> {
    if (!managed.journalBacked || managed.journalReplayInFlight || managed.fenced || managed.cleanupPromise !== null)
      return
    const replay = managed.handle.replayOutput
    if (!replay) return
    managed.journalReplayInFlight = true
    try {
      const rawOffset = await this.redis.get<unknown>(ttySessionRuntimeOutputOffsetKey(managed.sessionId))
      const offset = rawOffset === null ? 0 : Number(rawOffset)
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid persistent PTY journal cursor.')
      const chunk = await replay(offset)
      if (!Number.isSafeInteger(chunk.nextOffset) || chunk.nextOffset < offset)
        throw new Error('Persistent PTY journal cursor moved backwards.')
      // A poll may end inside our OSC execution frame. Recreate the decoder
      // from the start of that incomplete frame on the next poll; advancing
      // past it would make a worker crash lose the completion marker/output.
      managed.protocol.reset()
      if (chunk.data.length > 0) this.captureOutput(managed, chunk.data, `journal:${managed.sessionId}:${offset}`)
      await managed.outputTail
      const pendingBytes = managed.protocol.bufferedInputBytes()
      const checkpoint = Math.max(offset, chunk.nextOffset - pendingBytes)
      if (this.managed.get(managed.sessionId) === managed && !managed.fenced)
        await this.redis.set(ttySessionRuntimeOutputOffsetKey(managed.sessionId), String(checkpoint), {
          ex: TTY_EXECUTION_HISTORY_RETENTION_SECONDS,
        })
    } catch (error) {
      this.logger.error('persistent_runtime_journal_replay_failed', {
        sessionId: managed.sessionId,
        errorCode: error instanceof Error ? error.name : 'unknown_error',
      })
      await this.fence(managed, 'runtime_journal_unavailable', 'detach').catch(() => undefined)
    } finally {
      managed.journalReplayInFlight = false
    }
  }

  private createExecution(
    managed: ManagedSession,
    executionId: TTYExecutionId,
    restored?: TTYPersistentExecutionRecord,
  ): ManagedExecution {
    let resolveExit!: (value: TTYPersistentExecutionExit) => void
    const exit = new Promise<TTYPersistentExecutionExit>((resolve) => {
      resolveExit = resolve
    })
    return {
      token: restored?.token ?? createTTYPersistentExecutionMarker(),
      metadata: Object.freeze({
        handleId: crypto.randomUUID(),
        executionId,
        sessionId: managed.sessionId,
        workerId: this.workerId,
        pid: restored?.pid ?? managed.handle.metadata.pid,
        cwd: restored?.cwd ?? managed.handle.metadata.cwd,
        startedAt: restored?.startedAt ?? this.now().toISOString(),
      }),
      exit,
      resolveExit,
      listeners: new Set(),
      bufferedOutput: [],
      started: restored?.state === 'running',
      completed: false,
      disposed: false,
      activeRecordFinalized: false,
    }
  }

  private executionHandle(managed: ManagedSession, execution: ManagedExecution): TTYPersistentExecutionHandle {
    return {
      metadata: execution.metadata,
      durableOutput: this.executionOutput !== null,
      exit: execution.exit,
      onData: (callback) => {
        if (!execution.disposed) {
          for (const data of execution.bufferedOutput) callback(data)
          execution.listeners.add(callback)
        }
        return () => execution.listeners.delete(callback)
      },
      interrupt: () => this.interruptExecution(execution.metadata.executionId).then(() => undefined),
      forceTerminate: () => this.forceTerminateExecution(execution.metadata.executionId).then(() => undefined),
      dispose: () => {
        execution.disposed = true
        execution.listeners.clear()
        execution.bufferedOutput.splice(0)
      },
      finalize: async () => {
        await managed.outputTail
        await this.releaseActiveExecutionRecord(managed.sessionId, execution.metadata.executionId)
        execution.activeRecordFinalized = true
      },
    }
  }

  private executionById(
    executionId: TTYExecutionId,
  ): { readonly managed: ManagedSession; readonly execution: ManagedExecution } | null {
    for (const managed of this.managed.values()) {
      if (managed.activeExecution?.metadata.executionId === executionId)
        return { managed, execution: managed.activeExecution }
    }
    return null
  }

  private emitExecutionOutput(execution: ManagedExecution, text: string): void {
    const data = Buffer.from(text, 'utf8')
    execution.bufferedOutput.push(data)
    for (const listener of execution.listeners) {
      try {
        listener(data)
      } catch {
        // A worker-side output listener is a transport optimisation. Durable
        // transcript capture must continue even if it has been disposed.
      }
    }
  }

  private async restoreActiveExecution(managed: ManagedSession): Promise<void> {
    const record = await this.getActiveExecutionRecord(managed.sessionId)
    if (record === null) return
    if (record.ownerUserId !== managed.ownerUserId) throw new Error('Persistent active execution owner mismatch.')
    if (record.state === 'completed') return
    managed.activeExecution = this.createExecution(managed, record.executionId, record)
    managed.outputBytesSinceInput = 0
    managed.outputLimitReached = false
  }

  private activeExecutionRecord(
    managed: ManagedSession,
    execution: ManagedExecution,
    state: TTYPersistentExecutionRecordState,
    exit?: TTYPersistentExecutionExit,
  ): TTYPersistentExecutionRecord {
    return {
      version: 1,
      sessionId: managed.sessionId,
      executionId: execution.metadata.executionId,
      ownerUserId: managed.ownerUserId,
      workerId: this.workerId,
      runtimeId: managed.runtimeId,
      token: execution.token,
      state,
      startedAt: execution.metadata.startedAt,
      updatedAt: this.now().toISOString(),
      pid: execution.metadata.pid,
      cwd: execution.metadata.cwd,
      ...(state === 'completed'
        ? {
            exitCode: exit?.code ?? null,
            signal: exit?.signal ?? null,
            ...(exit?.error ? { error: exit.error.slice(0, 256) } : {}),
          }
        : {}),
    }
  }

  private async claimActiveExecution(
    managed: ManagedSession,
    execution: ManagedExecution,
    state: TTYPersistentExecutionRecordState,
  ): Promise<boolean> {
    const record = this.activeExecutionRecord(managed, execution, state)
    const result = await this.redis.eval(
      CLAIM_ACTIVE_EXECUTION_SCRIPT,
      [ttySessionActiveExecutionKey(managed.sessionId), ttyPersistentExecutionActiveIndexKey()],
      [JSON.stringify(record), String(TTY_EXECUTION_HISTORY_RETENTION_SECONDS), managed.sessionId],
    )
    return responseCode(result) === 1
  }

  private async updateActiveExecutionRecord(
    managed: ManagedSession,
    execution: ManagedExecution,
    state: TTYPersistentExecutionRecordState,
    exit?: TTYPersistentExecutionExit,
  ): Promise<boolean> {
    const record = this.activeExecutionRecord(managed, execution, state, exit)
    const result = await this.redis.eval(
      UPDATE_ACTIVE_EXECUTION_SCRIPT,
      [ttySessionActiveExecutionKey(managed.sessionId), ttyPersistentExecutionActiveIndexKey()],
      [
        managed.sessionId,
        execution.metadata.executionId,
        execution.token,
        JSON.stringify(record),
        String(TTY_EXECUTION_HISTORY_RETENTION_SECONDS),
      ],
    )
    return responseCode(result) === 1
  }

  private async releaseActiveExecutionRecord(sessionId: TTYSessionId, executionId: TTYExecutionId): Promise<boolean> {
    const result = await this.redis.eval(
      RELEASE_ACTIVE_EXECUTION_SCRIPT,
      [ttySessionActiveExecutionKey(sessionId), ttyPersistentExecutionActiveIndexKey()],
      [sessionId, executionId],
    )
    return responseCode(result) === 1
  }

  private async releaseCompletedActiveExecutionBeforeDispatch(sessionId: TTYSessionId): Promise<void> {
    const record = await this.getActiveExecutionRecord(sessionId)
    if (record?.state === 'completed') await this.releaseActiveExecutionRecord(sessionId, record.executionId)
  }

  private completeExecution(
    managed: ManagedSession,
    execution: ManagedExecution,
    exit: TTYPersistentExecutionExit,
  ): void {
    if (execution.completed) return
    execution.completed = true
    if (managed.activeExecution === execution) managed.activeExecution = null
    this.queueTranscript(managed, async () => {
      await this.updateActiveExecutionRecord(managed, execution, 'completed', exit)
      await this.appendSystem(managed.sessionId, 'execution_completed', {
        executionId: execution.metadata.executionId,
        exitCode: exit.code,
        signal: exit.signal ?? null,
        ...(exit.error ? { error: exit.error.slice(0, 256) } : {}),
      })
    })
    // `outputTail` includes every transcript append dispatched before this
    // completion marker. Resolve only after that tail so a completion event
    // cannot outrun the terminal's durable session replay.
    void managed.outputTail.then(
      () => execution.resolveExit(exit),
      () => execution.resolveExit({ ...exit, error: exit.error ?? 'Persistent transcript persistence failed.' }),
    )
  }

  private enqueueOutput(
    managed: ManagedSession,
    data: string,
    executionId?: TTYExecutionId,
    eventId?: string,
    outputTimestampMs?: number,
  ): void {
    if (managed.outputLimitReached || data.length === 0) return
    const byteLength = Buffer.byteLength(data, 'utf8')
    if (managed.outputBytesSinceInput + byteLength > managed.maxOutputBytes) {
      managed.outputLimitReached = true
      if (managed.activeExecution !== null)
        this.completeExecution(managed, managed.activeExecution, {
          code: null,
          signal: 'SIGKILL',
          error: 'Persistent execution exceeded its output budget.',
        })
      this.queueTranscript(managed, () =>
        this.appendSystem(managed.sessionId, 'output_limit_exceeded', {
          maxOutputBytes: managed.maxOutputBytes,
          attemptedBytes: managed.outputBytesSinceInput + byteLength,
        }),
      )
      void this.fence(managed, 'output_limit_exceeded', 'terminate')
      return
    }
    managed.outputBytesSinceInput += byteLength
    this.queueTranscript(managed, async () => {
      const events = await this.transcript.appendOutput({
        sessionId: managed.sessionId,
        text: data,
        ...(executionId ? { executionId } : {}),
        ...(eventId ? { eventId } : {}),
        ...(outputTimestampMs === undefined
          ? {}
          : {
              telemetry: {
                workerReceivedTimestampMs: outputTimestampMs,
                ptyOutputTimestampMs: outputTimestampMs,
              },
            }),
      })
      if (executionId && this.executionOutput) {
        for (const event of events) {
          const text = typeof event.data.text === 'string' ? event.data.text : ''
          if (text.length === 0) continue
          await this.executionOutput.appendOutput({
            executionId,
            sessionId: managed.sessionId,
            stream: 'stdout',
            text,
            transport: 'persistent_pty',
            eventId: event.eventId,
          })
        }
      }
    })
  }

  private queueTranscript(managed: ManagedSession, operation: () => Promise<void>): void {
    const queued = managed.outputTail.then(operation, operation)
    managed.outputTail = queued.catch((error) => {
      this.logger.error('persistent_transcript_append_failed', {
        sessionId: managed.sessionId,
        errorCode: error instanceof Error ? error.name : 'unknown_error',
      })
      void this.fence(managed, 'transcript_unavailable', 'detach')
    })
    this.outputTails.set(managed.sessionId, managed.outputTail)
  }

  private async handleExit(
    managed: ManagedSession,
    event: { readonly exitCode: number; readonly signal?: number },
  ): Promise<void> {
    if (managed.cleanupPromise !== null || managed.fenced) return
    const persistentShellRemains = this.runtime.hasPersistentSession
      ? await this.runtime.hasPersistentSession(managed.sessionId).catch(() => false)
      : false
    if (persistentShellRemains) {
      await this.appendSystem(managed.sessionId, 'pty_attachment_lost', {
        exitCode: event.exitCode,
        signal: event.signal ?? null,
      })
      await this.cleanup(managed, 'detach')
      return
    }
    if (managed.activeExecution !== null)
      this.completeExecution(managed, managed.activeExecution, {
        code: event.exitCode,
        signal: null,
        error: 'Persistent shell exited before emitting an execution completion frame.',
      })
    await this.appendSystem(managed.sessionId, 'pty_exited', {
      exitCode: event.exitCode,
      signal: event.signal ?? null,
    })
    await this.sessions.terminateSession(managed.sessionId, managed.ownerUserId, 'runtime_exited')
    await this.cleanup(managed, 'terminate')
  }

  private async fence(managed: ManagedSession, event: string, disposition: 'detach' | 'terminate'): Promise<void> {
    if (managed.fencePromise !== null) return managed.fencePromise
    if (managed.fenced) return
    managed.fenced = true
    const operation = (async () => {
      await this.appendSystem(managed.sessionId, event)
      if (disposition === 'terminate') {
        await this.sessions.terminateSession(managed.sessionId, managed.ownerUserId, 'resource_limit_exceeded')
      }
      await this.cleanup(managed, disposition)
    })()
    managed.fencePromise = operation
    this.fenceTails.set(managed.sessionId, operation)
    return operation
  }

  private async cleanup(managed: ManagedSession, disposition: 'detach' | 'terminate'): Promise<void> {
    if (managed.cleanupPromise !== null) return managed.cleanupPromise
    let operation!: Promise<void>
    operation = (async () => {
      if (managed.journalTimer !== null) {
        this.clearTimer(managed.journalTimer)
        managed.journalTimer = null
      }
      if (disposition === 'terminate' && managed.activeExecution !== null)
        this.completeExecution(managed, managed.activeExecution, {
          code: null,
          signal: 'SIGKILL',
          error: 'Persistent terminal session was terminated.',
        })
      if (disposition === 'detach' && managed.handle.detach) await managed.handle.detach()
      else await managed.handle.terminate()
      await managed.outputTail
      this.managed.delete(managed.sessionId)
      if (disposition === 'terminate')
        await Promise.all([
          this.redis.del(ttySessionRuntimeOutputOffsetKey(managed.sessionId)).catch(() => 0),
          this.redis.srem(ttyPersistentSessionIndexKey(), managed.sessionId).catch(() => 0),
        ])
      await this.releaseLease(managed.sessionId, managed.runtimeId).catch((error) => {
        this.logger.warn('persistent_runtime_lease_release_failed', {
          sessionId: managed.sessionId,
          errorCode: error instanceof Error ? error.name : 'unknown_error',
        })
      })
    })().finally(() => {
      if (managed.cleanupPromise === operation && this.managed.get(managed.sessionId) === managed)
        managed.cleanupPromise = null
    })
    managed.cleanupPromise = operation
    return operation
  }

  private async renewLease(managed: ManagedSession): Promise<boolean> {
    const record = this.activeLeaseRecord(managed)
    const result = await this.redis.eval(
      RENEW_RUNTIME_SCRIPT,
      [ttySessionRuntimeKey(managed.sessionId)],
      [managed.runtimeId, JSON.stringify(record), String(this.leaseTtlMs)],
    )
    return responseCode(result) === 1
  }

  private async promoteLease(managed: ManagedSession, previousHistory: RuntimeHistoryRecord | null): Promise<boolean> {
    const record = this.activeLeaseRecord(managed)
    const history: RuntimeHistoryRecord = {
      version: 1,
      sessionId: managed.sessionId,
      ownerUserId: managed.ownerUserId,
      workerId: this.workerId,
      runtimeId: previousHistory?.runtimeId ?? managed.runtimeId,
      attachedAt: previousHistory?.attachedAt ?? record.startedAt,
    }
    const result = await this.redis.eval(
      PROMOTE_RUNTIME_SCRIPT,
      [ttySessionRuntimeKey(managed.sessionId), ttySessionRuntimeHistoryKey(managed.sessionId)],
      [
        managed.runtimeId,
        JSON.stringify(record),
        String(this.leaseTtlMs),
        JSON.stringify(history),
        String(TTY_EXECUTION_HISTORY_RETENTION_SECONDS),
      ],
    )
    return responseCode(result) === 1
  }

  private activeLeaseRecord(managed: ManagedSession): RuntimeLeaseRecord {
    const now = this.now()
    return {
      version: 1,
      state: 'active',
      sessionId: managed.sessionId,
      ownerUserId: managed.ownerUserId,
      workerId: this.workerId,
      runtimeId: managed.runtimeId,
      startedAt: managed.handle.metadata.startedAt,
      leaseExpiresAt: new Date(now.getTime() + this.leaseTtlMs).toISOString(),
      pid: managed.handle.metadata.pid,
      cwd: managed.handle.metadata.cwd,
    }
  }

  private async releaseLease(sessionId: TTYSessionId, runtimeId: string): Promise<void> {
    await this.redis.eval(RELEASE_RUNTIME_SCRIPT, [ttySessionRuntimeKey(sessionId)], [runtimeId])
  }

  private async failClosedAfterWorkerLoss(session: InternalTTYSession, reason: string): Promise<void> {
    await this.appendSystem(session.sessionId, reason)
    await this.sessions.terminateSession(session.sessionId, session.ownerUserId, 'system_shutdown')
    await this.redis.srem(ttyPersistentSessionIndexKey(), session.sessionId).catch(() => 0)
  }

  private async sampleProcessTelemetry(managed: ManagedSession): Promise<void> {
    if (!this.runtime.getProcessTelemetry) return
    const nowMs = this.now().getTime()
    const lastSampleAt = this.telemetryLastSampleAt.get(managed.sessionId) ?? 0
    if (nowMs - lastSampleAt < this.telemetryIntervalMs) return
    this.telemetryLastSampleAt.set(managed.sessionId, nowMs)
    const sample = await this.runtime.getProcessTelemetry(managed.sessionId, managed.ownerUserId).catch((error) => {
      this.logger.warn('persistent_process_telemetry_failed', {
        sessionId: managed.sessionId,
        errorCode: error instanceof Error ? error.name : 'unknown_error',
      })
      return null
    })
    if (!sample) return
    const executionId = managed.activeExecution?.metadata.executionId
    if (executionId && this.executionOutput) {
      for (const [name, value] of [
        ['cpu_percent', sample.cpuPercent],
        ['memory_bytes', sample.memoryBytes],
        ['disk_bytes', sample.diskBytes],
        ['process_count', sample.processCount],
      ] as const) {
        if (value === null || !Number.isFinite(value)) continue
        await this.executionOutput
          .appendMetric({
            executionId,
            sessionId: managed.sessionId,
            name,
            value,
            timestamp: sample.sampledAt,
          })
          .catch((error) => {
            this.logger.warn('persistent_process_telemetry_publish_failed', {
              sessionId: managed.sessionId,
              executionId,
              metric: name,
              errorCode: error instanceof Error ? error.name : 'unknown_error',
            })
          })
      }
    }
    await this.appendSystem(managed.sessionId, 'process_telemetry_sampled', {
      rootPid: sample.rootPid,
      processCount: sample.processCount,
      cpuPercent: sample.cpuPercent,
      memoryBytes: sample.memoryBytes,
      diskBytes: sample.diskBytes,
      sampledAt: sample.sampledAt,
    }).catch((error) => {
      this.logger.warn('persistent_process_telemetry_transcript_failed', {
        sessionId: managed.sessionId,
        errorCode: error instanceof Error ? error.name : 'unknown_error',
      })
    })
  }

  private async appendSystem(
    sessionId: TTYSessionId,
    event: string,
    data: TTYSessionTranscriptData = {},
  ): Promise<void> {
    await this.transcript.appendSystem({ sessionId, event, data })
  }

  private wasCompleted(sessionId: TTYSessionId, commandId: string): boolean {
    return this.completed.get(sessionId)?.includes(commandId) ?? false
  }

  private remember(sessionId: TTYSessionId, commandId: string): void {
    const commands = this.completed.get(sessionId) ?? []
    commands.push(commandId)
    if (commands.length > this.maxCompletedCommands) commands.splice(0, commands.length - this.maxCompletedCommands)
    this.completed.set(sessionId, commands)
  }
}
