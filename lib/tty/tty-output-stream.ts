/** Ordered, bounded Redis-stream persistence for worker output and telemetry. */

import type { Redis } from '@upstash/redis'
import { log } from '@/lib/hexical/telemetry'
import { TTY_EXECUTION_HISTORY_RETENTION_SECONDS } from './tty-execution-retention'
import { normalizeTTYRedisStreamEntries, normalizeTTYRedisStreamFields } from './tty-redis-stream'
import type { TTYExecutionId, TTYSessionId } from './tty-types'
import {
  ttyExecutionOutputDedupKey,
  ttyExecutionOutputSequenceKey,
  ttyExecutionOutputStreamKey,
} from './tty-worker-keys'

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
  /** Stable id makes replay from a durable PTY transcript idempotent. */
  readonly eventId?: string
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
local existing = redis.call('HGET', KEYS[3], ARGV[1])
if existing then return existing end
local sequence = redis.call('INCR', KEYS[2])
redis.call('XADD', KEYS[1], '*',
  'eventId', ARGV[1],
  'sequence', tostring(sequence),
  'timestamp', ARGV[2],
  'executionId', ARGV[3],
  'sessionId', ARGV[4],
  'type', ARGV[5],
  'data', ARGV[6])
redis.call('EXPIRE', KEYS[1], ARGV[7])
redis.call('EXPIRE', KEYS[2], ARGV[7])
redis.call('HSET', KEYS[3], ARGV[1], tostring(sequence))
redis.call('EXPIRE', KEYS[3], ARGV[7])
return sequence
`

function isOutputEventType(value: unknown): value is TTYOutputEventType {
  return typeof value === 'string' && EVENT_TYPES.includes(value as TTYOutputEventType)
}

function fieldMap(value: unknown): Readonly<Record<string, unknown>> | null {
  return normalizeTTYRedisStreamFields(value)
}

function parseEvent(value: unknown): TTYOutputEvent | null {
  const entry = normalizeTTYRedisStreamEntries([value])[0]
  if (!entry) return null
  const fields = fieldMap(entry[1])
  const eventId = typeof fields?.eventId === 'string' ? fields.eventId : null
  const timestamp = typeof fields?.timestamp === 'string' ? fields.timestamp : null
  const executionId = typeof fields?.executionId === 'string' ? fields.executionId : null
  const sessionId = typeof fields?.sessionId === 'string' ? fields.sessionId : null
  const type = typeof fields?.type === 'string' ? fields.type : null
  const sequenceValue = fields?.sequence
  if (fields === null || !eventId || !timestamp || !executionId || !sessionId || !isOutputEventType(type)) return null
  const sequence = Number(sequenceValue)
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return null
  try {
    const rawData = fields.data
    const data: unknown = typeof rawData === 'string' ? JSON.parse(rawData) : rawData ?? {}
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
    const values = Object.values(data)
    if (
      !values.every(
        (value) =>
          value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
      )
    )
      return null
    return {
      eventId,
      sequence,
      timestamp,
      executionId: executionId as TTYExecutionId,
      sessionId: sessionId as TTYSessionId,
      type,
      data: data as TTYOutputEventData,
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

  constructor(
    private readonly redis: Redis,
    options: { readonly maxPendingEvents?: number } = {},
  ) {
    this.maxPendingEvents = Math.max(
      1,
      Math.min(MAX_PENDING_EVENTS, Math.floor(options.maxPendingEvents ?? MAX_PENDING_EVENTS)),
    )
  }

  async append(input: TTYOutputEventInput): Promise<TTYOutputEvent> {
    if (!isOutputEventType(input.type) || serializedDataBytes(input.data) > MAX_OUTPUT_EVENT_DATA_BYTES)
      throw new Error('Invalid TTY output event.')
    const previous = this.pending.get(input.executionId)
    if (previous && previous.count >= this.maxPendingEvents) await previous.tail

    const currentPrevious = this.pending.get(input.executionId)?.tail ?? Promise.resolve()
    const currentCount = (this.pending.get(input.executionId)?.count ?? 0) + 1
    const operation = (async () => {
      await currentPrevious
      const eventId = input.eventId ?? crypto.randomUUID()
      const timestamp = input.timestamp ?? new Date().toISOString()
      const data = Object.freeze({ ...input.data })
      const sequence = parseSequence(
        await this.redis.eval(
          APPEND_OUTPUT_SCRIPT,
          [
            ttyExecutionOutputStreamKey(input.executionId),
            ttyExecutionOutputSequenceKey(input.executionId),
            ttyExecutionOutputDedupKey(input.executionId),
          ],
          [
            eventId,
            timestamp,
            input.executionId,
            input.sessionId,
            input.type,
            JSON.stringify(data),
            String(TTY_EXECUTION_HISTORY_RETENTION_SECONDS),
          ],
        ),
      )
      const event: TTYOutputEvent = Object.freeze({
        eventId,
        sequence,
        timestamp,
        executionId: input.executionId,
        sessionId: input.sessionId,
        type: input.type,
        data,
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
    readonly transport?: 'subprocess' | 'persistent_pty'
    readonly eventId?: string
  }): Promise<TTYOutputEvent> {
    return this.append({
      executionId: input.executionId,
      sessionId: input.sessionId,
      type: input.stream,
      ...(input.eventId ? { eventId: input.eventId } : {}),
      timestamp: input.timestamp,
      data: {
        text: input.text,
        byteLength: Buffer.byteLength(input.text, 'utf8'),
        ...(input.transport ? { transport: input.transport } : {}),
      },
    })
  }

  appendState(input: {
    readonly executionId: TTYExecutionId
    readonly sessionId: TTYSessionId
    readonly state: string
    readonly timestamp?: string
  }): Promise<TTYOutputEvent> {
    return this.append({ ...input, type: 'state', data: { state: input.state } })
  }

  appendMetric(input: {
    readonly executionId: TTYExecutionId
    readonly sessionId: TTYSessionId
    readonly name: string
    readonly value: number
    readonly timestamp?: string
  }): Promise<TTYOutputEvent> {
    return this.append({ ...input, type: 'metric', data: { name: input.name, value: input.value } })
  }

  appendCompletion(input: {
    readonly executionId: TTYExecutionId
    readonly sessionId: TTYSessionId
    readonly state: string
    readonly timestamp?: string
  }): Promise<TTYOutputEvent> {
    return this.append({ ...input, type: 'completion', data: { state: input.state } })
  }

  async read(executionId: TTYExecutionId, options: TTYOutputReadOptions = {}): Promise<readonly TTYOutputEvent[]> {
    const start = options.start ?? '-'
    const end = options.end ?? '+'
    const count = options.count === undefined ? undefined : Math.max(1, Math.floor(options.count))
    try {
      const raw =
        count === undefined
          ? await this.redis.xrange(ttyExecutionOutputStreamKey(executionId), start, end)
          : await this.redis.xrange(ttyExecutionOutputStreamKey(executionId), start, end, count)
      return normalizeTTYRedisStreamEntries(raw)
        .map(parseEvent)
        .filter((event): event is TTYOutputEvent => event !== null)
        .sort((left, right) => left.sequence - right.sequence)
    } catch (error) {
      log.warn('tty.output.read_failed', {
        executionId,
        errorCode: error instanceof Error && error.name ? error.name.slice(0, 80) : 'unknown_error',
      })
      throw error instanceof Error ? error : new Error('TTY output read failed.')
    }
  }
}
