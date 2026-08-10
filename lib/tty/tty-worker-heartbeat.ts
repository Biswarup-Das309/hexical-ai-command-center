import type { Redis } from '@upstash/redis'
import { appendTTYWorkerAuditEvent, type TTYWorkerAuditSink } from './tty-worker-audit'
import { ttyWorkerHeartbeatKey, ttyWorkerHealthKey, ttyWorkerMetadataKey } from './tty-worker-keys'
import type { TTYWorkerRegistry } from './tty-worker-registry'
import {
  parseTTYWorkerId,
  type TTYWorkerHealth,
  type TTYWorkerHeartbeat,
  type TTYWorkerId,
  type TTYWorkerMetadata,
} from './tty-worker-types'

export interface TTYWorkerHeartbeatConfig {
  readonly heartbeatIntervalMs: number
  readonly offlineAfterMs: number
}

export const DEFAULT_TTY_WORKER_HEARTBEAT_CONFIG: TTYWorkerHeartbeatConfig = {
  heartbeatIntervalMs: 10_000,
  offlineAfterMs: 30_000,
}

export type TTYWorkerHeartbeatFailure =
  | 'unknown_worker'
  | 'inactive_worker'
  | 'duplicate_heartbeat'
  | 'invalid_heartbeat'
  | 'not_stale'
  | 'internal_error'

export type TTYWorkerHeartbeatResult =
  | { readonly recorded: true; readonly heartbeat: TTYWorkerHeartbeat; readonly health: TTYWorkerHealth }
  | { readonly recorded: false; readonly reason: TTYWorkerHeartbeatFailure }

export type TTYWorkerOfflineResult =
  | { readonly offline: true; readonly health: TTYWorkerHealth }
  | { readonly offline: false; readonly reason: TTYWorkerHeartbeatFailure }

interface HeartbeatDependencies {
  readonly now?: () => Date
  readonly config?: Partial<TTYWorkerHeartbeatConfig>
  readonly audit?: TTYWorkerAuditSink
}

interface StoredHeartbeatScriptResult {
  readonly code: number
  readonly value: string
}

const RECORD_HEARTBEAT_SCRIPT = `
-- tty-worker-record-heartbeat
local workerRaw = redis.call('GET', KEYS[1])
if not workerRaw then return {0, 'unknown_worker'} end
local worker = cjson.decode(workerRaw)
if worker.status == 'inactive' then return {0, 'inactive_worker'} end
local oldRaw = redis.call('GET', KEYS[2])
if oldRaw then
  local old = cjson.decode(oldRaw)
  if tonumber(old.sequence) >= tonumber(ARGV[3]) then return {0, 'duplicate_heartbeat'} end
end
redis.call('SET', KEYS[2], ARGV[1])
redis.call('SET', KEYS[3], ARGV[2])
if worker.status == 'offline' then
  worker.status = 'active'
  worker.deactivatedAt = cjson.null
  worker.updatedAt = ARGV[4]
  redis.call('SET', KEYS[1], cjson.encode(worker))
end
return {1, ARGV[1] .. '|' .. ARGV[2]}
`

const MARK_OFFLINE_SCRIPT = `
-- tty-worker-mark-offline
local workerRaw = redis.call('GET', KEYS[1])
if not workerRaw then return {0, 'unknown_worker'} end
local worker = cjson.decode(workerRaw)
if worker.status == 'inactive' then return {0, 'inactive_worker'} end
local heartbeatRaw = redis.call('GET', KEYS[2])
if heartbeatRaw then
  local heartbeat = cjson.decode(heartbeatRaw)
  if tonumber(ARGV[1]) - tonumber(heartbeat.receivedAtMs) <= tonumber(ARGV[2]) then return {0, 'not_stale'} end
end
local health = cjson.decode(ARGV[3])
redis.call('SET', KEYS[3], ARGV[3])
worker.status = 'offline'
worker.updatedAt = ARGV[4]
redis.call('SET', KEYS[1], cjson.encode(worker))
return {1, ARGV[3]}
`

function parseScriptResult(value: unknown): StoredHeartbeatScriptResult {
  if (!Array.isArray(value) || typeof value[0] !== 'number' || typeof value[1] !== 'string')
    return { code: 0, value: 'internal_error' }
  return { code: value[0], value: value[1] }
}

function validConfig(config: TTYWorkerHeartbeatConfig): boolean {
  return (
    Number.isSafeInteger(config.heartbeatIntervalMs) &&
    config.heartbeatIntervalMs > 0 &&
    Number.isSafeInteger(config.offlineAfterMs) &&
    config.offlineAfterMs >= config.heartbeatIntervalMs
  )
}

function parseHeartbeat(value: unknown): TTYWorkerHeartbeat | null {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const workerId = typeof record.workerId === 'string' ? parseTTYWorkerId(record.workerId) : null
    if (
      workerId === null ||
      typeof record.sequence !== 'number' ||
      !Number.isSafeInteger(record.sequence) ||
      record.sequence < 0 ||
      typeof record.sentAt !== 'string' ||
      typeof record.receivedAt !== 'string' ||
      typeof record.receivedAtMs !== 'number' ||
      typeof record.latencyMs !== 'number' ||
      record.latencyMs < 0
    )
      return null
    return {
      workerId,
      sequence: record.sequence,
      sentAt: record.sentAt,
      receivedAt: record.receivedAt,
      receivedAtMs: record.receivedAtMs,
      latencyMs: record.latencyMs,
    }
  } catch {
    return null
  }
}

function parseHealth(value: unknown): TTYWorkerHealth | null {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const workerId = typeof record.workerId === 'string' ? parseTTYWorkerId(record.workerId) : null
    const state = record.state
    if (
      workerId === null ||
      (state !== 'online' && state !== 'offline') ||
      (record.lastHeartbeatAt !== null && typeof record.lastHeartbeatAt !== 'string') ||
      (record.heartbeatLatencyMs !== null && typeof record.heartbeatLatencyMs !== 'number') ||
      typeof record.missedIntervals !== 'number' ||
      typeof record.healthScore !== 'number' ||
      typeof record.checkedAt !== 'string'
    )
      return null
    return {
      workerId,
      state,
      lastHeartbeatAt: record.lastHeartbeatAt,
      heartbeatLatencyMs: record.heartbeatLatencyMs,
      missedIntervals: record.missedIntervals,
      healthScore: record.healthScore,
      checkedAt: record.checkedAt,
    }
  } catch {
    return null
  }
}

function healthFor(
  workerId: TTYWorkerId,
  heartbeat: TTYWorkerHeartbeat | null,
  nowMs: number,
  config: TTYWorkerHeartbeatConfig,
): TTYWorkerHealth {
  if (heartbeat === null) {
    return {
      workerId,
      state: 'offline',
      lastHeartbeatAt: null,
      heartbeatLatencyMs: null,
      missedIntervals: 0,
      healthScore: 0,
      checkedAt: new Date(nowMs).toISOString(),
    }
  }
  const receivedAtMs = Date.parse(heartbeat.receivedAt)
  const elapsedMs = Number.isFinite(receivedAtMs) ? Math.max(0, nowMs - receivedAtMs) : config.offlineAfterMs + 1
  const missedIntervals = Math.max(0, Math.floor(elapsedMs / config.heartbeatIntervalMs))
  const online = elapsedMs <= config.offlineAfterMs
  const latencyPenalty = Math.min(50, Math.ceil((heartbeat.latencyMs / config.heartbeatIntervalMs) * 25))
  const healthScore = online ? Math.max(0, 100 - missedIntervals * 20 - latencyPenalty) : 0
  return {
    workerId,
    state: online ? 'online' : 'offline',
    lastHeartbeatAt: heartbeat.receivedAt,
    heartbeatLatencyMs: heartbeat.latencyMs,
    missedIntervals,
    healthScore,
    checkedAt: new Date(nowMs).toISOString(),
  }
}

function parseCombined(
  value: string,
): { readonly heartbeat: TTYWorkerHeartbeat; readonly health: TTYWorkerHealth } | null {
  const separator = value.indexOf('|')
  if (separator <= 0) return null
  const heartbeat = parseHeartbeat(value.slice(0, separator))
  const health = parseHealth(value.slice(separator + 1))
  return heartbeat && health ? { heartbeat, health } : null
}

export class TTYWorkerHeartbeatService {
  private readonly now: () => Date
  private readonly config: TTYWorkerHeartbeatConfig

  constructor(
    private readonly redis: Redis,
    private readonly registry: Pick<TTYWorkerRegistry, 'getWorker'>,
    private readonly options: HeartbeatDependencies = {},
  ) {
    this.now = options.now ?? (() => new Date())
    this.config = { ...DEFAULT_TTY_WORKER_HEARTBEAT_CONFIG, ...options.config }
    if (!validConfig(this.config)) throw new Error('Invalid TTY worker heartbeat configuration.')
  }

  async recordHeartbeat(input: {
    readonly workerId: TTYWorkerId
    readonly sequence: number
    readonly sentAt: string
  }): Promise<TTYWorkerHeartbeatResult> {
    if (parseTTYWorkerId(input.workerId) === null || !Number.isSafeInteger(input.sequence) || input.sequence < 0)
      return { recorded: false, reason: 'invalid_heartbeat' }
    const now = this.now()
    const nowMs = now.getTime()
    const sentAtMs = Date.parse(input.sentAt)
    if (!Number.isFinite(sentAtMs) || sentAtMs > nowMs + this.config.offlineAfterMs)
      return { recorded: false, reason: 'invalid_heartbeat' }
    const heartbeat: TTYWorkerHeartbeat = {
      workerId: input.workerId,
      sequence: input.sequence,
      sentAt: input.sentAt,
      receivedAt: now.toISOString(),
      receivedAtMs: nowMs,
      latencyMs: Math.max(0, nowMs - sentAtMs),
    }
    const health = healthFor(input.workerId, heartbeat, nowMs, this.config)
    try {
      const result = parseScriptResult(
        await this.redis.eval(
          RECORD_HEARTBEAT_SCRIPT,
          [
            ttyWorkerMetadataKey(input.workerId),
            ttyWorkerHeartbeatKey(input.workerId),
            ttyWorkerHealthKey(input.workerId),
          ],
          [JSON.stringify(heartbeat), JSON.stringify(health), String(input.sequence), now.toISOString()],
        ),
      )
      if (result.code !== 1) {
        if (
          result.value === 'unknown_worker' ||
          result.value === 'inactive_worker' ||
          result.value === 'duplicate_heartbeat'
        )
          return { recorded: false, reason: result.value }
        return { recorded: false, reason: 'internal_error' }
      }
      const stored = parseCombined(result.value)
      if (stored === null) return { recorded: false, reason: 'internal_error' }
      await this.emitHeartbeat(stored.heartbeat)
      return { recorded: true, ...stored }
    } catch {
      return { recorded: false, reason: 'internal_error' }
    }
  }

  async getHeartbeat(workerId: TTYWorkerId): Promise<TTYWorkerHeartbeat | null> {
    if (parseTTYWorkerId(workerId) === null) return null
    try {
      const raw = await this.redis.get<unknown>(ttyWorkerHeartbeatKey(workerId))
      return raw === null ? null : parseHeartbeat(raw)
    } catch {
      return null
    }
  }

  async computeWorkerHealth(workerId: TTYWorkerId, now: Date = this.now()): Promise<TTYWorkerHealth | null> {
    if (parseTTYWorkerId(workerId) === null) return null
    const worker = await this.registry.getWorker(workerId)
    if (worker === null) return null
    const health = healthFor(workerId, await this.getHeartbeat(workerId), now.getTime(), this.config)
    try {
      await this.redis.set(ttyWorkerHealthKey(workerId), JSON.stringify(health))
    } catch {
      return health
    }
    return health
  }

  async markWorkerOffline(workerId: TTYWorkerId, now: Date = this.now()): Promise<TTYWorkerOfflineResult> {
    if (parseTTYWorkerId(workerId) === null) return { offline: false, reason: 'unknown_worker' }
    const health = await this.computeWorkerHealth(workerId, now)
    if (health === null) return { offline: false, reason: 'unknown_worker' }
    if (health.state !== 'offline') return { offline: false, reason: 'not_stale' }
    try {
      const result = parseScriptResult(
        await this.redis.eval(
          MARK_OFFLINE_SCRIPT,
          [ttyWorkerMetadataKey(workerId), ttyWorkerHeartbeatKey(workerId), ttyWorkerHealthKey(workerId)],
          [String(now.getTime()), String(this.config.offlineAfterMs), JSON.stringify(health), now.toISOString()],
        ),
      )
      if (result.code !== 1)
        return {
          offline: false,
          reason:
            result.value === 'inactive_worker'
              ? 'inactive_worker'
              : result.value === 'not_stale'
              ? 'not_stale'
              : 'internal_error',
        }
      await this.emitOffline(workerId, health)
      return { offline: true, health }
    } catch {
      return { offline: false, reason: 'internal_error' }
    }
  }

  private async emitHeartbeat(heartbeat: TTYWorkerHeartbeat): Promise<void> {
    if (!this.options.audit) return
    try {
      await appendTTYWorkerAuditEvent(this.options.audit, {
        eventType: 'worker_heartbeat',
        timestamp: heartbeat.receivedAt,
        workerId: heartbeat.workerId,
        metadata: { sequence: heartbeat.sequence, latencyMs: heartbeat.latencyMs },
      })
    } catch {
      // The heartbeat write is authoritative; audit emission is retriable.
    }
  }

  private async emitOffline(workerId: TTYWorkerId, health: TTYWorkerHealth): Promise<void> {
    if (!this.options.audit) return
    try {
      await appendTTYWorkerAuditEvent(this.options.audit, {
        eventType: 'worker_offline',
        timestamp: health.checkedAt,
        workerId,
        metadata: { missedIntervals: health.missedIntervals, healthScore: health.healthScore },
      })
    } catch {
      // The offline transition remains fail-closed even if audit is unavailable.
    }
  }
}

export type TTYWorkerHeartbeatRegistry = Pick<TTYWorkerRegistry, 'getWorker'>
export type TTYWorkerStatusMetadata = Pick<TTYWorkerMetadata, 'status' | 'workerId'>
