import type { Redis } from '@upstash/redis'

import type { TTYWorkerAuditEvent, TTYWorkerAuditSink } from './tty-worker-audit'
import {
  isTTYWorkerCapability,
  normalizeTTYWorkerCapabilities,
  parseTTYWorkerId,
  type TTYWorkerCapability,
  type TTYWorkerId,
  type TTYWorkerMetadata,
  type TTYWorkerRegistration,
  type TTYWorkerUpdate
} from './tty-worker-types'
import { ttyWorkerMetadataKey, ttyWorkerRegistryKey } from './tty-worker-keys'

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const MAX_METADATA_KEYS = 32

export type TTYWorkerRegistryFailure =
  | 'duplicate_worker'
  | 'unknown_worker'
  | 'invalid_registration'
  | 'invalid_update'
  | 'internal_error'

export type TTYWorkerRegistrationResult =
  | { readonly registered: true; readonly worker: TTYWorkerMetadata }
  | { readonly registered: false; readonly reason: TTYWorkerRegistryFailure }

export type TTYWorkerUpdateResult =
  | { readonly updated: true; readonly worker: TTYWorkerMetadata }
  | { readonly updated: false; readonly reason: TTYWorkerRegistryFailure }

export type TTYWorkerStateResult =
  | { readonly changed: true; readonly worker: TTYWorkerMetadata }
  | { readonly changed: false; readonly reason: TTYWorkerRegistryFailure }

interface RegistryDependencies {
  readonly now?: () => Date
}

interface RegistryStateScriptResult {
  readonly code: number
  readonly value: string
}

const REGISTER_SCRIPT = `
-- tty-worker-register
if redis.call('EXISTS', KEYS[1]) == 1 then return {0, 'duplicate_worker'} end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SADD', KEYS[2], ARGV[2])
return {1, ARGV[1]}
`

const UPDATE_SCRIPT = `
-- tty-worker-update
local raw = redis.call('GET', KEYS[1])
if not raw then return {0, 'unknown_worker'} end
local worker = cjson.decode(raw)
local update = cjson.decode(ARGV[1])
if ARGV[2] == '1' then worker.version = update.version end
if ARGV[3] == '1' then worker.capabilities = update.capabilities end
if ARGV[4] == '1' then worker.metadata = update.metadata end
worker.updatedAt = ARGV[5]
redis.call('SET', KEYS[1], cjson.encode(worker))
return {1, cjson.encode(worker)}
`

const DEACTIVATE_SCRIPT = `
-- tty-worker-deactivate
local raw = redis.call('GET', KEYS[1])
if not raw then return {0, 'unknown_worker'} end
local worker = cjson.decode(raw)
if worker.status == 'inactive' then return {1, raw} end
worker.status = 'inactive'
worker.deactivatedAt = ARGV[1]
worker.updatedAt = ARGV[1]
redis.call('SET', KEYS[1], cjson.encode(worker))
return {1, cjson.encode(worker)}
`

const REACTIVATE_SCRIPT = `
-- tty-worker-reactivate
local raw = redis.call('GET', KEYS[1])
if not raw then return {0, 'unknown_worker'} end
local worker = cjson.decode(raw)
worker.status = 'active'
worker.deactivatedAt = cjson.null
worker.updatedAt = ARGV[1]
redis.call('SET', KEYS[1], cjson.encode(worker))
return {1, cjson.encode(worker)}
`

function parseScriptResult(value: unknown): RegistryStateScriptResult {
  if (!Array.isArray(value) || typeof value[0] !== 'number' || typeof value[1] !== 'string') {
    return { code: 0, value: 'internal_error' }
  }
  return { code: value[0], value: value[1] }
}

function validMetadata(metadata: Readonly<Record<string, string>> | undefined): boolean {
  if (metadata === undefined) return true
  const entries = Object.entries(metadata)
  if (entries.length > MAX_METADATA_KEYS) return false
  return entries.every(([key, value]) => {
    return key.length > 0 && key.length <= 64 && value.length <= 512
  })
}

function validCapabilities(capabilities: readonly TTYWorkerCapability[]): boolean {
  if (capabilities.length === 0 || capabilities.length > 16) return false
  return capabilities.every(isTTYWorkerCapability) && new Set(capabilities).size === capabilities.length
}

function validateRegistration(registration: TTYWorkerRegistration): TTYWorkerRegistration | null {
  const workerId = parseTTYWorkerId(registration.workerId)
  if (workerId === null) return null
  const identity = registration.identity.trim()
  const version = registration.version.trim()
  if (identity.length === 0 || identity.length > 256 || !VERSION_PATTERN.test(version)) return null
  if (!validCapabilities(registration.capabilities) || !validMetadata(registration.metadata)) return null
  return {
    workerId,
    identity,
    version,
    capabilities: normalizeTTYWorkerCapabilities(registration.capabilities),
    ...(registration.metadata ? { metadata: { ...registration.metadata } } : {})
  }
}

function validateUpdate(update: TTYWorkerUpdate): TTYWorkerUpdate | null {
  const version = update.version?.trim()
  if (version !== undefined && !VERSION_PATTERN.test(version)) return null
  if (update.capabilities !== undefined && !validCapabilities(update.capabilities)) return null
  if (!validMetadata(update.metadata)) return null
  if (update.version === undefined && update.capabilities === undefined && update.metadata === undefined) return null
  return {
    ...(version !== undefined ? { version } : {}),
    ...(update.capabilities !== undefined ? { capabilities: normalizeTTYWorkerCapabilities(update.capabilities) } : {}),
    ...(update.metadata !== undefined ? { metadata: { ...update.metadata } } : {})
  }
}

function parseWorker(value: unknown): TTYWorkerMetadata | null {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const workerId = typeof record.workerId === 'string' ? parseTTYWorkerId(record.workerId) : null
    const status = record.status
    const capabilities = record.capabilities
    if (
      workerId === null ||
      typeof record.identity !== 'string' ||
      typeof record.version !== 'string' ||
      !Array.isArray(capabilities) ||
      !capabilities.every((item): item is TTYWorkerCapability => typeof item === 'string' && isTTYWorkerCapability(item)) ||
      (status !== 'active' && status !== 'offline' && status !== 'inactive') ||
      typeof record.metadata !== 'object' ||
      record.metadata === null ||
      typeof record.registeredAt !== 'string' ||
      typeof record.updatedAt !== 'string' ||
      (record.deactivatedAt !== null && typeof record.deactivatedAt !== 'string')
    ) return null
    const metadata = record.metadata as Record<string, unknown>
    if (!Object.values(metadata).every(item => typeof item === 'string')) return null
    return {
      workerId,
      identity: record.identity,
      version: record.version,
      capabilities: normalizeTTYWorkerCapabilities(capabilities),
      metadata: { ...metadata } as Record<string, string>,
      registeredAt: record.registeredAt,
      updatedAt: record.updatedAt,
      status,
      deactivatedAt: record.deactivatedAt
    }
  } catch {
    return null
  }
}

function eventForWorker(
  eventType: TTYWorkerAuditEvent['eventType'],
  worker: TTYWorkerMetadata,
  timestamp: string,
  metadata: Readonly<Record<string, string | number | boolean | null>> = {}
): TTYWorkerAuditEvent {
  return {
    eventId: crypto.randomUUID(),
    timestamp,
    workerId: worker.workerId,
    sessionId: null,
    executionId: null,
    leaseId: null,
    eventType,
    metadata
  }
}

export class TTYWorkerRegistry {
  private readonly now: () => Date

  constructor(
    private readonly redis: Redis,
    private readonly options: { readonly audit?: TTYWorkerAuditSink; readonly dependencies?: RegistryDependencies } = {}
  ) {
    this.now = options.dependencies?.now ?? (() => new Date())
  }

  async registerWorker(registration: TTYWorkerRegistration): Promise<TTYWorkerRegistrationResult> {
    const validated = validateRegistration(registration)
    if (validated === null) return { registered: false, reason: 'invalid_registration' }
    const registeredAt = this.now().toISOString()
    const worker: TTYWorkerMetadata = {
      ...validated,
      metadata: validated.metadata ?? {},
      registeredAt,
      updatedAt: registeredAt,
      status: 'active',
      deactivatedAt: null
    }
    try {
      const result = parseScriptResult(await this.redis.eval(
        REGISTER_SCRIPT,
        [ttyWorkerMetadataKey(worker.workerId), ttyWorkerRegistryKey()],
        [JSON.stringify(worker), worker.workerId]
      ))
      if (result.code !== 1) return { registered: false, reason: result.value === 'duplicate_worker' ? 'duplicate_worker' : 'internal_error' }
      const stored = parseWorker(result.value)
      if (stored === null) return { registered: false, reason: 'internal_error' }
      await this.emit(eventForWorker('worker_registered', stored, registeredAt, { version: stored.version }))
      return { registered: true, worker: stored }
    } catch {
      return { registered: false, reason: 'internal_error' }
    }
  }

  async getWorker(workerId: TTYWorkerId): Promise<TTYWorkerMetadata | null> {
    if (parseTTYWorkerId(workerId) === null) return null
    try {
      const raw = await this.redis.get<unknown>(ttyWorkerMetadataKey(workerId))
      return raw === null ? null : parseWorker(raw)
    } catch {
      return null
    }
  }

  async updateWorker(workerId: TTYWorkerId, update: TTYWorkerUpdate): Promise<TTYWorkerUpdateResult> {
    if (parseTTYWorkerId(workerId) === null) return { updated: false, reason: 'invalid_update' }
    const validated = validateUpdate(update)
    if (validated === null) return { updated: false, reason: 'invalid_update' }
    const updatedAt = this.now().toISOString()
    try {
      const result = parseScriptResult(await this.redis.eval(
        UPDATE_SCRIPT,
        [ttyWorkerMetadataKey(workerId)],
        [JSON.stringify(validated), validated.version === undefined ? '0' : '1', validated.capabilities === undefined ? '0' : '1', validated.metadata === undefined ? '0' : '1', updatedAt]
      ))
      if (result.code !== 1) return { updated: false, reason: result.value === 'unknown_worker' ? 'unknown_worker' : 'internal_error' }
      const worker = parseWorker(result.value)
      if (worker === null) return { updated: false, reason: 'internal_error' }
      return { updated: true, worker }
    } catch {
      return { updated: false, reason: 'internal_error' }
    }
  }

  async listWorkers(): Promise<readonly TTYWorkerMetadata[]> {
    try {
      const ids = await this.redis.smembers(ttyWorkerRegistryKey())
      const workers = await Promise.all(ids.map(id => {
        const workerId = parseTTYWorkerId(id)
        return workerId === null ? Promise.resolve(null) : this.getWorker(workerId)
      }))
      return workers.filter((worker): worker is TTYWorkerMetadata => worker !== null)
    } catch {
      return []
    }
  }

  async deactivateWorker(workerId: TTYWorkerId): Promise<TTYWorkerStateResult> {
    return this.changeState(workerId, DEACTIVATE_SCRIPT, 'worker_deactivated', 'inactive')
  }

  async reactivateWorker(workerId: TTYWorkerId): Promise<TTYWorkerStateResult> {
    return this.changeState(workerId, REACTIVATE_SCRIPT, 'worker_reactivated', 'active')
  }

  private async changeState(
    workerId: TTYWorkerId,
    script: string,
    eventType: 'worker_deactivated' | 'worker_reactivated',
    expectedStatus: 'active' | 'inactive'
  ): Promise<TTYWorkerStateResult> {
    if (parseTTYWorkerId(workerId) === null) return { changed: false, reason: 'unknown_worker' }
    const changedAt = this.now().toISOString()
    try {
      const result = parseScriptResult(await this.redis.eval(script, [ttyWorkerMetadataKey(workerId)], [changedAt]))
      if (result.code !== 1) return { changed: false, reason: result.value === 'unknown_worker' ? 'unknown_worker' : 'internal_error' }
      const worker = parseWorker(result.value)
      if (worker === null || (eventType === 'worker_deactivated' && worker.status !== 'inactive') || (eventType === 'worker_reactivated' && worker.status !== expectedStatus)) {
        return { changed: false, reason: 'internal_error' }
      }
      await this.emit(eventForWorker(eventType, worker, changedAt))
      return { changed: true, worker }
    } catch {
      return { changed: false, reason: 'internal_error' }
    }
  }

  private async emit(event: TTYWorkerAuditEvent): Promise<void> {
    if (!this.options.audit) return
    try {
      await this.options.audit.appendEvent(event)
    } catch {
      // State mutations remain atomic and authoritative. The audit stream is
      // append-only; a caller can replay state and retry failed emission.
    }
  }
}
