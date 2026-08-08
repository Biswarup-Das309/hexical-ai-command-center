/** SSE lifecycle, replay, heartbeat, and bounded-client delivery. */

import { createTTYStreamEvent, serializeTTYStreamEvent, type TTYStreamEvent } from './tty-stream-types'
import type { TTYExecutionId, TTYSessionId } from './tty-types'
import { TTYStreamAuthorizer, type TTYStreamAuthorizationFailure, type TTYStreamAuthorizationResult } from './tty-stream-auth'
import { TTYStreamBroker, type TTYStreamSubscription } from './tty-stream-broker'

export interface TTYSSEManagerOptions {
  readonly maxQueueEvents?: number
  readonly maxQueueBytes?: number
  readonly heartbeatIntervalMs?: number
  readonly idleTimeoutMs?: number
  readonly retryMs?: number
  readonly now?: () => Date
}

export interface TTYSSEConnectionRequest {
  readonly userId: string | null | undefined
  readonly executionId: TTYExecutionId
  readonly requestedSessionId?: TTYSessionId
  readonly lastEventId?: string | null
  readonly signal?: AbortSignal
}

export type TTYSSEOpenResult =
  | { readonly accepted: true; readonly response: Response; readonly connectionId: string }
  | { readonly accepted: false; readonly response: Response; readonly reason: string }

interface QueueItem {
  readonly encoded: string
  readonly bytes: number
  readonly event?: TTYStreamEvent
  readonly droppable: boolean
}

const DEFAULT_MAX_QUEUE_EVENTS = 128
const DEFAULT_MAX_QUEUE_BYTES = 256 * 1024
const DEFAULT_HEARTBEAT_MS = 15_000
const DEFAULT_IDLE_TIMEOUT_MS = 120_000
const DEFAULT_RETRY_MS = 3_000
const DROPPABLE_TYPES = new Set(['stdout', 'stderr', 'metric', 'heartbeat'])

function noStoreHeaders(contentType: string): Headers {
  return new Headers({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    'Content-Type': contentType,
    Connection: 'keep-alive'
  })
}

function failureStatus(reason: TTYStreamAuthorizationFailure): number {
  if (reason === 'unauthenticated') return 401
  if (reason === 'permission_denied' || reason === 'session_not_active') return 403
  if (reason === 'internal_error') return 500
  return 404
}

function failureResponse(reason: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, code: reason.toUpperCase(), message: 'The execution stream is not available.' }), { status, headers: noStoreHeaders('application/json') })
}

function encodeEvent(event: TTYStreamEvent, retryMs: number): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${serializeTTYStreamEvent(event)}\nretry: ${retryMs}\n\n`
}

class BoundedSSEQueue {
  private readonly items: QueueItem[] = []
  private bytes = 0
  private closed = false
  droppedEvents = 0

  constructor(private readonly maxEvents: number, private readonly maxBytes: number, private readonly changed: () => void) {}

  enqueue(item: QueueItem): 'accepted' | 'dropped' | 'closed' {
    if (this.closed) return 'closed'
    while (this.items.length >= this.maxEvents || this.bytes + item.bytes > this.maxBytes) {
      const droppableIndex = this.items.findIndex(existing => existing.droppable)
      if (droppableIndex < 0) {
        if (item.event?.type === 'completion') {
          const evictableIndex = this.items.findIndex(existing => existing.event?.type !== 'completion')
          if (evictableIndex >= 0) {
            this.removeAt(evictableIndex)
            continue
          }
          this.droppedEvents += 1
          return 'dropped'
        }
        if (item.droppable) {
          this.droppedEvents += 1
          return 'dropped'
        }
        this.closed = true
        this.changed()
        return 'closed'
      }
      this.removeAt(droppableIndex)
      this.droppedEvents += 1
    }
    this.items.push(item)
    this.bytes += item.bytes
    this.changed()
    return 'accepted'
  }

  shift(): QueueItem | undefined {
    const item = this.items.shift()
    if (item) this.bytes -= item.bytes
    return item
  }

  get length(): number {
    return this.items.length
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.changed()
  }

  get isClosed(): boolean {
    return this.closed
  }

  private removeAt(index: number): void {
    const [removed] = this.items.splice(index, 1)
    if (removed) this.bytes -= removed.bytes
  }
}

export class TTYSSEManager {
  private readonly maxQueueEvents: number
  private readonly maxQueueBytes: number
  private readonly heartbeatIntervalMs: number
  private readonly idleTimeoutMs: number
  private readonly retryMs: number
  private readonly now: () => Date

  constructor(private readonly broker: TTYStreamBroker, private readonly authorizer: TTYStreamAuthorizer, options: TTYSSEManagerOptions = {}) {
    this.maxQueueEvents = Math.max(4, Math.min(1_024, Math.floor(options.maxQueueEvents ?? DEFAULT_MAX_QUEUE_EVENTS)))
    this.maxQueueBytes = Math.max(4_096, Math.min(4 * 1024 * 1024, Math.floor(options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES)))
    this.heartbeatIntervalMs = Math.max(1_000, Math.floor(options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS))
    this.idleTimeoutMs = Math.max(this.heartbeatIntervalMs * 2, Math.floor(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS))
    this.retryMs = Math.max(500, Math.min(60_000, Math.floor(options.retryMs ?? DEFAULT_RETRY_MS)))
    this.now = options.now ?? (() => new Date())
  }

  async open(request: TTYSSEConnectionRequest): Promise<TTYSSEOpenResult> {
    const authorization = await this.authorizer.authorize({ userId: request.userId, executionId: request.executionId, requestedSessionId: request.requestedSessionId })
    if (!authorization.authorized) return { accepted: false, response: failureResponse(authorization.reason, failureStatus(authorization.reason)), reason: authorization.reason }

    const afterSequence = this.parseLastEventId(request.lastEventId)
    if (afterSequence === null) return { accepted: false, response: failureResponse('invalid_last_event_id', 400), reason: 'invalid_last_event_id' }

    const connectionId = crypto.randomUUID()
    let replayReady = false
    const pendingLive: TTYStreamEvent[] = []
    let subscription: TTYStreamSubscription | null = null
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    let closeWhenDrained = false
    let completedQueued = false
    let lastDeliveredAt = this.now().getTime()
    let pumpRunning = false
    let streamClosed = false
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined
    let idleTimer: ReturnType<typeof setInterval> | undefined
    let abortListener: (() => void) | undefined
    let cleanupDone = false

    const queue = new BoundedSSEQueue(this.maxQueueEvents, this.maxQueueBytes, () => pump())

    const cleanup = () => {
      if (cleanupDone) return
      cleanupDone = true
      subscription?.unsubscribe()
      subscription = null
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
      if (idleTimer !== undefined) clearInterval(idleTimer)
      if (abortListener && request.signal) request.signal.removeEventListener('abort', abortListener)
    }

    const closeConnection = () => {
      if (streamClosed) return
      closeWhenDrained = true
      queue.close()
      pump()
    }

    const enqueueRaw = (encoded: string, droppable: boolean): void => {
      queue.enqueue({ encoded, bytes: new TextEncoder().encode(encoded).byteLength, droppable })
    }

    const enqueueEvent = (event: TTYStreamEvent): void => {
      if (event.executionId !== request.executionId || event.sequence <= afterSequence) return
      if (completedQueued) return
      const result = queue.enqueue({ encoded: encodeEvent(event, this.retryMs), bytes: new TextEncoder().encode(encodeEvent(event, this.retryMs)).byteLength, event, droppable: DROPPABLE_TYPES.has(event.type) })
      if (result === 'closed') closeConnection()
      if (result === 'accepted' && event.type === 'completion') {
        completedQueued = true
        closeWhenDrained = true
      }
    }

    const subscriber = (event: TTYStreamEvent) => {
      if (!replayReady) pendingLive.push(event)
      else enqueueEvent(event)
    }

    const pump = () => {
      if (pumpRunning || controller === null || streamClosed) return
      pumpRunning = true
      try {
        while (controller.desiredSize !== null && controller.desiredSize > 0) {
          const item = queue.shift()
          if (!item) break
          controller.enqueue(new TextEncoder().encode(item.encoded))
          lastDeliveredAt = this.now().getTime()
          if (item.event?.type === 'completion') {
            closeWhenDrained = true
            break
          }
        }
        if (closeWhenDrained && queue.length === 0) {
          cleanup()
          streamClosed = true
          controller.close()
        }
      } finally {
        pumpRunning = false
      }
    }

    const replaySubscription = await this.broker.subscribe(request.executionId, subscriber, afterSequence)
    subscription = replaySubscription
    if (replaySubscription.replay.status !== 'ok') {
      const errorCode = replaySubscription.replay.status === 'gap' ? 'STREAM_GAP' : 'STREAM_UNAVAILABLE'
      const errorEvent = createTTYStreamEvent({
        executionId: request.executionId,
        sessionId: authorization.sessionId,
        sequence: Math.max(1, replaySubscription.replay.nextSequence),
        type: 'error',
        payload: { code: errorCode, message: replaySubscription.replay.status === 'gap' ? 'Replay window expired. Reconnect without Last-Event-ID.' : 'The live stream replay is temporarily unavailable.', recoverable: true }
      })
      enqueueEvent(errorEvent)
      closeWhenDrained = true
    } else {
      for (const event of replaySubscription.replay.events) enqueueEvent(event)
      replayReady = true
      for (const event of pendingLive.splice(0)) enqueueEvent(event)
      if (replaySubscription.replay.completed && replaySubscription.replay.events.every(event => event.type !== 'completion')) closeWhenDrained = true
    }

    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController
        pump()
      },
      pull() {
        pump()
      },
      cancel() {
        cleanup()
        streamClosed = true
        queue.close()
      }
    })

    heartbeatTimer = setInterval(() => {
      if (cleanupDone) return
      enqueueRaw(`: heartbeat ${this.now().toISOString()}\n\n`, true)
      pump()
    }, this.heartbeatIntervalMs)
    idleTimer = setInterval(() => {
      if (cleanupDone) return
      if (queue.length > 0 && this.now().getTime() - lastDeliveredAt >= this.idleTimeoutMs) closeConnection()
    }, Math.max(1_000, Math.min(this.idleTimeoutMs, this.heartbeatIntervalMs)))
    if (typeof (heartbeatTimer as unknown as { unref?: () => void }).unref === 'function') (heartbeatTimer as unknown as { unref: () => void }).unref()
    if (typeof (idleTimer as unknown as { unref?: () => void }).unref === 'function') (idleTimer as unknown as { unref: () => void }).unref()

    if (request.signal) {
      abortListener = () => {
        cleanup()
        queue.close()
      }
      if (request.signal.aborted) abortListener()
      else request.signal.addEventListener('abort', abortListener, { once: true })
    }

    const headers = noStoreHeaders('text/event-stream; charset=utf-8')
    headers.set('X-Accel-Buffering', 'no')
    return { accepted: true, response: new Response(stream, { status: 200, headers }), connectionId }
  }

  private parseLastEventId(value: string | null | undefined): number | null {
    if (value === undefined || value === null || value.trim() === '') return 0
    if (!/^\d+$/.test(value.trim())) return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
  }
}
