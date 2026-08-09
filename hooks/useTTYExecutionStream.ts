'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  appendTTYStreamEvents,
  buildTTYStreamUrl,
  hasTTYStreamSequenceGap,
  isTTYStreamTerminal,
  parseTTYStreamMessage,
  type TTYStreamClientConnectionState
} from '@/lib/tty/tty-stream-client'
import type { TTYStreamEvent } from '@/lib/tty/tty-stream-types'

export interface UseTTYExecutionStreamOptions {
  readonly executionId: string | null
  readonly sessionId?: string
  readonly enabled?: boolean
  readonly maxEvents?: number
  readonly flushIntervalMs?: number
  readonly onExecutionNotFound?: () => void
}

export interface UseTTYExecutionStreamResult {
  readonly events: readonly TTYStreamEvent[]
  readonly connectionState: TTYStreamClientConnectionState
  readonly lastEventId: number | null
  readonly error: string | null
  readonly reconnectCount: number
  readonly gapRecoveryCount: number
  disconnect(): void
  reconnect(): void
  clear(): void
}

const DEFAULT_MAX_EVENTS = 20_000
const DEFAULT_FLUSH_INTERVAL_MS = 32

export function useTTYExecutionStream({
  executionId,
  sessionId,
  enabled = true,
  maxEvents = DEFAULT_MAX_EVENTS,
  flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
  onExecutionNotFound
}: UseTTYExecutionStreamOptions): UseTTYExecutionStreamResult {
  const [events, setEvents] = useState<readonly TTYStreamEvent[]>([])
  const [connectionState, setConnectionState] = useState<TTYStreamClientConnectionState>('idle')
  const [lastEventId, setLastEventId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reconnectCount, setReconnectCount] = useState(0)
  const [gapRecoveryCount, setGapRecoveryCount] = useState(0)
  const sourceRef = useRef<EventSource | null>(null)
  const validationRef = useRef<AbortController | null>(null)
  const connectionAttemptRef = useRef(0)
  const pendingRef = useRef<TTYStreamEvent[]>([])
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSequenceRef = useRef(0)
  const fullReplayRef = useRef(false)
  const connectRef = useRef<(() => void) | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(false)
  const completedRef = useRef(false)

  const flush = useCallback(() => {
    flushTimerRef.current = null
    if (pendingRef.current.length === 0) return
    const pending = pendingRef.current.splice(0)
    setEvents(current => appendTTYStreamEvents(current, pending, maxEvents))
  }, [maxEvents])

  const queueEvent = useCallback((event: TTYStreamEvent) => {
    if (event.executionId !== executionId) return
    if (event.sequence <= 0) return
    if (event.type !== 'error' && hasTTYStreamSequenceGap(lastSequenceRef.current, event)) {
      fullReplayRef.current = true
      setGapRecoveryCount(count => count + 1)
      setConnectionState('reconnecting')
      setError('Stream sequence gap detected; requesting a complete replay.')
      sourceRef.current?.close()
      sourceRef.current = null
      return
    }
    lastSequenceRef.current = Math.max(lastSequenceRef.current, event.sequence)
    setLastEventId(lastSequenceRef.current)
    pendingRef.current.push(event)
    if (isTTYStreamTerminal(event)) completedRef.current = true
    if (flushTimerRef.current === null) flushTimerRef.current = setTimeout(flush, Math.max(0, flushIntervalMs))
  }, [executionId, flush, flushIntervalMs])

  const closeSource = useCallback(() => {
    validationRef.current?.abort()
    validationRef.current = null
    connectionAttemptRef.current += 1
    sourceRef.current?.close()
    sourceRef.current = null
  }, [])

  const handleExecutionNotFound = useCallback(() => {
    completedRef.current = true
    pendingRef.current = []
    lastSequenceRef.current = 0
    setEvents([])
    setLastEventId(null)
    setConnectionState('error')
    setError('No active execution')
    onExecutionNotFound?.()
  }, [onExecutionNotFound])

  const scheduleConnect = useCallback((delayMs: number) => {
    if (!mountedRef.current || !enabled || !executionId || completedRef.current) return
    if (reconnectTimerRef.current !== null) clearTimeout(reconnectTimerRef.current)
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null
      setReconnectCount(count => count + 1)
      setConnectionState('connecting')
      connectRef.current?.()
    }, delayMs)
  }, [enabled, executionId])

  const connect = useCallback(() => {
    if (!mountedRef.current || !enabled || !executionId || completedRef.current || typeof EventSource === 'undefined') return
    closeSource()
    setConnectionState('connecting')
    const url = buildTTYStreamUrl(executionId, sessionId)
    const attempt = connectionAttemptRef.current + 1
    connectionAttemptRef.current = attempt
    const validation = new AbortController()
    validationRef.current = validation

    void fetch(url, { cache: 'no-store', headers: { Accept: 'text/event-stream' }, signal: validation.signal }).then(async response => {
      if (connectionAttemptRef.current !== attempt || !mountedRef.current || completedRef.current) return
      const contentType = response.headers.get('content-type') ?? ''
      if (!response.ok || !contentType.toLowerCase().includes('text/event-stream')) {
        const body: unknown = await response.json().catch(() => null)
        const code = typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string' ? body.code : null
        if (code === 'EXECUTION_NOT_FOUND' || response.status === 404) {
          handleExecutionNotFound()
        } else if (code === 'SESSION_NOT_ACTIVE' || code === 'SESSION_NOT_FOUND') {
          setConnectionState('error')
          setError('The execution session is no longer active.')
        } else {
          setConnectionState('error')
          setError(typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string' ? body.message : 'The execution stream is unavailable.')
        }
        return
      }

      validation.abort()
      validationRef.current = null
      if (connectionAttemptRef.current !== attempt || !mountedRef.current || completedRef.current) return

      const source = new EventSource(url)
      sourceRef.current = source
      source.onopen = () => {
        if (sourceRef.current !== source) return
        setConnectionState('open')
        setError(null)
      }
      source.onerror = () => {
        if (sourceRef.current !== source || completedRef.current) return
        setConnectionState('reconnecting')
        if (source.readyState === EventSource.CLOSED) {
          sourceRef.current = null
          scheduleConnect(fullReplayRef.current ? 250 : 1_000)
        }
      }
      const eventTypes = ['stdout', 'stderr', 'state', 'metric', 'heartbeat', 'completion', 'error'] as const
      for (const type of eventTypes) {
        source.addEventListener(type, (message: Event) => {
          const data = (message as MessageEvent<string>).data
          const event = parseTTYStreamMessage(data)
          if (!event) {
            setError('The execution stream returned an invalid event.')
            return
          }
          if (event.type === 'error') {
            setError(event.payload.message)
            if (event.payload.code === 'STREAM_GAP' || event.payload.code === 'STREAM_UNAVAILABLE') {
              fullReplayRef.current = true
              source.close()
              sourceRef.current = null
              setConnectionState('reconnecting')
              scheduleConnect(250)
              queueEvent(event)
              return
            }
          }
          queueEvent(event)
          if (isTTYStreamTerminal(event)) {
            completedRef.current = true
            source.close()
            sourceRef.current = null
            setConnectionState('completed')
          }
        })
      }
    }).catch(error => {
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (connectionAttemptRef.current !== attempt || !mountedRef.current || completedRef.current) return
      setConnectionState('reconnecting')
      scheduleConnect(fullReplayRef.current ? 250 : 1_000)
    })
  }, [closeSource, enabled, executionId, handleExecutionNotFound, queueEvent, scheduleConnect, sessionId])
  connectRef.current = connect

  const disconnect = useCallback(() => {
    closeSource()
    if (reconnectTimerRef.current !== null) clearTimeout(reconnectTimerRef.current)
    reconnectTimerRef.current = null
    setConnectionState('idle')
  }, [closeSource])

  const reconnect = useCallback(() => {
    completedRef.current = false
    fullReplayRef.current = false
    closeSource()
    setConnectionState('reconnecting')
    scheduleConnect(0)
  }, [closeSource, scheduleConnect])

  const clear = useCallback(() => {
    pendingRef.current = []
    lastSequenceRef.current = 0
    setLastEventId(null)
    setEvents([])
    setError(null)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    completedRef.current = false
    lastSequenceRef.current = 0
    pendingRef.current = []
    setEvents([])
    setLastEventId(null)
    setError(null)
    if (enabled && executionId) connect()
    else setConnectionState('idle')
    return () => {
      mountedRef.current = false
      closeSource()
      if (reconnectTimerRef.current !== null) clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
      if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
  }, [closeSource, connect, enabled, executionId])

  return { events, connectionState, lastEventId, error, reconnectCount, gapRecoveryCount, disconnect, reconnect, clear }
}
