'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createTTYInputQueue } from '@/lib/tty/tty-input-queue'
import type { TTYSessionTranscriptEvent } from '@/lib/tty/tty-session-transcript'

type TTYSessionConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'error'

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

interface UseTTYSessionTranscriptOptions {
  /** Called as soon as a new transcript event reaches the browser stream. */
  readonly onEvent?: (event: TTYSessionTranscriptEvent, timing: { readonly browserReceivedTimestampMs: number }) => void
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

const TOUCH_INTERVAL_MS = 15_000
const REPLAY_LIMIT = 2_000
const TRANSCRIPT_STATE_FLUSH_MS = 16

function messageFromBody(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string') {
    return body.message
  }
  return fallback
}

function runtimeSessionBecameUnavailable(event: TTYSessionTranscriptEvent): boolean {
  if (event.type !== 'system') return false
  const eventName = event.data.event
  return (
    eventName === 'runtime_recovery_unavailable' ||
    eventName === 'runtime_shell_unavailable' ||
    eventName === 'pty_exited' ||
    eventName === 'session_authority_unavailable'
  )
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
  options: UseTTYSessionTranscriptOptions = {},
): UseTTYSessionTranscriptResult {
  const [events, setEvents] = useState<readonly TTYSessionTranscriptEvent[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<TTYSessionConnectionState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [reconnectCount, setReconnectCount] = useState(0)
  const cursorRef = useRef<string | null>(null)
  const sessionIdRef = useRef<string | null>(sessionId)
  const generationRef = useRef(0)
  const touchTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const streamRef = useRef<EventSource | null>(null)
  const streamReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const connectStreamRef = useRef<(() => void) | null>(null)
  const startedRef = useRef(false)
  const onSessionUnavailableRef = useRef(onSessionUnavailable)
  const recoveryAttemptRef = useRef(false)
  const writeQueueRef = useRef<ReturnType<typeof createTTYInputQueue> | null>(null)
  const eventsRef = useRef<readonly TTYSessionTranscriptEvent[]>([])
  const eventKeysRef = useRef(new Set<string>())
  const transcriptStateFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onEventRef = useRef(options.onEvent)

  useEffect(() => {
    onSessionUnavailableRef.current = onSessionUnavailable
  }, [onSessionUnavailable])

  useEffect(() => {
    onEventRef.current = options.onEvent
  }, [options.onEvent])

  const scheduleTranscriptStateFlush = useCallback(() => {
    if (transcriptStateFlushTimerRef.current !== null) return
    transcriptStateFlushTimerRef.current = setTimeout(() => {
      transcriptStateFlushTimerRef.current = null
      setEvents(eventsRef.current)
      setCursor(cursorRef.current)
    }, TRANSCRIPT_STATE_FLUSH_MS)
  }, [])

  const acceptTranscriptEvent = useCallback(
    (event: TTYSessionTranscriptEvent): boolean => {
      const key = event.eventId || event.cursor
      if (eventKeysRef.current.has(key)) return false
      eventKeysRef.current.add(key)
      eventsRef.current = mergeEvents(eventsRef.current, [event])
      if (eventKeysRef.current.size > 12_000) {
        const retainedKeys = new Set(eventsRef.current.map((candidate) => candidate.eventId || candidate.cursor))
        eventKeysRef.current.clear()
        for (const retainedKey of retainedKeys) eventKeysRef.current.add(retainedKey)
      }
      onEventRef.current?.(event, { browserReceivedTimestampMs: Date.now() })
      scheduleTranscriptStateFlush()
      return true
    },
    [scheduleTranscriptStateFlush],
  )

  const setReplayCursor = useCallback(
    (next: string | null) => {
      cursorRef.current = next
      scheduleTranscriptStateFlush()
    },
    [scheduleTranscriptStateFlush],
  )

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
        writeQueueRef.current = createTTYInputQueue((nextData, batch) =>
          control({
            type: 'write',
            data: nextData,
            inputEventId: batch.inputEventId,
            inputSequence: batch.sequence,
            browserTimestampMs: batch.browserTimestampMs,
          }),
        )
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

  const stopStream = useCallback(() => {
    streamRef.current?.close()
    streamRef.current = null
    if (streamReconnectTimerRef.current !== null) clearTimeout(streamReconnectTimerRef.current)
    streamReconnectTimerRef.current = null
  }, [])

  const recoverMissingSession = useCallback(
    (cause: unknown, generation: number, activeSessionId: string): boolean => {
      if (
        generation !== generationRef.current ||
        activeSessionId !== sessionIdRef.current ||
        !(cause instanceof RuntimeSessionRequestError) ||
        !(cause.code === 'SESSION_NOT_FOUND' || cause.code === 'SESSION_NOT_ACTIVE') ||
        !onSessionUnavailableRef.current ||
        recoveryAttemptRef.current
      ) {
        return false
      }

      recoveryAttemptRef.current = true
      setConnectionState('reconnecting')
      setError('The runtime session is being restored.')
      void Promise.resolve(onSessionUnavailableRef.current())
        .then(() => {
          if (generation === generationRef.current && activeSessionId === sessionIdRef.current) {
            recoveryAttemptRef.current = false
            setError(null)
            setConnectionState('connecting')
          }
        })
        .catch((repairCause) => {
          if (generation !== generationRef.current || activeSessionId !== sessionIdRef.current) return
          setConnectionState('reconnecting')
          setError(repairCause instanceof Error ? repairCause.message : 'The runtime session could not be restored.')
        })
        .finally(() => {
          if (generation !== generationRef.current || activeSessionId !== sessionIdRef.current) return
          stopStream()
          connectStreamRef.current?.()
        })
      return true
    },
    [stopStream],
  )

  const connectStream = useCallback(() => {
    const activeSessionId = sessionIdRef.current
    const generation = generationRef.current
    if (!activeSessionId || !startedRef.current) return
    stopStream()
    const query = new URLSearchParams({ limit: String(REPLAY_LIMIT) })
    if (cursorRef.current) query.set('after', cursorRef.current)
    const source = new EventSource(
      `/api/tty/sessions/${encodeURIComponent(activeSessionId)}/transcript/stream?${query.toString()}`,
    )
    streamRef.current = source
    source.onopen = () => {
      if (generation === generationRef.current && activeSessionId === sessionIdRef.current) {
        setConnectionState('open')
        setError(null)
      }
    }
    source.addEventListener('transcript', (message) => {
      if (generation !== generationRef.current || activeSessionId !== sessionIdRef.current) return
      try {
        const parsed = JSON.parse((message as MessageEvent<string>).data) as { event?: TTYSessionTranscriptEvent }
        const event = parsed.event
        if (!event) return
        acceptTranscriptEvent(event)
        setReplayCursor(event.cursor)
        if (runtimeSessionBecameUnavailable(event)) {
          recoverMissingSession(
            new RuntimeSessionRequestError('The persistent runtime shell is unavailable.', 'SESSION_NOT_ACTIVE'),
            generation,
            activeSessionId,
          )
        }
      } catch {
        setError('The runtime transcript returned an invalid event.')
      }
    })
    source.onerror = () => {
      source.close()
      if (streamRef.current === source) streamRef.current = null
      if (generation !== generationRef.current || activeSessionId !== sessionIdRef.current) return
      setConnectionState('reconnecting')
      setError('The runtime transcript stream was interrupted. Reconnecting from durable replay.')
      streamReconnectTimerRef.current = setTimeout(() => connectStreamRef.current?.(), 1_000)
    }
  }, [acceptTranscriptEvent, recoverMissingSession, setReplayCursor, stopStream])
  useEffect(() => {
    connectStreamRef.current = connectStream
  }, [connectStream])

  const reconnect = useCallback(() => {
    if (!sessionId) return
    stopStream()
    recoveryAttemptRef.current = false
    setReconnectCount((count) => count + 1)
    setConnectionState('connecting')
    setError(null)
    void open()
      .catch((cause) => {
        if (recoverMissingSession(cause, generationRef.current, sessionId)) return true
        setConnectionState('reconnecting')
        setError(cause instanceof Error ? cause.message : 'The runtime shell could not be attached.')
        return false
      })
      .then((recoveryStarted) => {
        if (!recoveryStarted) connectStream()
      })
  }, [connectStream, open, recoverMissingSession, sessionId, stopStream])

  useEffect(() => {
    sessionIdRef.current = sessionId
    generationRef.current += 1
    const generation = generationRef.current
    startedRef.current = false
    recoveryAttemptRef.current = false
    writeQueueRef.current?.reset()
    writeQueueRef.current = null
    if (transcriptStateFlushTimerRef.current !== null) clearTimeout(transcriptStateFlushTimerRef.current)
    transcriptStateFlushTimerRef.current = null
    eventsRef.current = []
    eventKeysRef.current.clear()
    stopStream()
    if (touchTimerRef.current !== null) clearInterval(touchTimerRef.current)
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
          if (recoverMissingSession(cause, generation, sessionId)) return true
          setConnectionState('reconnecting')
          setError(cause instanceof Error ? cause.message : 'The runtime shell could not be attached.')
          return false
        })
        .then((recoveryStarted) => {
          if (!recoveryStarted && sessionIdRef.current === sessionId) connectStream()
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
      stopStream()
      if (touchTimerRef.current !== null) clearInterval(touchTimerRef.current)
      touchTimerRef.current = null
    }
  }, [connectStream, open, recoverMissingSession, sessionId, setReplayCursor, stopStream])

  return { events, cursor, connectionState, error, reconnectCount, open, write, resize, reconnect }
}
