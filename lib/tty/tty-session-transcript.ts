/**
 * Durable PTY-session transcript.
 *
 * This is intentionally separate from the execution-output stream: a
 * persistent terminal can emit output without a discrete execution ID, and
 * attaching that output to an arbitrary job would make replay/audit data lie.
 * Only terminal output and browser-safe runtime state are persisted here; raw
 * stdin is never copied into the transcript by this module.
 */

import { TTY_EXECUTION_HISTORY_RETENTION_SECONDS } from './tty-execution-retention'
import { normalizeTTYRedisStreamEntries, normalizeTTYRedisStreamFields } from './tty-redis-stream'
import type { TTYRuntimeStore as Redis } from './tty-runtime-store'
import type { TTYSessionId } from './tty-types'
import {
  ttySessionTranscriptDedupKey,
  ttySessionTranscriptSequenceKey,
  ttySessionTranscriptStreamKey,
} from './tty-worker-keys'

export type TTYSessionTranscriptEventType = 'stdout' | 'system'
export type TTYSessionTranscriptDataValue = string | number | boolean | null
export type TTYSessionTranscriptData = Readonly<Record<string, TTYSessionTranscriptDataValue>>

export interface TTYSessionTranscriptEvent {
  /** Redis Stream cursor, exposed for exclusive replay after reconnect. */
  readonly cursor: string
  readonly eventId: string
  readonly sequence: number
  readonly timestamp: string
  readonly sessionId: TTYSessionId
  readonly type: TTYSessionTranscriptEventType
  readonly data: TTYSessionTranscriptData
}

export interface TTYSessionTranscriptAppendInput {
  readonly sessionId: TTYSessionId
  readonly type: TTYSessionTranscriptEventType
  readonly data: TTYSessionTranscriptData
  readonly timestamp?: string
  /** Stable id used when a runtime journal chunk is replayed after a crash. */
  readonly eventId?: string
}

export interface TTYSessionTranscriptReadOptions {
  readonly start?: string
  readonly end?: string
  readonly count?: number
}

export interface TTYSessionTranscriptReplayOptions {
  readonly after?: string
  readonly count?: number
}

interface PendingState {
  readonly tail: Promise<unknown>
  readonly count: number
}

const MAX_EVENT_DATA_BYTES = 64 * 1024
const MAX_OUTPUT_CHUNK_BYTES = 60 * 1024
const MAX_PENDING_EVENTS = 256
const EVENT_TYPES: readonly TTYSessionTranscriptEventType[] = ['stdout', 'system']

const APPEND_TRANSCRIPT_SCRIPT = `
-- hexical:tty-session-transcript-append
local existing = redis.call('HGET', KEYS[3], ARGV[1])
if existing then
  local separator = string.find(existing, '|')
  if separator then return {string.sub(existing, 1, separator - 1), string.sub(existing, separator + 1)} end
end
local sequence = redis.call('INCR', KEYS[2])
local cursor = redis.call('XADD', KEYS[1], '*',
  'eventId', ARGV[1],
  'sequence', tostring(sequence),
  'timestamp', ARGV[2],
  'sessionId', ARGV[3],
  'type', ARGV[4],
  'data', ARGV[5])
redis.call('EXPIRE', KEYS[1], ARGV[6])
redis.call('EXPIRE', KEYS[2], ARGV[6])
redis.call('HSET', KEYS[3], ARGV[1], tostring(sequence) .. '|' .. cursor)
redis.call('EXPIRE', KEYS[3], ARGV[6])
return {sequence, cursor}
`

function isEventType(value: unknown): value is TTYSessionTranscriptEventType {
  return typeof value === 'string' && EVENT_TYPES.includes(value as TTYSessionTranscriptEventType)
}

function parseAppendResult(value: unknown): { readonly sequence: number; readonly cursor: string } {
  const values = Array.isArray(value) ? value : [value]
  const sequence = Number(values[0])
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error('Invalid TTY session transcript sequence.')
  const cursor = typeof values[1] === 'string' ? values[1] : null
  if (!cursor || !/^\d+-\d+$/.test(cursor)) throw new Error('Invalid TTY session transcript cursor.')
  return { sequence, cursor }
}

function dataBytes(data: TTYSessionTranscriptData): number {
  return Buffer.byteLength(JSON.stringify(data), 'utf8')
}

function validData(data: TTYSessionTranscriptData): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    Object.values(data).every(
      (value) => value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
    )
  )
}

function parseEvent(value: unknown): TTYSessionTranscriptEvent | null {
  const entry = normalizeTTYRedisStreamEntries([value])[0]
  if (!entry || typeof entry[0] !== 'string' || !/^\d+-\d+$/.test(entry[0])) return null
  const fields = normalizeTTYRedisStreamFields(entry[1])
  if (fields === null) return null
  const eventId = typeof fields.eventId === 'string' ? fields.eventId : null
  const timestamp = typeof fields.timestamp === 'string' ? fields.timestamp : null
  const sessionId = typeof fields.sessionId === 'string' ? fields.sessionId : null
  const type = typeof fields.type === 'string' ? fields.type : null
  const sequence = Number(fields.sequence)
  if (!eventId || !timestamp || !sessionId || !isEventType(type) || !Number.isSafeInteger(sequence) || sequence <= 0)
    return null
  try {
    const rawData = fields.data
    const data = typeof rawData === 'string' ? JSON.parse(rawData) : rawData
    if (!validData(data as TTYSessionTranscriptData)) return null
    return Object.freeze({
      cursor: entry[0],
      eventId,
      sequence,
      timestamp,
      sessionId: sessionId as TTYSessionId,
      type,
      data: Object.freeze({ ...(data as TTYSessionTranscriptData) }),
    })
  } catch {
    return null
  }
}

/** Splits text on code-point boundaries so each event stays bounded and replayable. */
function chunkText(text: string): readonly string[] {
  if (Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT_CHUNK_BYTES) return [text]
  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  for (const character of text) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (currentBytes > 0 && currentBytes + bytes > MAX_OUTPUT_CHUNK_BYTES) {
      chunks.push(current)
      current = ''
      currentBytes = 0
    }
    current += character
    currentBytes += bytes
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

export class TTYSessionTranscriptManager {
  private readonly pending = new Map<TTYSessionId, PendingState>()
  private readonly maxPendingEvents: number

  constructor(redis: Redis, options: { readonly maxPendingEvents?: number } = {}) {
    this.redis = redis
    this.maxPendingEvents = Math.max(
      1,
      Math.min(MAX_PENDING_EVENTS, Math.floor(options.maxPendingEvents ?? MAX_PENDING_EVENTS)),
    )
  }

  private readonly redis: Redis

  async append(input: TTYSessionTranscriptAppendInput): Promise<TTYSessionTranscriptEvent> {
    if (!isEventType(input.type) || !validData(input.data) || dataBytes(input.data) > MAX_EVENT_DATA_BYTES)
      throw new Error('Invalid TTY session transcript event.')
    const previous = this.pending.get(input.sessionId)
    if (previous && previous.count >= this.maxPendingEvents) await previous.tail

    const previousTail = this.pending.get(input.sessionId)?.tail ?? Promise.resolve()
    const currentCount = (this.pending.get(input.sessionId)?.count ?? 0) + 1
    const operation = (async () => {
      await previousTail
      const eventId = input.eventId ?? crypto.randomUUID()
      const timestamp = input.timestamp ?? new Date().toISOString()
      const data = Object.freeze({ ...input.data })
      const appended = parseAppendResult(
        await this.redis.eval(
          APPEND_TRANSCRIPT_SCRIPT,
          [
            ttySessionTranscriptStreamKey(input.sessionId),
            ttySessionTranscriptSequenceKey(input.sessionId),
            ttySessionTranscriptDedupKey(input.sessionId),
          ],
          [
            eventId,
            timestamp,
            input.sessionId,
            input.type,
            JSON.stringify(data),
            String(TTY_EXECUTION_HISTORY_RETENTION_SECONDS),
          ],
        ),
      )
      return Object.freeze({
        cursor: appended.cursor,
        eventId,
        sequence: appended.sequence,
        timestamp,
        sessionId: input.sessionId,
        type: input.type,
        data,
      })
    })()
    this.pending.set(input.sessionId, { tail: operation, count: currentCount })
    try {
      return await operation
    } finally {
      const current = this.pending.get(input.sessionId)
      if (current?.tail === operation) this.pending.delete(input.sessionId)
    }
  }

  async appendOutput(input: {
    readonly sessionId: TTYSessionId
    readonly text: string
    readonly timestamp?: string
    readonly executionId?: string
    readonly eventId?: string
  }): Promise<readonly TTYSessionTranscriptEvent[]> {
    if (typeof input.text !== 'string' || input.text.includes('\u0000')) throw new Error('Invalid TTY session output.')
    if (input.text.length === 0) return []
    const events: TTYSessionTranscriptEvent[] = []
    const chunks = chunkText(input.text)
    for (let index = 0; index < chunks.length; index += 1) {
      const text = chunks[index] as string
      events.push(
        await this.append({
          sessionId: input.sessionId,
          type: 'stdout',
          timestamp: input.timestamp,
          ...(input.eventId ? { eventId: `${input.eventId}:${index}` } : {}),
          data: {
            text,
            byteLength: Buffer.byteLength(text, 'utf8'),
            ...(input.executionId ? { executionId: input.executionId } : {}),
          },
        }),
      )
    }
    return Object.freeze(events)
  }

  appendSystem(input: {
    readonly sessionId: TTYSessionId
    readonly event: string
    readonly data?: TTYSessionTranscriptData
    readonly timestamp?: string
  }): Promise<TTYSessionTranscriptEvent> {
    if (typeof input.event !== 'string' || input.event.length === 0 || input.event.length > 128)
      return Promise.reject(new Error('Invalid TTY session system event.'))
    return this.append({
      sessionId: input.sessionId,
      type: 'system',
      timestamp: input.timestamp,
      data: { event: input.event, ...(input.data ?? {}) },
    })
  }

  async read(
    sessionId: TTYSessionId,
    options: TTYSessionTranscriptReadOptions = {},
  ): Promise<readonly TTYSessionTranscriptEvent[]> {
    const start = options.start ?? '-'
    const end = options.end ?? '+'
    const count = options.count === undefined ? undefined : Math.max(1, Math.floor(options.count))
    const raw =
      count === undefined
        ? await this.redis.xrange(ttySessionTranscriptStreamKey(sessionId), start, end)
        : await this.redis.xrange(ttySessionTranscriptStreamKey(sessionId), start, end, count)
    return Object.freeze(
      normalizeTTYRedisStreamEntries(raw)
        .map(parseEvent)
        .filter((event): event is TTYSessionTranscriptEvent => event !== null)
        .sort((left, right) => left.sequence - right.sequence),
    )
  }

  /**
   * Reads only events after a previously returned Redis stream cursor.  The
   * cursor, rather than a best-effort sequence scan, makes browser refresh and
   * reconnect replay exact even when multiple writers append concurrently.
   */
  async replay(
    sessionId: TTYSessionId,
    options: TTYSessionTranscriptReplayOptions = {},
  ): Promise<readonly TTYSessionTranscriptEvent[]> {
    const after = options.after
    if (after !== undefined && !/^\d+-\d+$/.test(after))
      throw new Error('Invalid TTY session transcript replay cursor.')
    return this.read(sessionId, {
      start: after === undefined ? '-' : `(${after}`,
      end: '+',
      ...(options.count === undefined ? {} : { count: options.count }),
    })
  }
}
