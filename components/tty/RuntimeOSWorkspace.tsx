'use client'

import { Cable, CircleStop, History, Plus, RefreshCw, Send, TerminalSquare, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTTYExecutionStream } from '@/hooks/useTTYExecutionStream'
import { useTTYSessionTranscript } from '@/hooks/useTTYSessionTranscript'
import { recordTTYBrowserOutputLatency } from '@/lib/tty/tty-browser-latency'
import type { TTYExecutionState } from '@/lib/tty/tty-execution-state'
import type { TTYSessionTranscriptEvent } from '@/lib/tty/tty-session-transcript'
import { latestTTYStreamExecutionState, projectTTYExecutionHistoryState } from '@/lib/tty/tty-stream-client'
import { ExecutionHistory, type TTYExecutionHistoryEntry } from './ExecutionHistory'
import { ExecutionResourceMonitor } from './ExecutionResourceMonitor'
import { ExecutionTimeline } from './ExecutionTimeline'
import { InvestigationTerminal, type InvestigationTerminalHandle } from './InvestigationTerminal'

interface RuntimeOSWorkspaceProps {
  readonly title: string
  readonly sessionId: string | null
  readonly executions: readonly TTYExecutionHistoryEntry[]
  readonly selectedExecutionId: string | null
  readonly activeExecutionState: TTYExecutionState | null
  readonly onSelectExecution: (executionId: string) => void
  readonly onExecute: (input: string) => Promise<void>
  readonly onCancel: () => Promise<void>
  readonly onTerminateSession: () => Promise<void>
  readonly onRecoverSession?: () => Promise<void>
  readonly onNewInvestigation?: () => Promise<void> | void
  readonly sessionError?: string | null
  readonly executionError?: string | null
  readonly lastSubmittedInput: string | null
}

interface RuntimeTab {
  readonly id: string
  readonly label: string
  readonly primary: boolean
}

interface CreatedSessionResponse {
  readonly ok: true
  readonly session: { readonly sessionId: string }
}

interface ListedSessionsResponse {
  readonly ok: true
  readonly sessions: readonly { readonly sessionId: string; readonly status: string }[]
}

interface AdmittedSessionExecutionResponse {
  readonly ok: true
  readonly job: { readonly executionId: string }
}

class RuntimeRequestError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message)
    this.name = 'RuntimeRequestError'
  }
}

async function runtimeRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: 'no-store' })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const code =
      typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string' ? body.code : null
    const message =
      typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string'
        ? body.message
        : 'The runtime request failed.'
    throw new RuntimeRequestError(message, code)
  }
  return body as T
}

function transcriptText(event: TTYSessionTranscriptEvent): string {
  return event.type === 'stdout' && typeof event.data.text === 'string' ? event.data.text : ''
}

function statusClass(state: string): string {
  if (state === 'open') return 'text-emerald-300'
  if (state === 'connecting' || state === 'reconnecting') return 'text-amber-300'
  if (state === 'error') return 'text-rose-300'
  return 'text-zinc-500'
}

export function RuntimeOSWorkspace({
  title,
  sessionId,
  executions,
  selectedExecutionId,
  activeExecutionState,
  onSelectExecution,
  onExecute,
  onCancel,
  onTerminateSession,
  onRecoverSession,
  onNewInvestigation,
  sessionError,
  executionError,
  lastSubmittedInput,
}: RuntimeOSWorkspaceProps) {
  const terminalRef = useRef<InvestigationTerminalHandle>(null)
  const renderedSequenceRef = useRef(0)
  const [command, setCommand] = useState('')
  const [controlError, setControlError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'terminate' | 'execute' | null>(null)
  const [terminalReadySessionId, setTerminalReadySessionId] = useState<string | null>(null)
  const [tabs, setTabs] = useState<readonly RuntimeTab[]>(() =>
    sessionId ? [{ id: sessionId, label: 'primary', primary: true }] : [],
  )
  const [activeTabId, setActiveTabId] = useState<string | null>(sessionId)
  const [lastTabExecutionId, setLastTabExecutionId] = useState<string | null>(null)
  const primaryTabIdRef = useRef<string | null>(sessionId)
  const recoveryInFlightRef = useRef<Promise<void> | null>(null)
  const primarySessionId = sessionId
  const activeSessionId = activeTabId ?? primarySessionId
  const activeTab = tabs.find((tab) => tab.id === activeSessionId) ?? null
  const activeTabIsPrimary = activeTab?.primary === true || activeSessionId === primarySessionId
  // A session failure can belong to the previous persisted session. Once the
  // investigation has rebound to a live session, that old diagnostic must not
  // mask a healthy transcript or tell the operator that the active shell is
  // missing.
  const visibleSessionError = activeSessionId ? null : sessionError
  const terminalReady = terminalReadySessionId === activeSessionId
  const recoverActiveSession = useCallback((): Promise<void> => {
    const inFlight = recoveryInFlightRef.current
    if (inFlight) return inFlight
    if (!activeSessionId) return Promise.resolve()

    const staleSessionId = activeSessionId
    const operation = (async () => {
      if (activeTabIsPrimary) {
        await onRecoverSession?.()
        return
      }

      const body = await runtimeRequest<CreatedSessionResponse>('/api/tty/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const nextId = body.session.sessionId
      setTabs((current) =>
        current.some((tab) => tab.id === staleSessionId)
          ? current.map((tab) => (tab.id === staleSessionId ? { ...tab, id: nextId } : tab))
          : current,
      )
      setActiveTabId((current) => (current === staleSessionId ? nextId : current))
    })()
      .catch((cause) => {
        setControlError(cause instanceof Error ? cause.message : 'The runtime session could not be restored.')
        throw cause
      })
      .finally(() => {
        if (recoveryInFlightRef.current === operation) recoveryInFlightRef.current = null
      })

    recoveryInFlightRef.current = operation
    return operation
  }, [activeSessionId, activeTabIsPrimary, onRecoverSession])
  const writeTranscriptEvent = useCallback(
    (event: TTYSessionTranscriptEvent, timing: { readonly browserReceivedTimestampMs: number }) => {
      if (event.type !== 'stdout') return
      const text = transcriptText(event)
      const terminal = terminalRef.current
      if (!terminal || !text || event.sequence <= renderedSequenceRef.current) return
      // The PTY emulator is the live rendering boundary.  Transcript React
      // state is still updated for replay, counters, and recovery, but it is not
      // on the critical output-to-screen path.
      terminal.write(text)
      renderedSequenceRef.current = event.sequence
      const workerReceivedTimestampMs = event.data.workerReceivedTimestampMs
      const ptyOutputTimestampMs = event.data.ptyOutputTimestampMs
      if (typeof workerReceivedTimestampMs === 'number' && typeof ptyOutputTimestampMs === 'number')
        recordTTYBrowserOutputLatency({
          workerReceivedTimestampMs,
          ptyOutputTimestampMs,
          browserReceivedTimestampMs: timing.browserReceivedTimestampMs,
          renderTimestampMs: Date.now(),
        })
    },
    [],
  )
  const transcript = useTTYSessionTranscript(activeSessionId, recoverActiveSession, {
    onEvent: writeTranscriptEvent,
  })
  const observedExecutionId = activeTabIsPrimary ? selectedExecutionId : lastTabExecutionId
  const executionStream = useTTYExecutionStream({
    executionId: observedExecutionId,
    sessionId: activeSessionId ?? undefined,
    enabled: Boolean(observedExecutionId && activeSessionId),
  })
  const executionMetrics = useMemo(() => {
    const metrics: Record<string, number> = {}
    for (const event of executionStream.events) {
      if (event.type === 'metric') metrics[event.payload.name] = event.payload.value
    }
    return metrics
  }, [executionStream.events])
  const liveExecutionState = useMemo(
    () => latestTTYStreamExecutionState(executionStream.events),
    [executionStream.events],
  )
  const displayedExecutionState = liveExecutionState ?? activeExecutionState
  const displayedExecutions = useMemo(
    () => projectTTYExecutionHistoryState(executions, observedExecutionId, liveExecutionState),
    [executions, liveExecutionState, observedExecutionId],
  )

  useEffect(() => {
    if (!sessionId) return
    const previousPrimaryTabId = primaryTabIdRef.current
    primaryTabIdRef.current = sessionId
    queueMicrotask(() => {
      setTabs((current) => {
        const replacementId = previousPrimaryTabId && previousPrimaryTabId !== sessionId ? previousPrimaryTabId : null
        const withoutTarget = current.filter((tab) => tab.id !== sessionId)
        const normalized = withoutTarget.map((tab) =>
          tab.id === replacementId ? { ...tab, id: sessionId, label: 'primary', primary: true } : tab,
        )
        const seen = new Set<string>()
        const unique = normalized.filter((tab) => {
          if (seen.has(tab.id)) return false
          seen.add(tab.id)
          return true
        })
        return unique.some((tab) => tab.id === sessionId)
          ? unique.map((tab) => (tab.id === sessionId ? { ...tab, label: 'primary', primary: true } : tab))
          : [{ id: sessionId, label: 'primary', primary: true }, ...unique]
      })
      setActiveTabId((current) => (current === previousPrimaryTabId || current === null ? sessionId : current))
    })
  }, [sessionId])

  useEffect(() => {
    let cancelled = false
    void runtimeRequest<ListedSessionsResponse>('/api/tty/sessions')
      .then((body) => {
        if (cancelled) return
        const restored = body.sessions
          .filter((session) => session.status === 'active' || session.status === 'idle')
          .map((session, index) => ({
            id: session.sessionId,
            label: session.sessionId === primarySessionId ? 'primary' : `terminal ${index + 1}`,
            primary: session.sessionId === primarySessionId,
          }))
        if (primarySessionId && !restored.some((tab) => tab.id === primarySessionId)) {
          restored.unshift({ id: primarySessionId, label: 'primary', primary: true })
        }
        queueMicrotask(() => {
          if (cancelled) return
          setTabs(restored)
          setActiveTabId((current) =>
            current && restored.some((tab) => tab.id === current)
              ? current
              : primarySessionId ?? restored[0]?.id ?? null,
          )
        })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [primarySessionId])

  useEffect(() => {
    renderedSequenceRef.current = 0
    terminalRef.current?.clear()
    setControlError(null)
  }, [activeSessionId])

  const renderableEvents = useMemo(
    () => transcript.events.filter((event) => event.type === 'stdout' && transcriptText(event)),
    [transcript.events],
  )

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal || !terminalReady) return
    for (const event of renderableEvents) {
      if (event.sequence <= renderedSequenceRef.current) continue
      terminal.write(transcriptText(event))
      renderedSequenceRef.current = event.sequence
    }
  }, [renderableEvents, terminalReady])

  const write = transcript.write
  const resize = transcript.resize
  const handleInput = useCallback(
    (data: string) => {
      void write(data).catch((cause) =>
        setControlError(cause instanceof Error ? cause.message : 'stdin delivery failed.'),
      )
    },
    [write],
  )

  const handleResize = useCallback(
    ({ cols, rows }: { readonly cols: number; readonly rows: number }) => {
      void resize(cols, rows).catch((cause) =>
        setControlError(cause instanceof Error ? cause.message : 'terminal resize delivery failed.'),
      )
    },
    [resize],
  )

  const handleReady = useCallback(() => setTerminalReadySessionId(activeSessionId), [activeSessionId])

  const createTab = async () => {
    if (busy) return
    setControlError(null)
    try {
      const body = await runtimeRequest<CreatedSessionResponse>('/api/tty/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const nextId = body.session.sessionId
      setTabs((current) => [
        ...current,
        { id: nextId, label: `terminal ${current.filter((tab) => !tab.primary).length + 1}`, primary: false },
      ])
      setActiveTabId(nextId)
    } catch (cause) {
      setControlError(cause instanceof Error ? cause.message : 'A new terminal could not be created.')
    }
  }

  const closeTab = async (tab: RuntimeTab, ignoreBusy = false) => {
    if (busy && !ignoreBusy) return
    setControlError(null)
    try {
      if (tab.primary) await onTerminateSession()
      else await runtimeRequest(`/api/tty/sessions/${encodeURIComponent(tab.id)}`, { method: 'DELETE' })
      setTabs((current) => current.filter((candidate) => candidate.id !== tab.id))
      setActiveTabId((current) => (current === tab.id ? primarySessionId ?? null : current))
    } catch (cause) {
      setControlError(cause instanceof Error ? cause.message : 'The terminal could not be closed.')
    }
  }

  const submitCommand = async () => {
    const input = command.trim()
    if (!input || busy) return
    setBusy('execute')
    setControlError(null)
    try {
      if (activeTabIsPrimary) {
        await onExecute(input)
      } else {
        const body = await runtimeRequest<AdmittedSessionExecutionResponse>(
          `/api/tty/sessions/${encodeURIComponent(activeSessionId as string)}/executions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input, idempotencyKey: crypto.randomUUID() }),
          },
        )
        setLastTabExecutionId(body.job.executionId)
      }
      setCommand('')
    } catch (cause) {
      if (
        cause instanceof RuntimeRequestError &&
        (cause.code === 'SESSION_NOT_FOUND' || cause.code === 'SESSION_NOT_ACTIVE')
      ) {
        await recoverActiveSession().catch(() => undefined)
        return
      }
      setControlError(cause instanceof Error ? cause.message : 'The command could not be admitted.')
    } finally {
      setBusy(null)
    }
  }

  const terminate = async () => {
    if (busy || !activeTab) return
    setBusy('terminate')
    setControlError(null)
    try {
      await closeTab(activeTab, true)
    } catch (cause) {
      setControlError(cause instanceof Error ? cause.message : 'The runtime session could not be terminated.')
    } finally {
      setBusy(null)
    }
  }

  const hasTranscriptOutput = renderableEvents.length > 0
  const connectionLabel = activeSessionId ? transcript.connectionState : 'idle'

  return (
    <main className="flex min-h-full flex-col bg-[#070709] text-zinc-200" aria-label="Hexical Runtime OS">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-cyan-400/15 bg-black/35 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-cyan-300">
            <TerminalSquare className="size-3.5" /> Runtime OS / Execute
          </div>
          <p className="mt-1 truncate font-mono text-[10px] text-zinc-500">{title || 'Untitled investigation'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
          <span className={statusClass(connectionLabel)} aria-live="polite">
            {connectionLabel}
          </span>
          <span className="text-zinc-600">cursor {transcript.cursor ?? '—'}</span>
          <button
            type="button"
            onClick={() => void createTab()}
            disabled={busy !== null}
            className="inline-flex items-center gap-1 rounded border border-cyan-400/25 px-2 py-1 text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-40"
          >
            <Plus className="size-3" /> terminal
          </button>
          <button
            type="button"
            onClick={transcript.reconnect}
            disabled={!activeSessionId}
            className="inline-flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-zinc-400 hover:border-cyan-400/40 hover:text-cyan-200 disabled:opacity-40"
          >
            <RefreshCw className="size-3" /> reconnect
          </button>
          <button
            type="button"
            onClick={() => void terminate()}
            disabled={!activeTab || busy !== null}
            className="inline-flex items-center gap-1 rounded border border-rose-400/25 px-2 py-1 text-rose-300 hover:bg-rose-400/10 disabled:opacity-40"
          >
            <CircleStop className="size-3" /> {busy === 'terminate' ? 'terminating' : 'terminate'}
          </button>
        </div>
      </header>

      <nav
        className="flex min-w-0 items-center gap-1 overflow-x-auto border-b border-white/10 bg-black/20 px-3 py-2"
        aria-label="Runtime terminal tabs"
      >
        {tabs.map((tab) => (
          <div key={tab.id} className="flex shrink-0 items-center rounded border border-white/10 bg-black/20">
            <button
              type="button"
              onClick={() => setActiveTabId(tab.id)}
              aria-current={tab.id === activeSessionId ? 'true' : undefined}
              className={`px-2 py-1 font-mono text-[10px] uppercase tracking-wider ${
                tab.id === activeSessionId ? 'bg-cyan-400/10 text-cyan-200' : 'text-zinc-500 hover:text-zinc-200'
              }`}
            >
              {tab.label}
            </button>
            <button
              type="button"
              onClick={() => void closeTab(tab)}
              disabled={busy !== null}
              aria-label={`Close ${tab.label}`}
              className="border-l border-white/10 px-1.5 py-1 text-zinc-600 hover:text-rose-300 disabled:opacity-40"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        {tabs.length === 0 && <span className="font-mono text-[10px] text-zinc-600">No attached terminals</span>}
      </nav>

      {(visibleSessionError || transcript.error || controlError || executionError) && (
        <div
          role="alert"
          className="border-b border-rose-400/20 bg-rose-400/[0.04] px-4 py-2 font-mono text-[10px] text-rose-300"
        >
          {visibleSessionError || transcript.error || controlError || executionError}
        </div>
      )}

      <div className="grid min-h-[calc(100vh-132px)] flex-1 gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_280px]">
        <section className="flex min-h-[560px] min-w-0 flex-col gap-3">
          <InvestigationTerminal
            ref={terminalRef}
            key={activeSessionId ?? 'runtime-no-session'}
            title="PERSISTENT PTY / SESSION TRANSCRIPT"
            className="min-h-[480px] flex-1"
            autoFocus={Boolean(activeSessionId)}
            onReady={handleReady}
            onInput={handleInput}
            onResize={handleResize}
          />
          <form
            className="rounded-lg border border-cyan-400/15 bg-black/25 p-3"
            onSubmit={(event) => {
              event.preventDefault()
              void submitCommand()
            }}
          >
            <div className="mb-2 flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">
              <span>Admitted command dispatch</span>
              <span className="text-zinc-700">or type directly into the PTY</span>
            </div>
            <div className="flex gap-2">
              <input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                disabled={!activeSessionId || busy !== null}
                aria-label="Runtime command"
                placeholder={activeSessionId ? 'approved argv command' : 'session unavailable'}
                className="min-w-0 flex-1 rounded border border-white/10 bg-black/35 px-2 py-2 font-mono text-xs text-zinc-200 outline-none focus:border-cyan-400/50 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!activeSessionId || !command.trim() || busy !== null}
                className="inline-flex items-center gap-1 rounded border border-cyan-400/30 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-40"
              >
                <Send className="size-3" /> {busy === 'execute' ? 'queueing' : 'execute'}
              </button>
            </div>
          </form>
        </section>

        <aside className="flex min-h-0 flex-col gap-3">
          <section className="rounded-lg border border-white/10 bg-black/20 p-3" aria-label="Runtime session status">
            <div className="mb-3 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-400">
              <Cable className="size-3 text-cyan-300" /> Session contract
            </div>
            <dl className="space-y-2 font-mono text-[10px]">
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-600">session</dt>
                <dd className="truncate text-zinc-300">{activeSessionId ?? '—'}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-600">transport</dt>
                <dd className="text-cyan-200">persistent_pty</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-600">replay events</dt>
                <dd className="text-zinc-300">{transcript.events.length}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-600">execution</dt>
                <dd className="text-zinc-300">
                  {activeTabIsPrimary ? displayedExecutionState ?? 'idle' : lastTabExecutionId ?? 'idle'}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-600">reconnects</dt>
                <dd className="text-zinc-300">{transcript.reconnectCount}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-zinc-600">execution stream</dt>
                <dd className={executionStream.error ? 'text-amber-300' : 'text-zinc-300'}>
                  {executionStream.connectionState}
                </dd>
              </div>
            </dl>
          </section>
          <ExecutionResourceMonitor metrics={executionMetrics} />
          <ExecutionTimeline
            events={executionStream.events}
            currentState={activeTabIsPrimary ? displayedExecutionState : null}
            className="max-h-72 overflow-y-auto"
          />
          <ExecutionHistory
            entries={displayedExecutions}
            selectedExecutionId={selectedExecutionId ?? undefined}
            onSelect={onSelectExecution}
            className="max-h-72 overflow-y-auto"
          />
          <section className="rounded-lg border border-white/10 bg-black/20 p-3" aria-label="Runtime guarantees">
            <div className="mb-2 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-400">
              <History className="size-3 text-cyan-300" /> Durable guarantees
            </div>
            <ul className="space-y-1.5 font-mono text-[10px] leading-relaxed text-zinc-500">
              <li>• stdin and resize are queued to the leased worker</li>
              <li>• transcript replays after the last durable cursor</li>
              <li>• PTY output remains session-scoped and ordered</li>
              <li>• worker reconnect never creates a replacement shell</li>
            </ul>
          </section>
          {!activeSessionId && onNewInvestigation && (
            <button
              type="button"
              onClick={() => void onNewInvestigation()}
              className="rounded border border-cyan-400/30 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-cyan-200 hover:bg-cyan-400/10"
            >
              Create runtime investigation
            </button>
          )}
          {lastSubmittedInput && (
            <p className="font-mono text-[10px] text-zinc-600">last admitted: {lastSubmittedInput}</p>
          )}
          {activeTabIsPrimary &&
            displayedExecutionState &&
            !['succeeded', 'failed', 'cancelled', 'timed_out', 'expired'].includes(displayedExecutionState) && (
              <button
                type="button"
                onClick={() => void onCancel()}
                className="rounded border border-amber-400/25 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-amber-200 hover:bg-amber-400/10"
              >
                stop active execution
              </button>
            )}
          {!hasTranscriptOutput && activeSessionId && (
            <p className="font-mono text-[10px] text-zinc-600">Waiting for durable PTY output…</p>
          )}
        </aside>
      </div>
    </main>
  )
}
