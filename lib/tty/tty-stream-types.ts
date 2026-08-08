/** Browser-safe, immutable events emitted by the live TTY stream. */

import type { TTYExecutionId, TTYSessionId } from './tty-types'
import { isTTYExecutionState, isTerminalTTYExecutionState, type TTYExecutionState, type TTYTerminalExecutionState } from './tty-execution-state'

declare const __ttyStreamEventIdBrand: unique symbol

export type TTYStreamEventId = string & { readonly [__ttyStreamEventIdBrand]: true }

export type TTYStreamEventType =
  | 'stdout'
  | 'stderr'
  | 'state'
  | 'metric'
  | 'heartbeat'
  | 'completion'
  | 'error'

export type TTYStreamErrorCode =
  | 'STREAM_GAP'
  | 'STREAM_UNAVAILABLE'
  | 'SLOW_CLIENT'
  | 'INTERNAL_ERROR'

export interface TTYStreamEventBase<TType extends TTYStreamEventType, TPayload> {
  readonly eventId: TTYStreamEventId
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  readonly sequence: number
  readonly timestamp: string
  readonly type: TType
  readonly payload: Readonly<TPayload>
}

export type TTYStreamOutputPayload = Readonly<{
  text: string
  byteLength: number
}>

export type TTYStreamStatePayload = Readonly<{
  state: TTYExecutionState
}>

export type TTYStreamMetricPayload = Readonly<{
  name: string
  value: number
}>

export type TTYStreamHeartbeatPayload = Readonly<{
  serverTime: string
}>

export type TTYStreamCompletionPayload = Readonly<{
  state: TTYTerminalExecutionState
  exitCode: number | null
  signal: string | null
  failureCode: string | null
}>

export type TTYStreamErrorPayload = Readonly<{
  code: TTYStreamErrorCode
  message: string
  recoverable: boolean
}>

export type TTYStreamEvent =
  | TTYStreamEventBase<'stdout' | 'stderr', TTYStreamOutputPayload>
  | TTYStreamEventBase<'state', TTYStreamStatePayload>
  | TTYStreamEventBase<'metric', TTYStreamMetricPayload>
  | TTYStreamEventBase<'heartbeat', TTYStreamHeartbeatPayload>
  | TTYStreamEventBase<'completion', TTYStreamCompletionPayload>
  | TTYStreamEventBase<'error', TTYStreamErrorPayload>

export type TTYStreamEventInput = {
  readonly eventId?: TTYStreamEventId
  readonly executionId: TTYExecutionId
  readonly sessionId: TTYSessionId
  readonly sequence: number
  readonly timestamp?: string
} & (
  | { readonly type: 'stdout' | 'stderr'; readonly payload: TTYStreamOutputPayload }
  | { readonly type: 'state'; readonly payload: TTYStreamStatePayload }
  | { readonly type: 'metric'; readonly payload: TTYStreamMetricPayload }
  | { readonly type: 'heartbeat'; readonly payload: TTYStreamHeartbeatPayload }
  | { readonly type: 'completion'; readonly payload: TTYStreamCompletionPayload }
  | { readonly type: 'error'; readonly payload: TTYStreamErrorPayload }
)

const STREAM_EVENT_TYPES: readonly TTYStreamEventType[] = ['stdout', 'stderr', 'state', 'metric', 'heartbeat', 'completion', 'error']
const STREAM_ERROR_CODES: readonly TTYStreamErrorCode[] = ['STREAM_GAP', 'STREAM_UNAVAILABLE', 'SLOW_CLIENT', 'INTERNAL_ERROR']
const MAX_ID_LENGTH = 200
const MAX_TEXT_LENGTH = 64 * 1024
const MAX_ERROR_MESSAGE_LENGTH = 512

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && !/[\u0000-\u001f\u007f]/.test(value)
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every(key => allowed.has(key))
}

function freezePayload<T extends object>(payload: T): Readonly<T> {
  return Object.freeze({ ...payload })
}

function freezeEvent<T extends TTYStreamEventInput>(input: T): TTYStreamEvent {
  const payload = freezePayload(input.payload)
  return Object.freeze({
    eventId: input.eventId ?? crypto.randomUUID() as TTYStreamEventId,
    executionId: input.executionId,
    sessionId: input.sessionId,
    sequence: input.sequence,
    timestamp: input.timestamp ?? new Date().toISOString(),
    type: input.type,
    payload
  }) as TTYStreamEvent
}

export function createTTYStreamEvent(input: TTYStreamEventInput): TTYStreamEvent {
  if (!validateTTYStreamEvent(input)) throw new Error('Invalid TTY stream event.')
  return freezeEvent(input)
}

export function validateTTYStreamEvent(value: unknown): value is TTYStreamEventInput {
  if (!isPlainRecord(value)) return false
  if (value.eventId !== undefined && !isSafeIdentifier(value.eventId)) return false
  if (!isSafeIdentifier(value.executionId) || !isSafeIdentifier(value.sessionId)) return false
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) <= 0 || (value.timestamp !== undefined && !isIsoTimestamp(value.timestamp))) return false
  if (typeof value.type !== 'string' || !STREAM_EVENT_TYPES.includes(value.type as TTYStreamEventType)) return false
  if (!isPlainRecord(value.payload)) return false
  const payload = value.payload

  switch (value.type) {
    case 'stdout':
    case 'stderr':
      return hasOnlyKeys(payload, ['text', 'byteLength']) && typeof payload.text === 'string' && payload.text.length <= MAX_TEXT_LENGTH && isFiniteNumber(payload.byteLength) && payload.byteLength >= 0
    case 'state':
      return hasOnlyKeys(payload, ['state']) && typeof payload.state === 'string' && isTTYExecutionState(payload.state)
    case 'metric':
      return hasOnlyKeys(payload, ['name', 'value']) && isSafeIdentifier(payload.name) && isFiniteNumber(payload.value)
    case 'heartbeat':
      return hasOnlyKeys(payload, ['serverTime']) && isIsoTimestamp(payload.serverTime)
    case 'completion':
      return hasOnlyKeys(payload, ['state', 'exitCode', 'signal', 'failureCode']) && typeof payload.state === 'string' && isTTYExecutionState(payload.state) && isTerminalTTYExecutionState(payload.state) && (payload.exitCode === null || Number.isSafeInteger(payload.exitCode)) && (payload.signal === null || isSafeIdentifier(payload.signal)) && (payload.failureCode === null || isSafeIdentifier(payload.failureCode))
    case 'error':
      return hasOnlyKeys(payload, ['code', 'message', 'recoverable']) && typeof payload.code === 'string' && STREAM_ERROR_CODES.includes(payload.code as TTYStreamErrorCode) && typeof payload.message === 'string' && payload.message.length <= MAX_ERROR_MESSAGE_LENGTH && typeof payload.recoverable === 'boolean'
  }
  return false
}

export function serializeTTYStreamEvent(event: TTYStreamEvent): string {
  if (!validateTTYStreamEvent(event)) throw new Error('Cannot serialize an invalid TTY stream event.')
  return JSON.stringify(event)
}

export function parseTTYStreamEvent(serialized: string): TTYStreamEvent | null {
  try {
    const value: unknown = JSON.parse(serialized)
    return isPlainRecord(value) && isSafeIdentifier(value.eventId) && isIsoTimestamp(value.timestamp) && validateTTYStreamEvent(value) ? freezeEvent(value) : null
  } catch {
    return null
  }
}
