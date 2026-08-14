/** Durable, owner-authenticated web-to-worker control plane for PTY sessions. */

import type { Redis } from '@upstash/redis'
import type { TTYSessionId } from './tty-types'
import { ttySessionControlGroup, ttySessionControlStreamKey } from './tty-worker-keys'

const MAX_COMMAND_BYTES = 64 * 1024
const MAX_BATCH = 32
const CONTROL_STREAM_RETENTION_SECONDS = 7 * 24 * 60 * 60

export type TTYSessionControlType = 'open' | 'write' | 'resize' | 'terminate'

export interface TTYSessionControlCommand {
  readonly commandId: string
  readonly sessionId: TTYSessionId
  readonly ownerUserId: string
  readonly type: TTYSessionControlType
  readonly data?: string
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
    return typeof command.data === 'string' && Buffer.byteLength(command.data, 'utf8') <= MAX_COMMAND_BYTES
  if (command.type === 'resize') return validDimensions(command.columns, command.rows)
  return command.data === undefined && command.columns === undefined && command.rows === undefined
}

async function ensureControlGroup(redis: Redis, streamKey: string, group: string): Promise<void> {
  try {
    await redis.xgroup(streamKey, {
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
  private readonly streamKey: string
  private readonly group: string
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private started = false
  private reclaimCursor = '0-0'

  constructor(
    private readonly redis: Redis,
    private readonly consumer: string,
    private readonly handler: TTYSessionControlHandler,
    options: TTYSessionControlConsumerOptions = {},
  ) {
    this.minIdleMs = Math.max(1_000, Math.floor(options.minIdleMs ?? 30_000))
    this.batchSize = Math.max(1, Math.min(MAX_BATCH, Math.floor(options.batchSize ?? MAX_BATCH)))
    this.pollIntervalMs = Math.max(50, Math.min(10_000, Math.floor(options.pollIntervalMs ?? 250)))
    this.streamKey = options.streamKey ?? ttySessionControlStreamKey()
    this.group = options.group ?? ttySessionControlGroup()
  }

  async start(): Promise<void> {
    if (this.started) return
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
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  async pollOnce(): Promise<number> {
    if (!this.started || this.polling) return 0
    this.polling = true
    try {
      let reclaimed: unknown
      try {
        reclaimed = await this.redis.xautoclaim(
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
        fresh = await this.redis.xreadgroup(this.group, this.consumer, this.streamKey, '>', {
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
          await this.redis.xack(this.streamKey, this.group, streamId)
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
          await this.redis.xack(this.streamKey, this.group, entry.streamId)
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
}
