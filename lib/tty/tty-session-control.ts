/** Durable, owner-authenticated web-to-worker control plane for PTY sessions. */

import type { TTYRuntimeStore as Redis } from './tty-runtime-store'
import type { TTYSessionId } from './tty-types'
import { ttySessionControlGroup, ttySessionControlStreamKey } from './tty-worker-keys'

const MAX_COMMAND_BYTES = 64 * 1024
const MAX_BATCH = 32
const CONTROL_STREAM_RETENTION_SECONDS = 7 * 24 * 60 * 60
const DEFAULT_REALTIME_RECONCILIATION_INTERVAL_MS = 5_000
const MAX_REALTIME_RECONCILIATION_READ = 10_000

export type TTYSessionControlType = 'open' | 'write' | 'resize' | 'terminate'

export interface TTYSessionControlCommand {
  readonly commandId: string
  readonly sessionId: TTYSessionId
  readonly ownerUserId: string
  readonly type: TTYSessionControlType
  readonly data?: string
  /** Browser-safe input tracing metadata; terminal contents remain in data only. */
  readonly inputEventId?: string
  readonly inputSequence?: number
  readonly browserTimestampMs?: number
  readonly columns?: number
  readonly rows?: number
  readonly timestamp: string
}

export interface TTYSessionControlEntry extends TTYSessionControlCommand {
  readonly streamId: string
}

export interface TTYSessionControlConsumerOptions {
  readonly minIdleMs?: number
  readonly batchSize?: number
  readonly pollIntervalMs?: number
  /** Durable catch-up for missed Realtime notifications; not the hot path. */
  readonly reconciliationIntervalMs?: number
  readonly streamKey?: string
  readonly group?: string
}

function validText(value: string, maxBytes = 256): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= maxBytes && !value.includes('\u0000')
}

function validDimensions(columns: number | undefined, rows: number | undefined): boolean {
  return (
    Number.isSafeInteger(columns) &&
    Number.isSafeInteger(rows) &&
    (columns as number) >= 1 &&
    (columns as number) <= 500 &&
    (rows as number) >= 1 &&
    (rows as number) <= 500
  )
}

function validCommand(command: TTYSessionControlCommand): boolean {
  if (
    !validText(command.commandId) ||
    !validText(command.sessionId) ||
    !validText(command.ownerUserId, 200) ||
    !validText(command.timestamp, 64) ||
    !['open', 'write', 'resize', 'terminate'].includes(command.type)
  )
    return false
  if (command.type === 'write')
    return (
      typeof command.data === 'string' &&
      Buffer.byteLength(command.data, 'utf8') <= MAX_COMMAND_BYTES &&
      (command.inputEventId === undefined || validText(command.inputEventId, 128)) &&
      (command.inputSequence === undefined ||
        (Number.isSafeInteger(command.inputSequence) && command.inputSequence >= 1)) &&
      (command.browserTimestampMs === undefined ||
        (Number.isSafeInteger(command.browserTimestampMs) && command.browserTimestampMs > 0))
    )
  if (command.type === 'resize') return validDimensions(command.columns, command.rows)
  return command.data === undefined && command.columns === undefined && command.rows === undefined
}

async function ensureControlGroup(redis: Redis, streamKey: string, group: string): Promise<void> {
  if (redis.subscribeToStream) return
  const legacy = redis as Required<Pick<Redis, 'xgroup'>>
  try {
    await legacy.xgroup(streamKey, {
      type: 'CREATE',
      group,
      // Redis stream IDs require the `<milliseconds>-<sequence>` form.
      // Upstash rejects the shorthand `0` with `ERR invalid stream id`,
      // which previously allowed the worker to register and heartbeat before
      // dying while starting its control consumers.
      id: '0-0',
      options: { MKSTREAM: true },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.toUpperCase().includes('BUSYGROUP')) throw error
  }
}

function controlErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error)
}

export async function publishTTYSessionControl(
  redis: Redis,
  command: Omit<TTYSessionControlCommand, 'commandId' | 'timestamp'> &
    Partial<Pick<TTYSessionControlCommand, 'commandId' | 'timestamp'>>,
): Promise<string> {
  const normalized: TTYSessionControlCommand = {
    ...command,
    commandId: command.commandId ?? crypto.randomUUID(),
    timestamp: command.timestamp ?? new Date().toISOString(),
  }
  if (!validCommand(normalized)) throw new Error('Invalid TTY session control command.')
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_COMMAND_BYTES)
    throw new Error('TTY session control command exceeds the bounded payload size.')
  await ensureControlGroup(redis, ttySessionControlStreamKey(), ttySessionControlGroup())
  const streamId = await redis.xadd(ttySessionControlStreamKey(), '*', {
    commandId: normalized.commandId,
    sessionId: normalized.sessionId,
    ownerUserId: normalized.ownerUserId,
    type: normalized.type,
    timestamp: normalized.timestamp,
    ...(normalized.data !== undefined ? { data: normalized.data } : {}),
    ...(normalized.inputEventId !== undefined ? { inputEventId: normalized.inputEventId } : {}),
    ...(normalized.inputSequence !== undefined ? { inputSequence: String(normalized.inputSequence) } : {}),
    ...(normalized.browserTimestampMs !== undefined
      ? { browserTimestampMs: String(normalized.browserTimestampMs) }
      : {}),
    ...(normalized.columns !== undefined ? { columns: String(normalized.columns) } : {}),
    ...(normalized.rows !== undefined ? { rows: String(normalized.rows) } : {}),
  })
  await redis.expire(ttySessionControlStreamKey(), CONTROL_STREAM_RETENTION_SECONDS)
  return streamId
}

function asFields(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    if (value.length % 2 !== 0) return null
    const fields: Record<string, unknown> = {}
    for (let index = 0; index < value.length; index += 2) {
      if (typeof value[index] !== 'string') return null
      fields[value[index] as string] = value[index + 1]
    }
    return fields
  }
  if (typeof value !== 'object' || value === null) return null
  return value as Record<string, unknown>
}

function parseEntry(value: unknown): TTYSessionControlEntry | null {
  if (!Array.isArray(value) || value.length < 2 || typeof value[0] !== 'string') return null
  const fields = asFields(value[1])
  if (fields === null) return null
  const commandId = typeof fields.commandId === 'string' ? fields.commandId : null
  const sessionId = typeof fields.sessionId === 'string' ? fields.sessionId : null
  const ownerUserId = typeof fields.ownerUserId === 'string' ? fields.ownerUserId : null
  const type = typeof fields.type === 'string' ? fields.type : null
  const timestamp = typeof fields.timestamp === 'string' ? fields.timestamp : null
  if (!commandId || !sessionId || !ownerUserId || !timestamp || !type) return null
  const command = {
    streamId: value[0],
    commandId,
    sessionId: sessionId as TTYSessionId,
    ownerUserId,
    type: type as TTYSessionControlType,
    timestamp,
    ...(typeof fields.data === 'string' ? { data: fields.data } : {}),
    ...(typeof fields.inputEventId === 'string' ? { inputEventId: fields.inputEventId } : {}),
    ...(fields.inputSequence !== undefined ? { inputSequence: Number(fields.inputSequence) } : {}),
    ...(fields.browserTimestampMs !== undefined ? { browserTimestampMs: Number(fields.browserTimestampMs) } : {}),
    ...(fields.columns !== undefined ? { columns: Number(fields.columns) } : {}),
    ...(fields.rows !== undefined ? { rows: Number(fields.rows) } : {}),
  } satisfies TTYSessionControlEntry
  return validCommand(command) ? command : null
}

interface ParsedControlBatch {
  readonly entries: readonly TTYSessionControlEntry[]
  readonly invalidIds: readonly string[]
}

function parseReadResponse(value: unknown): ParsedControlBatch {
  const entries: TTYSessionControlEntry[] = []
  const invalidIds: string[] = []
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate) && candidate.length >= 2 && typeof candidate[0] === 'string') {
      const entry = parseEntry(candidate)
      if (entry) entries.push(entry)
      else {
        // A stream entry's fields are also an array, but they are a flat
        // key/value list. Recurse only through a nested list of stream-entry
        // tuples; otherwise acknowledge the actual entry ID. Descending into
        // fields made `commandId` look like a Redis stream ID and caused
        // `ERR invalid stream id` during worker startup.
        const nestedEntries =
          Array.isArray(candidate[1]) && candidate[1].some((item) => Array.isArray(item) && typeof item[0] === 'string')
        if (nestedEntries) visit(candidate[1])
        else invalidIds.push(candidate[0])
      }
      return
    }
    if (Array.isArray(candidate)) for (const item of candidate) visit(item)
    if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
      for (const [streamId, fields] of Object.entries(candidate)) {
        if (/^\d+-\d+$/.test(streamId)) visit([streamId, fields])
        else visit(fields)
      }
    }
  }
  visit(value)
  return { entries, invalidIds }
}

function realtimeStreamSequence(streamId: string): number | null {
  const match = /^(\d+)-\d+$/.exec(streamId)
  if (!match) return null
  const sequence = Number(match[1])
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null
}

function realtimeStreamId(sequence: number): string {
  return `${sequence}-0`
}

export interface TTYSessionControlHandler {
  handle(command: TTYSessionControlEntry): Promise<void>
}

/**
 * Consumer-group delivery loop. A command is acknowledged only after the
 * handler completes. Pending commands older than minIdleMs are reclaimed so a
 * worker crash does not strand stdin/resize/termination requests.
 */
export class TTYSessionControlConsumer {
  private readonly minIdleMs: number
  private readonly batchSize: number
  private readonly pollIntervalMs: number
  private readonly reconciliationIntervalMs: number
  private readonly streamKey: string
  private readonly group: string
  private timer: ReturnType<typeof setInterval> | null = null
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private reconciling = false
  private started = false
  private reclaimCursor = '0-0'
  private realtimeCleanup: (() => void) | null = null
  private realtimeCursor = '0-0'
  private realtimeHighWater = '0-0'
  private realtimeReplayComplete = false
  private realtimePendingEntries: TTYSessionControlEntry[] = []
  private realtimeDeliveredSequence = 0
  private readonly realtimePendingBySequence = new Map<number, TTYSessionControlEntry>()
  private realtimeDrainPromise: Promise<void> | null = null
  /**
   * Realtime callbacks can arrive concurrently.  PTY input is intentionally
   * emitted as small writes, so preserve FIFO order within each session while
   * allowing unrelated sessions to progress independently.
   */
  private readonly realtimeSessionTails = new Map<string, Promise<void>>()

  constructor(
    private readonly redis: Redis,
    private readonly consumer: string,
    private readonly handler: TTYSessionControlHandler,
    options: TTYSessionControlConsumerOptions = {},
  ) {
    this.minIdleMs = Math.max(1_000, Math.floor(options.minIdleMs ?? 30_000))
    this.batchSize = Math.max(1, Math.min(MAX_BATCH, Math.floor(options.batchSize ?? MAX_BATCH)))
    this.pollIntervalMs = Math.max(50, Math.min(10_000, Math.floor(options.pollIntervalMs ?? 250)))
    this.reconciliationIntervalMs = Math.max(
      1_000,
      Math.min(60_000, Math.floor(options.reconciliationIntervalMs ?? DEFAULT_REALTIME_RECONCILIATION_INTERVAL_MS)),
    )
    this.streamKey = options.streamKey ?? ttySessionControlStreamKey()
    this.group = options.group ?? ttySessionControlGroup()
  }

  async start(): Promise<void> {
    if (this.started) return
    if (this.redis.subscribeToStream) {
      this.started = true
      this.realtimeCursor = '0-0'
      this.realtimeHighWater = '0-0'
      this.realtimeReplayComplete = false
      try {
        // Subscribe before the durable replay. Replaying first has a startup
        // race: a command inserted between xrange() and subscribe() is lost.
        this.realtimeCleanup = await this.redis.subscribeToStream(this.streamKey, (payload) => {
          const entry = parseEntry([payload.streamId, payload.fields])
          if (!entry) return
          if (!this.realtimeReplayComplete) {
            this.realtimePendingEntries.push(entry)
            return
          }
          this.queueRealtimeEntry(entry)
        })
        await this.reconcileRealtime(true)
        this.realtimeReplayComplete = true
        this.realtimeCursor = this.realtimeHighWater
        const pendingEntries = this.realtimePendingEntries.splice(0)
        for (const entry of pendingEntries) this.queueRealtimeEntry(entry)
        await this.drainRealtime()
        this.realtimeCursor = this.realtimeHighWater
        this.reconciliationTimer = setInterval(() => {
          void this.reconcileRealtime(false).catch(() => undefined)
        }, this.reconciliationIntervalMs)
      } catch (error) {
        this.started = false
        this.realtimeCleanup?.()
        this.realtimeCleanup = null
        if (this.reconciliationTimer !== null) clearInterval(this.reconciliationTimer)
        this.reconciliationTimer = null
        throw new Error(
          `TTY realtime control subscription failed for ${this.streamKey}: ${controlErrorMessage(error)}`,
          {
            cause: error,
          },
        )
      }
      return
    }
    try {
      await ensureControlGroup(this.redis, this.streamKey, this.group)
    } catch (error) {
      throw new Error(
        `TTY control group initialization failed for ${this.streamKey}/${this.group}: ${controlErrorMessage(error)}`,
        { cause: error },
      )
    }
    this.started = true
    try {
      await this.pollOnce()
    } catch (error) {
      this.started = false
      throw new Error(
        `TTY control stream poll failed for ${this.streamKey}/${this.group}: ${controlErrorMessage(error)}`,
        { cause: error },
      )
    }
    this.timer = setInterval(() => void this.pollOnce(), this.pollIntervalMs)
  }

  async stop(): Promise<void> {
    this.started = false
    this.realtimeCleanup?.()
    this.realtimeCleanup = null
    this.realtimeSessionTails.clear()
    if (this.reconciliationTimer !== null) clearInterval(this.reconciliationTimer)
    this.reconciliationTimer = null
    this.reconciling = false
    this.realtimeCursor = '0-0'
    this.realtimeHighWater = '0-0'
    this.realtimeReplayComplete = false
    this.realtimePendingEntries = []
    this.realtimeDeliveredSequence = 0
    this.realtimePendingBySequence.clear()
    this.realtimeDrainPromise = null
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Reconcile only the durable gap after the last observed cursor. Realtime
   * remains the low-latency path; this protects against channel join races,
   * temporary disconnects, and dropped notifications.
   */
  private async reconcileRealtime(initial: boolean): Promise<void> {
    if (!this.started || this.reconciling) return
    this.reconciling = true
    try {
      const after =
        initial || !this.realtimeReplayComplete ? '-' : `(${realtimeStreamId(this.realtimeDeliveredSequence)}`
      const historical = parseReadResponse(
        await this.redis.xrange(this.streamKey, after, '+', MAX_REALTIME_RECONCILIATION_READ),
      )
      for (const streamId of historical.invalidIds) this.advanceRealtimeCursor(streamId)
      for (const entry of historical.entries) this.queueRealtimeEntry(entry)
      await this.drainRealtime()
      if (this.realtimeReplayComplete) this.realtimeCursor = this.realtimeHighWater
    } finally {
      this.reconciling = false
    }
  }

  private advanceRealtimeCursor(streamId: string): void {
    if (!/^\d+-\d+$/.test(streamId)) return
    const currentSequence = Number(this.realtimeHighWater.split('-')[0])
    const nextSequence = Number(streamId.split('-')[0])
    if (nextSequence > currentSequence) this.realtimeHighWater = streamId
    if (this.realtimeReplayComplete) this.realtimeCursor = this.realtimeHighWater
  }

  private enqueueRealtimeEntry(entry: TTYSessionControlEntry): Promise<void> {
    const previous = this.realtimeSessionTails.get(entry.sessionId) ?? Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(() => this.deliver(entry))
      .then(() => this.advanceRealtimeCursor(entry.streamId))
    this.realtimeSessionTails.set(entry.sessionId, current)
    void current
      .finally(() => {
        if (this.realtimeSessionTails.get(entry.sessionId) === current) {
          this.realtimeSessionTails.delete(entry.sessionId)
        }
      })
      .catch(() => undefined)
    return current
  }

  /**
   * Supabase Realtime preserves row durability but does not promise that
   * INSERT callbacks arrive in stream-sequence order. A later stdin batch
   * arriving before the Enter batch can otherwise write directly into tmux
   * and merge two shell commands. Reassemble only the affected stream gap
   * from durable rows, then dispatch each session through its own tail so
   * unrelated sessions remain concurrent.
   */
  private queueRealtimeEntry(entry: TTYSessionControlEntry): void {
    const sequence = realtimeStreamSequence(entry.streamId)
    if (sequence === null) {
      void this.enqueueRealtimeEntry(entry).catch(() => undefined)
      return
    }
    if (sequence <= this.realtimeDeliveredSequence) return
    if (!this.realtimePendingBySequence.has(sequence)) this.realtimePendingBySequence.set(sequence, entry)
    void this.drainRealtime().catch(() => undefined)
  }

  private drainRealtime(): Promise<void> {
    if (this.realtimeDrainPromise !== null) return this.realtimeDrainPromise
    let operation!: Promise<void>
    operation = (async () => {
      while (this.started && this.realtimePendingBySequence.size > 0) {
        let sequence = this.realtimeDeliveredSequence + 1
        let entry = this.realtimePendingBySequence.get(sequence)
        if (!entry) {
          const pendingSequences = [...this.realtimePendingBySequence.keys()].sort((left, right) => left - right)
          const smallestPending = pendingSequences[0]
          if (smallestPending === undefined) break

          if (smallestPending > sequence) {
            const recovered = parseReadResponse(
              await this.redis.xrange(
                this.streamKey,
                `(${realtimeStreamId(this.realtimeDeliveredSequence)}`,
                realtimeStreamId(smallestPending),
                MAX_REALTIME_RECONCILIATION_READ,
              ),
            )
            for (const streamId of recovered.invalidIds) this.advanceRealtimeCursor(streamId)
            for (const recoveredEntry of recovered.entries) {
              const recoveredSequence = realtimeStreamSequence(recoveredEntry.streamId)
              if (
                recoveredSequence !== null &&
                recoveredSequence > this.realtimeDeliveredSequence &&
                !this.realtimePendingBySequence.has(recoveredSequence)
              )
                this.realtimePendingBySequence.set(recoveredSequence, recoveredEntry)
            }
            entry = this.realtimePendingBySequence.get(sequence)
          }

          // If a durable row has already expired or was trimmed, do not
          // strand later input forever. The control stream normally retains
          // rows for seven days, so this is only a fail-forward guard for an
          // actual retention gap.
          if (!entry) {
            sequence = smallestPending
            entry = this.realtimePendingBySequence.get(sequence)
          }
        }
        if (!entry) break
        this.realtimePendingBySequence.delete(sequence)
        this.realtimeDeliveredSequence = sequence
        this.advanceRealtimeCursor(entry.streamId)
        void this.enqueueRealtimeEntry(entry).catch(() => undefined)
      }
      this.realtimeCursor = this.realtimeHighWater
    })().finally(() => {
      if (this.realtimeDrainPromise !== operation) return
      this.realtimeDrainPromise = null
      if (this.started && this.realtimePendingBySequence.size > 0) void this.drainRealtime().catch(() => undefined)
    })
    this.realtimeDrainPromise = operation
    return operation
  }

  async pollOnce(): Promise<number> {
    if (!this.started || this.polling) return 0
    if (this.redis.subscribeToStream) return 0
    const legacy = this.redis as Required<Pick<Redis, 'xautoclaim' | 'xreadgroup' | 'xack'>>
    this.polling = true
    try {
      let reclaimed: unknown
      try {
        reclaimed = await legacy.xautoclaim(
          this.streamKey,
          this.group,
          this.consumer,
          this.minIdleMs,
          this.reclaimCursor,
          { count: this.batchSize },
        )
      } catch (error) {
        throw new Error(`xautoclaim failed for ${this.streamKey}/${this.group}: ${controlErrorMessage(error)}`, {
          cause: error,
        })
      }
      const reclaimedBatch = parseReadResponse(Array.isArray(reclaimed) ? reclaimed[1] : reclaimed)
      if (Array.isArray(reclaimed) && typeof reclaimed[0] === 'string') this.reclaimCursor = reclaimed[0]
      let fresh: unknown
      try {
        fresh = await legacy.xreadgroup(this.group, this.consumer, this.streamKey, '>', {
          count: this.batchSize,
        })
      } catch (error) {
        throw new Error(`xreadgroup failed for ${this.streamKey}/${this.group}: ${controlErrorMessage(error)}`, {
          cause: error,
        })
      }
      const freshBatch = parseReadResponse(fresh)
      const entries = [...reclaimedBatch.entries, ...freshBatch.entries]
      const invalidIds = [...reclaimedBatch.invalidIds, ...freshBatch.invalidIds]
      let processed = 0
      for (const streamId of invalidIds) {
        try {
          await legacy.xack(this.streamKey, this.group, streamId)
        } catch (error) {
          throw new Error(
            `xack failed for ${this.streamKey}/${this.group}/${streamId}: ${controlErrorMessage(error)}`,
            {
              cause: error,
            },
          )
        }
      }
      for (const entry of entries) {
        try {
          await this.handler.handle(entry)
          await legacy.xack(this.streamKey, this.group, entry.streamId)
          processed += 1
        } catch {
          // Leave the entry in the pending list. A later worker will reclaim it
          // after minIdleMs, preserving at-least-once delivery for control input.
        }
      }
      return processed
    } finally {
      this.polling = false
    }
  }

  private async deliverInvalid(streamId: string): Promise<void> {
    if (this.redis.subscribeToStream) return
    const legacy = this.redis as Required<Pick<Redis, 'xack'>>
    await legacy.xack(this.streamKey, this.group, streamId)
  }

  private async deliver(entry: TTYSessionControlEntry | null): Promise<void> {
    if (!entry) return
    const receiptKey = `tty:control:receipt:${entry.commandId}`
    const accepted = await this.redis.set(receiptKey, entry.streamId, {
      nx: true,
      ex: CONTROL_STREAM_RETENTION_SECONDS,
    })
    if (accepted === null) return
    try {
      await this.handler.handle(entry)
    } catch (error) {
      await this.redis.del(receiptKey)
      throw error
    }
  }
}
