/** Ordered, bounded Redis-stream persistence for worker output and telemetry. */

import type { Redis } from '@upstash/redis'

import type { TTYExecutionId, TTYSessionId } from './tty-types'
import { ttyExecutionOutputSequenceKey, ttyExecutionOutputStreamKey } from './tty-worker-keys'

export type TTYOutputEventType = 'stdout' | 'stderr' | 'state' | 'metric' | 'completion'
export type TTYOutputEventDataValue = string | number | boolean | null
export type TTYOutputEventData = Readonly<Record<string, TTYOutputEventDataValue>>

export interface TTYOutputEvent {
  readonly eventId: string
  readonly sequence: number
  readonly timestamp: string
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  readonly type: TTYOutputEventType
  readonly data: TTYOutputEventData
}

export interface TTYOutputEventInput {
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  readonly type: TTYOutputEventType
  readonly timestamp?: string
  readonly data: TTYOutputEventData
}

export interface TTYOutputReadOptions {
  readonly start?: string
  readonly end?: string
  readonly count?: number
}

interface PendingState {
  readonly tail: Promise<unknown>
  readonly count: number
}

const MAX_OUTPUT_EVENT_DATA_BYTES = 64 * 1024
const MAX_PENDING_EVENTS = 256
const EVENT_TYPES: readonly TTYOutputEventType[] = ['stdout', 'stderr', 'state', 'metric', 'completion']

const APPEND_OUTPUT_SCRIPT = `
-- hexical:tty-output-append
local sequence = redis.call('INCR', KEYS[2])
redis.call('XADD', KEYS[1], '*',
  'eventId', ARGV[1],
  'sequence', tostring(sequence),
  'timestamp', ARGV[2],
  'executionId', ARGV[3],
  'sessionId', ARGV[4],
  'type', ARGV[5],
  'data', ARGV[6])
return sequence
`

function isOutputEventType(value: unknown): value is TTYOutputEventType {
  return typeof value === 'string' && EVENT_TYPES.includes(value as TTYOutputEventType)
}

function fieldMap(value: unknown): Record<string, string> | null {
  if (Array.isArray(value)) {
    const fields: Record<string, string> = {}
    for (let index = 0; index + 1 < value.length; index += 2) {
      const key = value[index]
      const fieldValue = value[index + 1]
      if (typeof key !== 'string' || (typeof fieldValue !== 'string' && typeof fieldValue !== 'number' && typeof fieldValue !== 'boolean')) return null
      fields[key] = String(fieldValue)
    }
    return fields
  }
  if (typeof value !== 'object' || value === null) return null
  const fields: Record<string, string> = {}
  for (const [key, fieldValue] of Object.entries(value)) {
    if (typeof fieldValue !== 'string' && typeof fieldValue !== 'number' && typeof fieldValue !== 'boolean') return null
    fields[key] = String(fieldValue)
  }
  return fields
}

function parseEvent(value: unknown): TTYOutputEvent | null {
  if (!Array.isArray(value) || value.length < 2 || typeof value[0] !== 'string') return null
  const fields = fieldMap(value[1])
  if (fields === null || !fields.eventId || !fields.timestamp || !fields.executionId || !fields.sessionId || !isOutputEventType(fields.type)) return null
  const sequence = Number(fields.sequence)
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return null
  try {
    const data: unknown = JSON.parse(fields.data ?? '{}')
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
    const values = Object.values(data)
    if (!values.every(value => value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) return null
    return {
      eventId: fields.eventId,
      sequence,
      timestamp: fields.timestamp,
      executionId: fields.executionId as TTYExecutionId,
      sessionId: fields.sessionId as TTYSessionId,
      type: fields.type,
      data: data as TTYOutputEventData
    }
  } catch {
    return null
  }
}

function serializedDataBytes(data: TTYOutputEventData): number {
  return Buffer.byteLength(JSON.stringify(data), 'utf8')
}

function parseSequence(value: unknown): number {
  const sequence = Number(Array.isArray(value) ? value[0] : value)
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error('Invalid TTY output sequence.')
  return sequence
}

export class TTYOutputStreamManager {
  private readonly pending = new Map<TTYExecutionId, PendingState>()
  private readonly maxPendingEvents: number

  constructor(private readonly redis: Redis, options: { readonly maxPendingEvents?: number } = {}) {
    this.maxPendingEvents = Math.max(1, Math.min(MAX_PENDING_EVENTS, Math.floor(options.maxPendingEvents ?? MAX_PENDING_EVENTS)))
  }

  async append(input: TTYOutputEventInput): Promise<TTYOutputEvent> {
    if (!isOutputEventType(input.type) || serializedDataBytes(input.data) > MAX_OUTPUT_EVENT_DATA_BYTES) throw new Error('Invalid TTY output event.')
    const previous = this.pending.get(input.executionId)
    if (previous && previous.count >= this.maxPendingEvents) await previous.tail

    const currentPrevious = this.pending.get(input.executionId)?.tail ?? Promise.resolve()
    const currentCount = (this.pending.get(input.executionId)?.count ?? 0) + 1
    const operation = (async () => {
      await currentPrevious
      const eventId = crypto.randomUUID()
      const timestamp = input.timestamp ?? new Date().toISOString()
      const data = Object.freeze({ ...input.data })
      const sequence = parseSequence(await this.redis.eval(APPEND_OUTPUT_SCRIPT, [ttyExecutionOutputStreamKey(input.executionId), ttyExecutionOutputSequenceKey(input.executionId)], [eventId, timestamp, input.executionId, input.sessionId, input.type, JSON.stringify(data)]))
      const event: TTYOutputEvent = Object.freeze({
        eventId,
        sequence,
        timestamp,
        executionId: input.executionId,
        sessionId: input.sessionId,
        type: input.type,
        data
      })
      return event
    })()
    this.pending.set(input.executionId, { tail: operation, count: currentCount })
    try {
      return await operation
    } finally {
      const current = this.pending.get(input.executionId)
      if (current?.tail === operation) this.pending.delete(input.executionId)
    }
  }

  appendOutput(input: {
    readonly executionId: TTYExecutionId
    readonly sessionId: TTYSessionId
    readonly stream: 'stdout' | 'stderr'
    readonly text: string
    readonly timestamp?: string
  }): Promise<TTYOutputEvent> {
    return this.append({
      executionId: input.executionId,
      sessionId: input.sessionId,
      type: input.stream,
      timestamp: input.timestamp,
      data: { text: input.text, byteLength: Buffer.byteLength(input.text, 'utf8') }
    })
  }

  appendState(input: { readonly executionId: TTYExecutionId; readonly sessionId: TTYSessionId; readonly state: string; readonly timestamp?: string }): Promise<TTYOutputEvent> {
    return this.append({ ...input, type: 'state', data: { state: input.state } })
  }

  appendMetric(input: { readonly executionId: TTYExecutionId; readonly sessionId: TTYSessionId; readonly name: string; readonly value: number; readonly timestamp?: string }): Promise<TTYOutputEvent> {
    return this.append({ ...input, type: 'metric', data: { name: input.name, value: input.value } })
  }

  appendCompletion(input: { readonly executionId: TTYExecutionId; readonly sessionId: TTYSessionId; readonly state: string; readonly timestamp?: string }): Promise<TTYOutputEvent> {
    return this.append({ ...input, type: 'completion', data: { state: input.state } })
  }

  async read(executionId: TTYExecutionId, options: TTYOutputReadOptions = {}): Promise<readonly TTYOutputEvent[]> {
    const start = options.start ?? '-'
    const end = options.end ?? '+'
    const count = options.count === undefined ? undefined : Math.max(1, Math.floor(options.count))
    try {
      const raw = count === undefined
        ? await this.redis.xrange(ttyExecutionOutputStreamKey(executionId), start, end)
        : await this.redis.xrange(ttyExecutionOutputStreamKey(executionId), start, end, count)
      return (raw as unknown as unknown[])
        .map(parseEvent)
        .filter((event): event is TTYOutputEvent => event !== null)
        .sort((left, right) => left.sequence - right.sequence)
    } catch {
      return []
    }
  }
}

