import type { Redis } from '@upstash/redis'
import type { TTYExecutionId, TTYSessionId } from './tty-types'
import { ttyWorkerAuditStreamKey } from './tty-worker-keys'
import { parseTTYWorkerId, type TTYLeaseId, type TTYWorkerId, type TTYWorkerMetadataValue } from './tty-worker-types'

export const TTY_WORKER_AUDIT_EVENT_TYPES = [
  'worker_registered',
  'worker_authenticated',
  'worker_heartbeat',
  'worker_offline',
  'lease_claimed',
  'lease_renewed',
  'lease_released',
  'lease_completed',
  'lease_expired',
  'worker_deactivated',
  'worker_reactivated',
  'execution_state_changed',
  'execution_completed',
  'execution_failed',
  'execution_cancelled',
  'execution_timed_out',
  'execution_recovered',
] as const

export type TTYWorkerAuditEventType = (typeof TTY_WORKER_AUDIT_EVENT_TYPES)[number]
export type TTYWorkerAuditMetadata = Readonly<Record<string, TTYWorkerMetadataValue>>

/** Every audit event has the same complete envelope. Unrelated IDs are null. */
export interface TTYWorkerAuditEvent {
  readonly eventId: string
  readonly timestamp: string
  readonly workerId: TTYWorkerId | null
  readonly sessionId: TTYSessionId | null
  readonly executionId: TTYExecutionId | null
  readonly leaseId: TTYLeaseId | null
  readonly eventType: TTYWorkerAuditEventType
  readonly metadata: TTYWorkerAuditMetadata
}

export interface TTYWorkerAuditSink {
  appendEvent(event: TTYWorkerAuditEvent): Promise<string>
}

export interface TTYWorkerAuditEventInput {
  readonly eventType: TTYWorkerAuditEventType
  readonly timestamp?: string
  readonly workerId?: TTYWorkerId | null
  readonly sessionId?: TTYSessionId | null
  readonly executionId?: TTYExecutionId | null
  readonly leaseId?: TTYLeaseId | null
  readonly metadata?: TTYWorkerAuditMetadata
}

export interface TTYWorkerAuditReadOptions {
  readonly start?: string
  readonly end?: string
  readonly count?: number
}

function validString(value: string, maxLength: number): boolean {
  return value.trim().length > 0 && value.length <= maxLength
}

function validateEvent(event: TTYWorkerAuditEvent): boolean {
  if (!validString(event.eventId, 128) || !validString(event.timestamp, 64)) return false
  if (!TTY_WORKER_AUDIT_EVENT_TYPES.includes(event.eventType)) return false
  if (event.workerId !== null && parseTTYWorkerId(event.workerId) === null) return false
  return true
}

function toFields(event: TTYWorkerAuditEvent): Record<string, string> {
  return {
    eventId: event.eventId,
    timestamp: event.timestamp,
    workerId: event.workerId ?? '',
    sessionId: event.sessionId ?? '',
    executionId: event.executionId ?? '',
    leaseId: event.leaseId ?? '',
    eventType: event.eventType,
    metadata: JSON.stringify(event.metadata),
  }
}

function fieldMap(value: unknown): Record<string, string> | null {
  if (Array.isArray(value)) {
    const fields: Record<string, string> = {}
    for (let index = 0; index + 1 < value.length; index += 2) {
      const key = value[index]
      const fieldValue = value[index + 1]
      if (typeof key !== 'string' || typeof fieldValue !== 'string') return null
      fields[key] = fieldValue
    }
    return fields
  }
  if (typeof value !== 'object' || value === null) return null
  const fields: Record<string, string> = {}
  for (const [key, fieldValue] of Object.entries(value)) {
    if (typeof fieldValue !== 'string') return null
    fields[key] = fieldValue
  }
  return fields
}

function fromStreamEntry(value: unknown): TTYWorkerAuditEvent | null {
  if (!Array.isArray(value) || value.length < 2 || typeof value[0] !== 'string') return null
  const fields = fieldMap(value[1])
  if (fields === null || !fields.eventId || !fields.timestamp || !fields.eventType) return null
  if (!TTY_WORKER_AUDIT_EVENT_TYPES.includes(fields.eventType as TTYWorkerAuditEventType)) return null
  let metadata: TTYWorkerAuditMetadata = {}
  try {
    const parsed: unknown = JSON.parse(fields.metadata ?? '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const values = Object.values(parsed)
    if (
      !values.every(
        (item): item is TTYWorkerMetadataValue =>
          item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
      )
    )
      return null
    metadata = parsed as TTYWorkerAuditMetadata
  } catch {
    return null
  }
  const workerId = fields.workerId ? parseTTYWorkerId(fields.workerId) : null
  if (fields.workerId && workerId === null) return null
  return {
    eventId: fields.eventId,
    timestamp: fields.timestamp,
    workerId,
    sessionId: fields.sessionId ? (fields.sessionId as TTYSessionId) : null,
    executionId: fields.executionId ? (fields.executionId as TTYExecutionId) : null,
    leaseId: fields.leaseId ? (fields.leaseId as TTYLeaseId) : null,
    eventType: fields.eventType as TTYWorkerAuditEventType,
    metadata,
  }
}

export function createTTYWorkerAuditEvent(input: TTYWorkerAuditEventInput): TTYWorkerAuditEvent {
  const event: TTYWorkerAuditEvent = {
    eventId: crypto.randomUUID(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    workerId: input.workerId ?? null,
    sessionId: input.sessionId ?? null,
    executionId: input.executionId ?? null,
    leaseId: input.leaseId ?? null,
    eventType: input.eventType,
    metadata: input.metadata ?? {},
  }
  if (!validateEvent(event)) throw new Error('Invalid TTY worker audit event.')
  return event
}

export function appendTTYWorkerAuditEvent(sink: TTYWorkerAuditSink, input: TTYWorkerAuditEventInput): Promise<string> {
  return sink.appendEvent(createTTYWorkerAuditEvent(input))
}

export class TTYWorkerAudit implements TTYWorkerAuditSink {
  constructor(private readonly redis: Redis) {}

  async appendEvent(event: TTYWorkerAuditEvent): Promise<string> {
    if (!validateEvent(event)) throw new Error('Invalid TTY worker audit event.')
    return this.redis.xadd(ttyWorkerAuditStreamKey(), '*', toFields(event))
  }

  async record(input: TTYWorkerAuditEventInput): Promise<string> {
    return this.appendEvent(createTTYWorkerAuditEvent(input))
  }

  async replay(options: TTYWorkerAuditReadOptions = {}): Promise<readonly TTYWorkerAuditEvent[]> {
    const start = options.start ?? '-'
    const end = options.end ?? '+'
    const count = options.count === undefined ? undefined : Math.max(1, Math.floor(options.count))
    try {
      const rawEntries =
        count === undefined
          ? await this.redis.xrange(ttyWorkerAuditStreamKey(), start, end)
          : await this.redis.xrange(ttyWorkerAuditStreamKey(), start, end, count)
      const entries = rawEntries as unknown as unknown[]
      const parsed = entries
        .map((entry) => fromStreamEntry(entry))
        .filter((event): event is TTYWorkerAuditEvent => event !== null)
      return parsed
    } catch {
      return []
    }
  }
}
