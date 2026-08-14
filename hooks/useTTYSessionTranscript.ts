'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createTTYInputQueue } from '@/lib/tty/tty-input-queue'
import type { TTYSessionTranscriptEvent } from '@/lib/tty/tty-session-transcript'

type TTYSessionConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'error'

interface TranscriptResponse {
  readonly ok: true
  readonly events: readonly TTYSessionTranscriptEvent[]
  readonly cursor: string | null
  readonly hasMore: boolean
  readonly sessionState: string
}

interface UseTTYSessionTranscriptResult {
  readonly events: readonly TTYSessionTranscriptEvent[]
  readonly cursor: string | null
  readonly connectionState: TTYSessionConnectionState
  readonly error: string | null
  readonly reconnectCount: number
  readonly open: () => Promise<void>
  readonly write: (data: string) => Promise<void>
  readonly resize: (columns: number, rows: number) => Promise<void>
  readonly reconnect: () => void
}

class RuntimeSessionRequestError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message)
    this.name = 'RuntimeSessionRequestError'
  }
}

const POLL_INTERVAL_MS = 750
const TOUCH_INTERVAL_MS = 15_000
const REPLAY_LIMIT = 2_000

function messageFromBody(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string') {
    return body.message
  }
  return fallback
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: 'no-store' })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const code =
      typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string' ? body.code : null
    throw new RuntimeSessionRequestError(messageFromBody(body, 'The runtime session request failed.'), code)
  }
  return body as T
}

function mergeEvents(
  current: readonly TTYSessionTranscriptEvent[],
  next: readonly TTYSessionTranscriptEvent[],
): readonly TTYSessionTranscriptEvent[] {
  const seen = new Set<string>()
  return [...current, ...next]
    .filter((event) => {
      const key = event.eventId || event.cursor
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-10_000)
}

export function useTTYSessionTranscript(
  sessionId: string | null,
  onSessionUnavailable?: () => Promise<void> | void,
): UseTTYSessionTranscriptResult {
  const [events, setEvents] = useState<readonly TTYSessionTranscriptEvent[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<TTYSessionConnectionState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [reconnectCount, setReconnectCount] = useState(0)
  const cursorRef = useRef<string | null>(null)
  const sessionIdRef = useRef<string | null>(sessionId)
  const generationRef = useRef(0)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touchTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollRef = useRef<(() => Promise<void>) | null>(null)
  const startedRef = useRef(false)
  const onSessionUnavailableRef = useRef(onSessionUnavailable)
  const recoveryAttemptRef = useRef(false)
  const writeQueueRef = useRef<ReturnType<typeof createTTYInputQueue> | null>(null)

  useEffect(() => {
    onSessionUnavailableRef.current = onSessionUnavailable
  }, [onSessionUnavailable])

  const setReplayCursor = useCallback((next: string | null) => {
    cursorRef.current = next
    setCursor(next)
  }, [])

  const control = useCallback(
    async (body: Record<string, unknown>) => {
      if (!sessionId) throw new Error('No persistent runtime session is attached.')
      await readJson(`/api/tty/sessions/${encodeURIComponent(sessionId)}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    },
    [sessionId],
  )

  const open = useCallback(async () => {
    await control({ type: 'open' })
  }, [control])

  const write = useCallback(
    async (data: string) => {
      if (!data) return
      if (!writeQueueRef.current) {
        writeQueueRef.current = createTTYInputQueue((nextData) => control({ type: 'write', data: nextData }))
      }
      await writeQueueRef.current.enqueue(data)
    },
    [control],
  )

  const resize = useCallback(
    async (columns: number, rows: number) => {
      if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows)) return
      await control({ type: 'resize', columns, rows })
    },
    [control],
  )

  const poll = useCallback(async () => {
    const activeSessionId = sessionIdRef.current
    const generation = generationRef.current
    if (!activeSessionId || !startedRef.current) return
    const after = cursorRef.current
    const query = new URLSearchParams({ limit: String(REPLAY_LIMIT) })
    if (after) query.set('after', after)
    try {
      const body = await readJson<TranscriptResponse>(
        `/api/tty/sessions/${encodeURIComponent(activeSessionId)}/transcript?${query.toString()}`,
        { headers: { Accept: 'application/json' } },
      )
      if (generation !== generationRef.current || activeSessionId !== sessionIdRef.current) return
      setEvents((current) => mergeEvents(current, body.events))
      const nextCursor = body.events.at(-1)?.cursor ?? body.cursor ?? after
      setReplayCursor(nextCursor)
      setConnectionState('open')
      setError(null)
      if (body.hasMore && body.events.length > 0 && nextCursor !== after) {
        pollTimerRef.current = setTimeout(() => void pollRef.current?.(), 0)
      } else {
        pollTimerRef.current = setTimeout(() => void pollRef.current?.(), POLL_INTERVAL_MS)
      }
    } catch (cause) {
      if (generation !== generationRef.current || activeSessionId !== sessionIdRef.current) return
      if (
        cause instanceof RuntimeSessionRequestError &&
        (cause.code === 'SESSION_NOT_FOUND' || cause.code === 'SESSION_NOT_ACTIVE') &&
        onSessionUnavailableRef.current &&
        !recoveryAttemptRef.current
      ) {
        recoveryAttemptRef.current = true
        setConnectionState('reconnecting')
        setError('The runtime session is being restored.')
        void Promise.resolve(onSessionUnavailableRef.current())
          .then(() => {
            if (generation === generationRef.current && activeSessionId === sessionIdRef.current) {
              recoveryAttemptRef.current = false
            }
          })
          .catch((repairCause) => {
            if (generation !== generationRef.current || activeSessionId !== sessionIdRef.current) return
            setConnectionState('reconnecting')
            setError(repairCause instanceof Error ? repairCause.message : 'The runtime session could not be restored.')
          })
          .finally(() => {
            if (generation !== generationRef.current || activeSessionId !== sessionIdRef.current) return
            void pollRef.current?.()
          })
        return
      }
      setConnectionState('reconnecting')
      setError(cause instanceof Error ? cause.message : 'Runtime replay is unavailable.')
      pollTimerRef.current = setTimeout(() => void pollRef.current?.(), Math.min(POLL_INTERVAL_MS * 2, 2_000))
    }
  }, [setReplayCursor])
  useEffect(() => {
    pollRef.current = poll
  }, [poll])

  const reconnect = useCallback(() => {
    if (!sessionId) return
    if (pollTimerRef.current !== null) clearTimeout(pollTimerRef.current)
    recoveryAttemptRef.current = false
    setReconnectCount((count) => count + 1)
    setConnectionState('connecting')
    setError(null)
    void open()
      .catch((cause) => {
        setConnectionState('reconnecting')
        setError(cause instanceof Error ? cause.message : 'The runtime shell could not be attached.')
      })
      .finally(() => void pollRef.current?.())
  }, [open, sessionId])

  useEffect(() => {
    sessionIdRef.current = sessionId
    generationRef.current += 1
    const generation = generationRef.current
    startedRef.current = false
    recoveryAttemptRef.current = false
    writeQueueRef.current?.reset()
    writeQueueRef.current = null
    if (pollTimerRef.current !== null) clearTimeout(pollTimerRef.current)
    if (touchTimerRef.current !== null) clearInterval(touchTimerRef.current)
    pollTimerRef.current = null
    touchTimerRef.current = null
    queueMicrotask(() => {
      if (generation !== generationRef.current || sessionIdRef.current !== sessionId) return
      setEvents([])
      setReplayCursor(null)
      setError(null)
      setReconnectCount(0)
    })
    if (!sessionId) {
      queueMicrotask(() => {
        if (generation === generationRef.current && sessionIdRef.current === null) setConnectionState('idle')
      })
      return
    }

    startedRef.current = true
    queueMicrotask(() => {
      if (generation !== generationRef.current || sessionIdRef.current !== sessionId) return
      setConnectionState('connecting')
      void open()
        .catch((cause) => {
          if (sessionIdRef.current !== sessionId) return
          setConnectionState('reconnecting')
          setError(cause instanceof Error ? cause.message : 'The runtime shell could not be attached.')
        })
        .finally(() => {
          if (sessionIdRef.current === sessionId) void pollRef.current?.()
        })
    })
    touchTimerRef.current = setInterval(() => {
      void readJson(`/api/tty/sessions/${encodeURIComponent(sessionId)}/touch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }).catch(() => undefined)
    }, TOUCH_INTERVAL_MS)

    return () => {
      startedRef.current = false
      generationRef.current += 1
      if (pollTimerRef.current !== null) clearTimeout(pollTimerRef.current)
      if (touchTimerRef.current !== null) clearInterval(touchTimerRef.current)
      pollTimerRef.current = null
      touchTimerRef.current = null
    }
  }, [open, sessionId, setReplayCursor])

  return { events, cursor, connectionState, error, reconnectCount, open, write, resize, reconnect }
}
