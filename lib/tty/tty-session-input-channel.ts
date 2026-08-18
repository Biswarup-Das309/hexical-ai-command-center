import type { TTYInputBatch } from './tty-input-queue'
import type { TTYSessionId } from './tty-types'

export const TTY_SESSION_INPUT_BROADCAST_EVENT = 'tty-input'

export interface TTYSessionInputChannelRecord {
  readonly sessionId: TTYSessionId
  readonly ownerUserId: string
  readonly channel: string
  readonly token: string
  readonly issuedAtMs: number
}

export interface TTYSessionInputBroadcastPayload {
  readonly sessionId: TTYSessionId
  readonly token: string
  readonly commandId: string
  readonly data: string
  readonly inputEventId: string
  readonly inputSequence: number
  readonly browserTimestampMs: number
}

export function ttySessionInputChannelName(sessionId: TTYSessionId, token: string): string {
  return `hexical-tty-input-${sessionId}-${token}`
}

export function createTTYSessionInputBroadcastPayload(
  record: Pick<TTYSessionInputChannelRecord, 'sessionId' | 'token'>,
  data: string,
  batch: TTYInputBatch,
): TTYSessionInputBroadcastPayload {
  return {
    sessionId: record.sessionId,
    token: record.token,
    commandId: batch.inputEventId,
    data,
    inputEventId: batch.inputEventId,
    inputSequence: batch.sequence,
    browserTimestampMs: batch.browserTimestampMs,
  }
}

export function parseTTYSessionInputBroadcastPayload(value: unknown): TTYSessionInputBroadcastPayload | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (
    typeof record.sessionId !== 'string' ||
    typeof record.token !== 'string' ||
    typeof record.commandId !== 'string' ||
    typeof record.data !== 'string' ||
    typeof record.inputEventId !== 'string' ||
    typeof record.inputSequence !== 'number' ||
    !Number.isSafeInteger(record.inputSequence) ||
    record.inputSequence < 1 ||
    typeof record.browserTimestampMs !== 'number' ||
    !Number.isSafeInteger(record.browserTimestampMs) ||
    record.browserTimestampMs <= 0
  )
    return null
  return {
    sessionId: record.sessionId as TTYSessionId,
    token: record.token,
    commandId: record.commandId,
    data: record.data,
    inputEventId: record.inputEventId,
    inputSequence: record.inputSequence,
    browserTimestampMs: record.browserTimestampMs,
  }
}
