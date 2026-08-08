/** Ordered live-stream broker with bounded hot replay and Redis recovery. */

import { isTTYExecutionState, isTerminalTTYExecutionState, type TTYTerminalExecutionState } from './tty-execution-state'
import type { TTYExecutionId, TTYSessionId } from './tty-types'
import { ttyExecutionLiveSequenceKey, ttyExecutionLiveStreamKey } from './tty-worker-keys'
import type { TTYOutputEvent } from './tty-output-stream'
import {
  createTTYStreamEvent,
  parseTTYStreamEvent,
  type TTYStreamCompletionPayload,
  type TTYStreamEvent,
  type TTYStreamEventInput,
  type TTYStreamErrorCode
} from './tty-stream-types'

export interface TTYStreamRedis {
  incr(key: string): Promise<number>
  xadd(key: string, id: '*', fields: Record<string, unknown>): Promise<unknown>
  xrange(key: string, start: string, end: string, count?: number): Promise<unknown>
  xtrim?(key: string, options: { readonly strategy: 'MAXLEN'; readonly threshold: number; readonly exactness?: '~' | '=' }): Promise<unknown>
}

export interface TTYStreamBrokerOptions {
  readonly maxBufferedEvents?: number
  readonly maxReplayEvents?: number
  readonly redisPollIntervalMs?: number
  readonly now?: () => Date
}

export interface TTYStreamReplay {
  readonly status: 'ok' | 'gap' | 'unavailable'
  readonly events: readonly TTYStreamEvent[]
  readonly minSequence: number | null
  readonly maxSequence: number | null
  readonly nextSequence: number
  readonly completed: boolean
}

export interface TTYStreamSubscription {
  readonly id: string
  readonly replay: TTYStreamReplay
  unsubscribe(): void
}

export type TTYStreamSubscriber = (event: TTYStreamEvent) => void

type WithoutSequence<T> = T extends unknown ? Omit<T, 'sequence' | 'eventId'> : never
export type TTYStreamPublishInput = WithoutSequence<TTYStreamEventInput>

interface ExecutionBuffer {
  readonly events: TTYStreamEvent[]
  readonly subscribers: Map<string, TTYStreamSubscriber>
  completed: boolean
  lastNotifiedSequence: number
}

interface RedisStreamFieldMap {
  event?: string
  eventId?: string
  sequence?: string
  timestamp?: string
  executionId?: string
  sessionId?: string
  type?: string
  payload?: string
}

const DEFAULT_BUFFERED_EVENTS = 256
const DEFAULT_REPLAY_EVENTS = 512
const DEFAULT_REDIS_POLL_MS = 250

function asFieldMap(value: unknown): RedisStreamFieldMap | null {
  if (Array.isArray(value)) {
    const result: RedisStreamFieldMap = {}
    for (let index = 0; index + 1 < value.length; index += 2) {
      const key = value[index]
      const fieldValue = value[index + 1]
      if (typeof key !== 'string' || (typeof fieldValue !== 'string' && typeof fieldValue !== 'number' && typeof fieldValue !== 'boolean')) return null
      if (key === 'event' || key === 'eventId' || key === 'sequence' || key === 'timestamp' || key === 'executionId' || key === 'sessionId' || key === 'type' || key === 'payload') result[key] = String(fieldValue)
    }
    return result
  }
  if (typeof value !== 'object' || value === null) return null
  const result: RedisStreamFieldMap = {}
  for (const [key, fieldValue] of Object.entries(value)) {
    if (typeof fieldValue !== 'string' && typeof fieldValue !== 'number' && typeof fieldValue !== 'boolean') return null
    if (key === 'event' || key === 'eventId' || key === 'sequence' || key === 'timestamp' || key === 'executionId' || key === 'sessionId' || key === 'type' || key === 'payload') result[key] = String(fieldValue)
  }
  return result
}

function parseRedisEvent(value: unknown): TTYStreamEvent | null {
  if (!Array.isArray(value) || value.length < 2) return null
  const fields = asFieldMap(value[1])
  if (fields === null) return null
  if (fields.event) return parseTTYStreamEvent(fields.event)
  if (!fields.eventId || !fields.executionId || !fields.sessionId || !fields.sequence || !fields.timestamp || !fields.type || !fields.payload) return null
  try {
    return parseTTYStreamEvent(JSON.stringify({
      eventId: fields.eventId,
      executionId: fields.executionId,
      sessionId: fields.sessionId,
      sequence: Number(fields.sequence),
      timestamp: fields.timestamp,
      type: fields.type,
      payload: JSON.parse(fields.payload)
    }))
  } catch {
    return null
  }
}

function terminalState(value: unknown): TTYTerminalExecutionState {
  return typeof value === 'string' && isTTYExecutionState(value) && isTerminalTTYExecutionState(value) ? value : 'failed'
}

function asCompletionPayload(data: Record<string, unknown>): TTYStreamCompletionPayload {
  return {
    state: terminalState(data.state),
    exitCode: typeof data.exitCode === 'number' && Number.isSafeInteger(data.exitCode) ? data.exitCode : null,
    signal: typeof data.signal === 'string' ? data.signal : null,
    failureCode: typeof data.failureCode === 'string' ? data.failureCode : null
  }
}

function outputEventInput(event: TTYOutputEvent): TTYStreamPublishInput {
  switch (event.type) {
    case 'stdout':
    case 'stderr':
      return { executionId: event.executionId, sessionId: event.sessionId, timestamp: event.timestamp, type: event.type, payload: { text: String(event.data.text ?? ''), byteLength: typeof event.data.byteLength === 'number' ? event.data.byteLength : Buffer.byteLength(String(event.data.text ?? ''), 'utf8') } }
    case 'state':
      return { executionId: event.executionId, sessionId: event.sessionId, timestamp: event.timestamp, type: 'state', payload: { state: typeof event.data.state === 'string' && isTTYExecutionState(event.data.state) ? event.data.state : 'failed' } }
    case 'metric':
      return { executionId: event.executionId, sessionId: event.sessionId, timestamp: event.timestamp, type: 'metric', payload: { name: String(event.data.name ?? 'runtime'), value: typeof event.data.value === 'number' ? event.data.value : 0 } }
    case 'completion':
      return { executionId: event.executionId, sessionId: event.sessionId, timestamp: event.timestamp, type: 'completion', payload: asCompletionPayload(event.data) }
  }
}

export class TTYStreamBroker {
  private readonly buffers = new Map<TTYExecutionId, ExecutionBuffer>()
  private readonly tails = new Map<TTYExecutionId, Promise<unknown>>()
  private readonly localSequences = new Map<TTYExecutionId, number>()
  private readonly maxBufferedEvents: number
  private readonly maxReplayEvents: number
  private readonly redisPollIntervalMs: number
  private readonly now: () => Date
  private readonly pollers = new Map<TTYExecutionId, ReturnType<typeof setInterval>>()

  constructor(private readonly redis: TTYStreamRedis | null, options: TTYStreamBrokerOptions = {}) {
    this.maxBufferedEvents = Math.max(1, Math.min(4_096, Math.floor(options.maxBufferedEvents ?? DEFAULT_BUFFERED_EVENTS)))
    this.maxReplayEvents = Math.max(1, Math.min(4_096, Math.floor(options.maxReplayEvents ?? DEFAULT_REPLAY_EVENTS)))
    this.redisPollIntervalMs = Math.max(50, Math.min(10_000, Math.floor(options.redisPollIntervalMs ?? DEFAULT_REDIS_POLL_MS)))
    this.now = options.now ?? (() => new Date())
  }

  async publish(input: TTYStreamPublishInput): Promise<TTYStreamEvent> {
    return this.serialized(input.executionId, async () => {
      const sequence = await this.nextSequence(input.executionId)
      const event = createTTYStreamEvent({ ...input, sequence })
      const buffer = this.bufferFor(input.executionId)
      buffer.events.push(event)
      while (buffer.events.length > this.maxBufferedEvents) buffer.events.shift()
      if (event.type === 'completion') buffer.completed = true
      await this.persist(event)
      buffer.lastNotifiedSequence = Math.max(buffer.lastNotifiedSequence, event.sequence)
      for (const subscriber of buffer.subscribers.values()) {
        try {
          subscriber(event)
        } catch {
          // A broken viewer must never interrupt runtime publication.
        }
      }
      return event
    })
  }

  async publishOutputEvent(event: TTYOutputEvent): Promise<TTYStreamEvent> {
    return this.publish(outputEventInput(event))
  }

  publishHeartbeat(executionId: TTYExecutionId, sessionId: TTYSessionId): Promise<TTYStreamEvent> {
    return this.publish({ executionId, sessionId, type: 'heartbeat', payload: { serverTime: this.now().toISOString() } })
  }

  publishError(executionId: TTYExecutionId, sessionId: TTYSessionId, code: TTYStreamErrorCode, message: string, recoverable: boolean): Promise<TTYStreamEvent> {
    return this.publish({ executionId, sessionId, type: 'error', payload: { code, message, recoverable } })
  }

  async replay(executionId: TTYExecutionId, afterSequence = 0, limit = this.maxReplayEvents): Promise<TTYStreamReplay> {
    return this.serialized(executionId, () => this.replayInternal(executionId, afterSequence, limit))
  }

  async subscribe(executionId: TTYExecutionId, subscriber: TTYStreamSubscriber, afterSequence = 0): Promise<TTYStreamSubscription> {
    return this.serialized(executionId, async () => {
      const replay = await this.replayInternal(executionId, afterSequence, this.maxReplayEvents)
      const id = crypto.randomUUID()
      const buffer = this.bufferFor(executionId)
      buffer.lastNotifiedSequence = Math.max(buffer.lastNotifiedSequence, replay.maxSequence ?? 0)
      buffer.subscribers.set(id, subscriber)
      this.startPoller(executionId)
      let active = true
      return {
        id,
        replay,
        unsubscribe: () => {
          if (!active) return
          active = false
          const current = this.buffers.get(executionId)
          current?.subscribers.delete(id)
          this.cleanup(executionId)
        }
      }
    })
  }

  subscriberCount(executionId: TTYExecutionId): number {
    return this.buffers.get(executionId)?.subscribers.size ?? 0
  }

  close(executionId?: TTYExecutionId): void {
    if (executionId) {
      const buffer = this.buffers.get(executionId)
      buffer?.subscribers.clear()
      this.buffers.delete(executionId)
      this.localSequences.delete(executionId)
      const poller = this.pollers.get(executionId)
      if (poller !== undefined) clearInterval(poller)
      this.pollers.delete(executionId)
      return
    }
    this.buffers.clear()
    this.localSequences.clear()
    for (const poller of this.pollers.values()) clearInterval(poller)
    this.pollers.clear()
  }

  private bufferFor(executionId: TTYExecutionId): ExecutionBuffer {
    const existing = this.buffers.get(executionId)
    if (existing) return existing
    const created: ExecutionBuffer = { events: [], subscribers: new Map(), completed: false, lastNotifiedSequence: 0 }
    this.buffers.set(executionId, created)
    return created
  }

  private cleanup(executionId: TTYExecutionId): void {
    const buffer = this.buffers.get(executionId)
    if (buffer && buffer.subscribers.size === 0 && buffer.events.length === 0) this.buffers.delete(executionId)
    if (buffer && buffer.subscribers.size === 0) {
      const poller = this.pollers.get(executionId)
      if (poller !== undefined) clearInterval(poller)
      this.pollers.delete(executionId)
    }
  }

  private startPoller(executionId: TTYExecutionId): void {
    if (!this.redis || this.pollers.has(executionId)) return
    const poller = setInterval(() => {
      void this.pollRedis(executionId)
    }, this.redisPollIntervalMs)
    if (typeof (poller as unknown as { unref?: () => void }).unref === 'function') (poller as unknown as { unref: () => void }).unref()
    this.pollers.set(executionId, poller)
  }

  private async pollRedis(executionId: TTYExecutionId): Promise<void> {
    const buffer = this.buffers.get(executionId)
    if (!buffer || buffer.subscribers.size === 0 || !this.redis) return
    const replay = await this.serialized(executionId, () => this.replayInternal(executionId, buffer.lastNotifiedSequence, this.maxReplayEvents))
    if (replay.status === 'unavailable') return
    for (const event of replay.events) {
      if (event.sequence <= buffer.lastNotifiedSequence) continue
      buffer.events.push(event)
      while (buffer.events.length > this.maxBufferedEvents) buffer.events.shift()
      if (event.type === 'completion') buffer.completed = true
      buffer.lastNotifiedSequence = event.sequence
      for (const subscriber of buffer.subscribers.values()) {
        try {
          subscriber(event)
        } catch {
          // A broken viewer must never interrupt cross-instance delivery.
        }
      }
    }
  }

  private async nextSequence(executionId: TTYExecutionId): Promise<number> {
    const localNext = (this.localSequences.get(executionId) ?? 0) + 1
    if (!this.redis) {
      this.localSequences.set(executionId, localNext)
      return localNext
    }
    try {
      const redisNext = await this.redis.incr(ttyExecutionLiveSequenceKey(executionId))
      const sequence = Math.max(localNext, redisNext)
      this.localSequences.set(executionId, sequence)
      return sequence
    } catch {
      this.localSequences.set(executionId, localNext)
      return localNext
    }
  }

  private async persist(event: TTYStreamEvent): Promise<void> {
    if (!this.redis) return
    try {
      const serialized = JSON.stringify(event)
      await this.redis.xadd(ttyExecutionLiveStreamKey(event.executionId), '*', {
        event: serialized,
        eventId: event.eventId,
        sequence: String(event.sequence),
        timestamp: event.timestamp,
        executionId: event.executionId,
        sessionId: event.sessionId,
        type: event.type,
        payload: JSON.stringify(event.payload)
      })
      await this.redis.xtrim?.(ttyExecutionLiveStreamKey(event.executionId), { strategy: 'MAXLEN', threshold: this.maxReplayEvents, exactness: '~' })
    } catch {
      // Live delivery remains available from the bounded hot buffer. Replay
      // reports unavailable when neither Redis nor that buffer can recover it.
    }
  }

  private async readPersisted(executionId: TTYExecutionId): Promise<{ events: TTYStreamEvent[]; failed: boolean }> {
    if (!this.redis) return { events: [], failed: false }
    try {
      const raw = await this.redis.xrange(ttyExecutionLiveStreamKey(executionId), '-', '+', this.maxReplayEvents)
      const events = (raw as unknown[]).map(parseRedisEvent).filter((event): event is TTYStreamEvent => event !== null)
      return { events, failed: false }
    } catch {
      return { events: [], failed: true }
    }
  }

  private async replayInternal(executionId: TTYExecutionId, afterSequence: number, requestedLimit: number): Promise<TTYStreamReplay> {
    const safeAfter = Number.isSafeInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0
    const limit = Math.max(1, Math.min(this.maxReplayEvents, Math.floor(requestedLimit)))
    const persisted = await this.readPersisted(executionId)
    const local = this.buffers.get(executionId)?.events ?? []
    const bySequence = new Map<number, TTYStreamEvent>()
    for (const event of [...persisted.events, ...local]) bySequence.set(event.sequence, event)
    const all = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence)
    const minSequence = all[0]?.sequence ?? null
    const maxSequence = all.at(-1)?.sequence ?? null
    const completed = this.buffers.get(executionId)?.completed ?? all.some(event => event.type === 'completion')
    const gap = minSequence !== null && safeAfter < minSequence - 1
    const events = all.filter(event => event.sequence > safeAfter).slice(0, limit)
    return {
      status: gap ? 'gap' : persisted.failed && events.length === 0 ? 'unavailable' : 'ok',
      events,
      minSequence,
      maxSequence,
      nextSequence: events.at(-1)?.sequence !== undefined ? events.at(-1)!.sequence + 1 : safeAfter + 1,
      completed
    }
  }

  private async serialized<T>(executionId: TTYExecutionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(executionId) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    this.tails.set(executionId, current)
    try {
      return await current
    } finally {
      if (this.tails.get(executionId) === current) this.tails.delete(executionId)
    }
  }
}

export function createTTYStreamBroker(redis: TTYStreamRedis | null, options?: TTYStreamBrokerOptions): TTYStreamBroker {
  return new TTYStreamBroker(redis, options)
}
