import { auth } from '@clerk/nextjs/server'
import { z } from 'zod'
import { createSupabaseRuntimeStore } from '@/lib/tty/supabase-runtime-store'
import { normalizeTTYRedisStreamFields } from '@/lib/tty/tty-redis-stream'
import { createTTYSessionStore } from '@/lib/tty/tty-session-store'
import { TTYSessionTranscriptManager, type TTYSessionTranscriptEvent } from '@/lib/tty/tty-session-transcript'
import type { TTYSessionId } from '@/lib/tty/tty-types'
import { ttySessionTranscriptStreamKey } from '@/lib/tty/tty-worker-keys'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SESSION_ID = z.string().uuid()
const CURSOR = /^\d+-\d+$/
const DEFAULT_LIMIT = 2_000

function eventFromRealtime(
  sessionId: TTYSessionId,
  streamId: string,
  rawFields: unknown,
): TTYSessionTranscriptEvent | null {
  if (!/^\d+-\d+$/.test(streamId)) return null
  const fields = normalizeTTYRedisStreamFields(rawFields)
  if (!fields) return null
  const eventId = typeof fields.eventId === 'string' ? fields.eventId : null
  const timestamp = typeof fields.timestamp === 'string' ? fields.timestamp : null
  const eventSessionId = typeof fields.sessionId === 'string' ? fields.sessionId : null
  const type = fields.type === 'stdout' || fields.type === 'system' ? fields.type : null
  const sequence = Number(fields.sequence)
  if (
    !eventId ||
    !timestamp ||
    eventSessionId !== sessionId ||
    !type ||
    !Number.isSafeInteger(sequence) ||
    sequence <= 0
  )
    return null
  let data: unknown = fields.data
  try {
    if (typeof data === 'string') data = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  return {
    cursor: streamId,
    eventId,
    sequence,
    timestamp,
    sessionId,
    type,
    data: data as TTYSessionTranscriptEvent['data'],
  }
}

function sseEvent(event: TTYSessionTranscriptEvent): Uint8Array {
  return new TextEncoder().encode(`event: transcript\ndata: ${JSON.stringify({ event })}\n\n`)
}

function sseError(code: string, message: string): Uint8Array {
  return new TextEncoder().encode(`event: error\ndata: ${JSON.stringify({ code, message })}\n\n`)
}

export async function GET(request: Request, context: { params: Promise<{ sessionId: string }> }): Promise<Response> {
  const rawSessionId = (await context.params).sessionId
  const sessionId = SESSION_ID.safeParse(rawSessionId).success ? (rawSessionId as TTYSessionId) : null
  if (!sessionId) return new Response(JSON.stringify({ ok: false, code: 'INVALID_INPUT' }), { status: 400 })
  const userId = (await auth()).userId
  if (!userId) return new Response(JSON.stringify({ ok: false, code: 'UNAUTHENTICATED' }), { status: 401 })
  const url = new URL(request.url)
  const after = url.searchParams.get('after')
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw)
  if ((after !== null && !CURSOR.test(after)) || !Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_LIMIT)
    return new Response(JSON.stringify({ ok: false, code: 'INVALID_INPUT' }), { status: 400 })

  const store = createSupabaseRuntimeStore()
  const session = await createTTYSessionStore(store).getSession(sessionId, userId)
  if (!session) return new Response(JSON.stringify({ ok: false, code: 'SESSION_NOT_FOUND' }), { status: 404 })
  if (session.status !== 'active' && session.status !== 'idle')
    return new Response(JSON.stringify({ ok: false, code: 'SESSION_NOT_ACTIVE' }), { status: 409 })

  const transcript = new TTYSessionTranscriptManager(store)
  const encoder = new TextEncoder()
  let cleanup: (() => void) | null = null
  let keepAlive: ReturnType<typeof setInterval> | null = null
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    cleanup?.()
    cleanup = null
    if (keepAlive !== null) clearInterval(keepAlive)
    keepAlive = null
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const seen = new Set<string>()
      let replayReady = false
      const pending: TTYSessionTranscriptEvent[] = []
      const emit = (event: TTYSessionTranscriptEvent) => {
        const key = event.eventId || event.cursor
        if (seen.has(key)) return
        seen.add(key)
        controller.enqueue(sseEvent(event))
      }
      const onRealtime = (payload: { readonly streamId: string; readonly fields: unknown }) => {
        const event = eventFromRealtime(sessionId, payload.streamId, payload.fields)
        if (!event) return
        if (!replayReady) pending.push(event)
        else emit(event)
      }
      void (async () => {
        try {
          cleanup = await store.subscribeToStream!(ttySessionTranscriptStreamKey(sessionId), onRealtime)
          const replayed = await transcript.replay(sessionId, { ...(after ? { after } : {}), count: limit })
          for (const event of replayed) emit(event)
          replayReady = true
          pending.sort((left, right) => left.sequence - right.sequence)
          for (const event of pending) emit(event)
          keepAlive = setInterval(() => {
            if (!closed) controller.enqueue(encoder.encode(': keep-alive\n\n'))
          }, 15_000)
          request.signal.addEventListener('abort', close, { once: true })
        } catch (error) {
          if (!closed) {
            controller.enqueue(
              sseError('STREAM_UNAVAILABLE', error instanceof Error ? error.message : 'Transcript stream unavailable.'),
            )
            controller.close()
          }
          close()
        }
      })()
    },
    cancel() {
      close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    },
  })
}
