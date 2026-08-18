import 'server-only'

import { auth } from '@clerk/nextjs/server'
import { z } from 'zod'
import { createSupabaseRuntimeStore } from './supabase-runtime-store'
import { ttySessionInputChannelName, type TTYSessionInputChannelRecord } from './tty-session-input-channel'
import { createTTYSessionStore } from './tty-session-store'
import type { TTYSessionId } from './tty-types'
import { ttySessionInputChannelKey } from './tty-worker-keys'

const SESSION_ID = z.string().uuid()
const CHANNEL_TTL_SECONDS = 24 * 60 * 60
const HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'Content-Type': 'application/json',
} as const

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS })
}

function parseRecord(
  value: unknown,
  sessionId: TTYSessionId,
  ownerUserId: string,
): TTYSessionInputChannelRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (
    record.sessionId !== sessionId ||
    record.ownerUserId !== ownerUserId ||
    typeof record.channel !== 'string' ||
    typeof record.token !== 'string' ||
    typeof record.issuedAtMs !== 'number'
  )
    return null
  return {
    sessionId,
    ownerUserId,
    channel: record.channel,
    token: record.token,
    issuedAtMs: record.issuedAtMs,
  }
}

export async function createTTYSessionInputChannelResponse(rawSessionId: string): Promise<Response> {
  const userId = (await auth()).userId
  if (!userId) return json({ ok: false, code: 'UNAUTHENTICATED', message: 'Authentication is required.' }, 401)
  const parsedSessionId = SESSION_ID.safeParse(rawSessionId)
  if (!parsedSessionId.success) return json({ ok: false, code: 'INVALID_INPUT' }, 400)
  const sessionId = parsedSessionId.data as TTYSessionId
  const runtime = createSupabaseRuntimeStore()
  const session = await createTTYSessionStore(runtime).getSession(sessionId, userId)
  if (!session) return json({ ok: false, code: 'SESSION_NOT_FOUND' }, 404)
  if (session.status !== 'active' && session.status !== 'idle')
    return json({ ok: false, code: 'SESSION_NOT_ACTIVE' }, 409)

  const key = ttySessionInputChannelKey(sessionId)
  const existing = parseRecord(await runtime.get<unknown>(key), sessionId, userId)
  if (existing) return json({ ok: true, channel: existing.channel, token: existing.token }, 200)

  const token = crypto.randomUUID()
  const record: TTYSessionInputChannelRecord = {
    sessionId,
    ownerUserId: userId,
    token,
    channel: ttySessionInputChannelName(sessionId, token),
    issuedAtMs: Date.now(),
  }
  await runtime.set(key, record, { nx: true, ex: CHANNEL_TTL_SECONDS })
  const selected = parseRecord(await runtime.get<unknown>(key), sessionId, userId)
  if (!selected) return json({ ok: false, code: 'INTERNAL_ERROR' }, 503)
  return json({ ok: true, channel: selected.channel, token: selected.token }, 200)
}
