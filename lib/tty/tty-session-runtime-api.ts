/** Owner-authenticated browser control and durable replay API for one PTY session. */

import { z } from 'zod'
import { denialReasonToFailure } from './tty-policy'
import { publishTTYSessionControl, type TTYSessionControlType } from './tty-session-control'
import type { TTYSessionTranscriptManager } from './tty-session-transcript'
import { summarizeTTYTranscript } from './tty-transcript-diagnostics'
import type { InternalTTYSession, TTYSessionId } from './tty-types'

const SESSION_ID_SCHEMA = z.string().uuid()
const CONTROL_SCHEMA = z.discriminatedUnion('type', [
  z.object({ type: z.literal('open'), commandId: z.string().uuid().optional() }).strict(),
  z
    .object({
      type: z.literal('write'),
      data: z.string().max(64 * 1024),
      commandId: z.string().uuid().optional(),
      inputEventId: z.string().min(1).max(128).optional(),
      inputSequence: z.number().int().min(1).safe().optional(),
      browserTimestampMs: z.number().int().positive().safe().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('resize'),
      columns: z.number().int().min(1).max(500),
      rows: z.number().int().min(1).max(500),
      commandId: z.string().uuid().optional(),
    })
    .strict(),
])
const CURSOR_PATTERN = /^\d+-\d+$/
const MAX_BODY_BYTES = 72 * 1024
const DEFAULT_REPLAY_LIMIT = 500
const MAX_REPLAY_LIMIT = 2_000
const MAX_DIAGNOSTIC_EVENTS = 10_000
const HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'Content-Type': 'application/json',
} as const

type SessionControlInput = z.infer<typeof CONTROL_SCHEMA>

export interface TTYSessionRuntimeStore {
  getSession(sessionId: TTYSessionId, ownerUserId: string): Promise<InternalTTYSession | null>
  touchSession(sessionId: TTYSessionId, ownerUserId: string): Promise<InternalTTYSession | null>
}

export interface TTYSessionRuntimeApiDependencies {
  readonly authenticate: () => Promise<string | null>
  readonly store: TTYSessionRuntimeStore
  readonly transcript: Pick<TTYSessionTranscriptManager, 'replay'> & Partial<Pick<TTYSessionTranscriptManager, 'read'>>
  /** Server adapter binds the runtime store; this API never exposes it to callers. */
  readonly publish: (command: Parameters<typeof publishTTYSessionControl>[1]) => Promise<string>
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS })
}

function failure(reason: Parameters<typeof denialReasonToFailure>[0], status: number): Response {
  const safe = denialReasonToFailure(reason)
  return json({ ok: false, code: safe.code, message: safe.message }, status)
}

function parseSessionId(raw: string): TTYSessionId | null {
  return SESSION_ID_SCHEMA.safeParse(raw).success ? (raw as TTYSessionId) : null
}

function active(session: InternalTTYSession): boolean {
  return session.status === 'active' || session.status === 'idle'
}

async function owner(dependencies: TTYSessionRuntimeApiDependencies): Promise<string | null> {
  const userId = await dependencies.authenticate()
  if (typeof userId !== 'string') return null
  const normalized = userId.trim()
  return normalized.length > 0 && normalized.length <= 200 ? normalized : null
}

async function readBody(request: Request): Promise<unknown | null> {
  const contentLength = request.headers.get('content-length')
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) return null
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function replayLimit(raw: string | null): number | null {
  if (raw === null) return DEFAULT_REPLAY_LIMIT
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_REPLAY_LIMIT ? value : null
}

function toControlCommand(
  sessionId: TTYSessionId,
  ownerUserId: string,
  input: SessionControlInput,
): Parameters<typeof publishTTYSessionControl>[1] {
  const common = {
    sessionId,
    ownerUserId,
    type: input.type as TTYSessionControlType,
    ...(input.commandId ? { commandId: input.commandId } : {}),
  }
  if (input.type === 'write')
    return {
      ...common,
      type: 'write',
      data: input.data,
      ...(input.inputEventId ? { inputEventId: input.inputEventId } : {}),
      ...(input.inputSequence !== undefined ? { inputSequence: input.inputSequence } : {}),
      ...(input.browserTimestampMs !== undefined ? { browserTimestampMs: input.browserTimestampMs } : {}),
    }
  if (input.type === 'resize') return { ...common, type: 'resize', columns: input.columns, rows: input.rows }
  return { ...common, type: 'open' }
}

/**
 * Every browser mutation first validates owner/session state, then writes a
 * bounded command into the durable worker control stream.  A 202 means only
 * "stored for worker delivery"; terminal output always comes from replay.
 */
export function createTTYSessionRuntimeApi(dependencies: TTYSessionRuntimeApiDependencies) {
  return {
    async control(request: Request, rawSessionId: string): Promise<Response> {
      try {
        const userId = await owner(dependencies)
        if (userId === null) return failure('unauthenticated', 401)
        const sessionId = parseSessionId(rawSessionId)
        if (sessionId === null) return failure('input_rejected', 400)
        const parsed = CONTROL_SCHEMA.safeParse(await readBody(request))
        if (!parsed.success) return failure('input_rejected', 400)
        const session = await dependencies.store.getSession(sessionId, userId)
        if (session === null) return failure('session_not_found', 404)
        if (!active(session)) return failure('session_terminated', 409)
        // Interactive stdin is touched by the worker after the live PTY write.
        // Avoid putting a second Postgres round trip in front of every key;
        // the owner-scoped read above still gates admission, and the worker's
        // lease/heartbeat remains authoritative for the attached session.
        if (parsed.data.type !== 'write') {
          const touched = await dependencies.store.touchSession(sessionId, userId)
          if (touched === null || !active(touched)) return failure('session_terminated', 409)
        }
        const commandId = parsed.data.commandId ?? crypto.randomUUID()
        const streamId = await dependencies.publish(toControlCommand(sessionId, userId, { ...parsed.data, commandId }))
        return json(
          {
            ok: true,
            sessionId,
            commandId,
            streamId,
            delivery: 'queued',
          },
          202,
        )
      } catch {
        return failure('internal_error', 503)
      }
    },

    async replay(request: Request, rawSessionId: string): Promise<Response> {
      try {
        const userId = await owner(dependencies)
        if (userId === null) return failure('unauthenticated', 401)
        const sessionId = parseSessionId(rawSessionId)
        if (sessionId === null) return failure('input_rejected', 400)
        const session = await dependencies.store.getSession(sessionId, userId)
        if (session === null) return failure('session_not_found', 404)
        const url = new URL(request.url)
        const after = url.searchParams.get('after')
        const limit = replayLimit(url.searchParams.get('limit'))
        if ((after !== null && !CURSOR_PATTERN.test(after)) || limit === null) return failure('input_rejected', 400)
        const replayedEvents = await dependencies.transcript.replay(sessionId, {
          ...(after === null ? {} : { after }),
          count: limit + 1,
        })
        const hasMore = replayedEvents.length > limit
        const events = hasMore ? replayedEvents.slice(0, limit) : replayedEvents
        return json(
          {
            ok: true,
            sessionId,
            events,
            cursor: events.at(-1)?.cursor ?? after,
            hasMore,
            sessionState: session.status,
          },
          200,
        )
      } catch {
        return failure('internal_error', 503)
      }
    },

    async diagnostics(request: Request, rawSessionId: string): Promise<Response> {
      try {
        const userId = await owner(dependencies)
        if (userId === null) return failure('unauthenticated', 401)
        const sessionId = parseSessionId(rawSessionId)
        if (sessionId === null) return failure('input_rejected', 400)
        const session = await dependencies.store.getSession(sessionId, userId)
        if (session === null) return failure('session_not_found', 404)

        const events = dependencies.transcript.read
          ? await dependencies.transcript.read(sessionId, { count: MAX_DIAGNOSTIC_EVENTS + 1 })
          : await dependencies.transcript.replay(sessionId, { count: MAX_DIAGNOSTIC_EVENTS + 1 })
        const complete = events.length <= MAX_DIAGNOSTIC_EVENTS
        const sampledEvents = complete ? events : events.slice(0, MAX_DIAGNOSTIC_EVENTS)
        return json(
          {
            ok: true,
            sessionId,
            diagnostics: summarizeTTYTranscript(sampledEvents, complete),
          },
          200,
        )
      } catch {
        return failure('internal_error', 503)
      }
    },
  }
}

export type TTYSessionRuntimeApi = ReturnType<typeof createTTYSessionRuntimeApi>
