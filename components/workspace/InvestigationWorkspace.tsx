'use client'

import { useMemo, useRef, useState } from 'react'
import { Activity, Boxes, FileSearch, GitBranch, Search, Wifi, WifiOff } from 'lucide-react'

import { EvidenceBookmarks, type TTYEvidenceCandidate } from '@/components/tty/EvidenceBookmarks'
import { ExecutionControls } from '@/components/tty/ExecutionControls'
import { ExecutionHistory, type TTYExecutionHistoryEntry } from '@/components/tty/ExecutionHistory'
import { ExecutionMetadata } from '@/components/tty/ExecutionMetadata'
import { ExecutionTimeline } from '@/components/tty/ExecutionTimeline'
import { InvestigationTerminal, type InvestigationTerminalHandle } from '@/components/tty/InvestigationTerminal'
import { useTTYExecutionStream } from '@/hooks/useTTYExecutionStream'
import type { TTYBrowserExecutionView } from '@/lib/tty/tty-execution-api'
import { buildTTYTerminalLines, findTTYSearchMatches } from '@/lib/tty/tty-terminal-search'
import type { TTYExecutionState } from '@/lib/tty/tty-execution-state'
import type { TTYStreamEvent } from '@/lib/tty/tty-stream-types'

export interface InvestigationWorkspaceProps {
  readonly executionId: string
  readonly sessionId?: string
  readonly command?: string
  readonly execution?: TTYBrowserExecutionView | null
  readonly verificationStatus?: 'verified' | 'pending' | 'unverified'
  readonly plannerPanel?: React.ReactNode
  readonly findingsPanel?: React.ReactNode
  readonly history?: readonly TTYExecutionHistoryEntry[]
  readonly onSelectHistory?: (executionId: string) => void
  readonly onCancel?: () => Promise<void> | void
  readonly onRestart?: () => Promise<void> | void
}

function latestState(events: readonly TTYStreamEvent[]): TTYExecutionState | null {
  return [...events].reverse().find((event): event is Extract<TTYStreamEvent, { type: 'state' }> => event.type === 'state')?.payload.state ?? null
}

function connectionLabel(state: ReturnType<typeof useTTYExecutionStream>['connectionState']): { readonly label: string; readonly className: string } {
  if (state === 'open') return { label: 'live', className: 'text-emerald-300' }
  if (state === 'reconnecting') return { label: 'reconnecting', className: 'text-amber-300' }
  if (state === 'completed') return { label: 'complete', className: 'text-cyan-300' }
  if (state === 'error') return { label: 'error', className: 'text-rose-300' }
  return { label: 'connecting', className: 'text-zinc-500' }
}

export function InvestigationWorkspace({
  executionId,
  sessionId,
  command = 'approved execution',
  execution,
  verificationStatus = 'pending',
  plannerPanel,
  findingsPanel,
  history,
  onSelectHistory,
  onCancel,
  onRestart
}: InvestigationWorkspaceProps) {
  const terminalRef = useRef<InvestigationTerminalHandle | null>(null)
  const [search, setSearch] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const stream = useTTYExecutionStream({ executionId, sessionId, maxEvents: 20_000 })
  const lines = useMemo(() => buildTTYTerminalLines(stream.events), [stream.events])
  const matches = useMemo(() => findTTYSearchMatches(lines, search), [lines, search])
  const state = latestState(stream.events)
  const connection = connectionLabel(stream.connectionState)
  const outputText = useMemo(() => stream.events.filter((event): event is Extract<TTYStreamEvent, { type: 'stdout' | 'stderr' }> => event.type === 'stdout' || event.type === 'stderr').map(event => event.payload.text).join(''), [stream.events])
  const completion = stream.events.find((event): event is Extract<TTYStreamEvent, { type: 'completion' }> => event.type === 'completion')
  const candidates = useMemo<readonly TTYEvidenceCandidate[]>(() => {
    const errors = stream.events.filter((event): event is Extract<TTYStreamEvent, { type: 'error' }> => event.type === 'error').slice(-4).map(event => ({ sequence: event.sequence, lineNumber: null, kind: 'error' as const, label: event.payload.code, excerpt: event.payload.message }))
    const states = stream.events.filter((event): event is Extract<TTYStreamEvent, { type: 'state' }> => event.type === 'state').slice(-4).map(event => ({ sequence: event.sequence, lineNumber: null, kind: 'state' as const, label: `state ${event.payload.state}`, excerpt: new Date(event.timestamp).toLocaleTimeString([], { hour12: false }) }))
    const output = matches.slice(0, 4).map(match => ({ sequence: match.sequence, lineNumber: match.lineNumber, kind: 'output' as const, label: `line ${match.lineNumber}`, excerpt: lines.find(line => line.lineNumber === match.lineNumber)?.text ?? '' }))
    return [...errors, ...states, ...output]
  }, [lines, matches, stream.events])

  const jumpToMatch = (direction: 1 | -1) => {
    if (matches.length === 0) return
    const next = (searchIndex + direction + matches.length) % matches.length
    setSearchIndex(next)
    terminalRef.current?.scrollToLine(matches[next]!.lineNumber)
  }

  const clear = () => {
    stream.clear()
    terminalRef.current?.clear()
  }

  return (
    <main className="hud-grid min-h-screen bg-[#070709] p-3 text-zinc-200 sm:p-4" aria-label="Investigation workspace">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-[1800px] flex-col gap-3">
        <header className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/30 px-3 py-2">
          <div className="flex min-w-0 items-center gap-3">
            <Boxes className="size-4 shrink-0 text-cyan-300" />
            <div className="min-w-0">
              <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-cyan-300">Investigation workspace</div>
              <div className="truncate font-mono text-xs text-zinc-500">{command}</div>
            </div>
          </div>
          <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-wider">
            <span className={connection.className}>{stream.connectionState === 'open' ? <Wifi className="mr-1 inline size-3" /> : <WifiOff className="mr-1 inline size-3" />}{connection.label}</span>
            <span className="text-zinc-600">seq {stream.lastEventId ?? '—'}</span>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(180px,220px)_minmax(0,1fr)_minmax(230px,290px)]">
          <aside className="order-2 flex min-h-0 flex-col gap-3 lg:order-1">
            <section className="min-h-[120px] rounded-lg border border-white/10 bg-black/20 p-3">
              <div className="mb-3 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-400"><GitBranch className="size-3 text-cyan-300" /> Planner</div>
              {plannerPanel ?? <p className="font-mono text-[10px] leading-relaxed text-zinc-600">Attach a planner graph to inspect the execution’s approved investigation path.</p>}
            </section>
            <section className="min-h-[120px] flex-1 rounded-lg border border-white/10 bg-black/20 p-3">
              <div className="mb-3 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-400"><FileSearch className="size-3 text-amber-300" /> Findings</div>
              {findingsPanel ?? <p className="font-mono text-[10px] leading-relaxed text-zinc-600">Verified findings will appear here when the investigation attaches evidence.</p>}
            </section>
            <ExecutionHistory entries={history} selectedExecutionId={executionId} onSelect={onSelectHistory} />
          </aside>

          <section className="order-1 flex min-h-[560px] min-w-0 flex-col gap-2 lg:order-2">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/30 p-2">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Search className="size-3 shrink-0 text-zinc-600" />
                <input value={search} onChange={event => { setSearch(event.target.value); setSearchIndex(0) }} placeholder="Search output" aria-label="Search terminal output" className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-zinc-200 outline-none placeholder:text-zinc-700" />
                <span className="font-mono text-[10px] text-zinc-600">{search ? `${matches.length ? searchIndex + 1 : 0}/${matches.length}` : '—'}</span>
                <button type="button" className="px-1 font-mono text-xs text-zinc-500 hover:text-cyan-300" onClick={() => jumpToMatch(-1)} disabled={!matches.length} aria-label="Previous match">↑</button>
                <button type="button" className="px-1 font-mono text-xs text-zinc-500 hover:text-cyan-300" onClick={() => jumpToMatch(1)} disabled={!matches.length} aria-label="Next match">↓</button>
              </div>
              <ExecutionControls executionId={executionId} state={state} outputText={outputText} onCancel={onCancel} onRestart={onRestart} onClear={clear} />
            </div>
            {stream.error && <div className="rounded border border-amber-400/20 bg-amber-400/5 px-2 py-1 font-mono text-[10px] text-amber-200" role="status">{stream.error}</div>}
            <InvestigationTerminal ref={terminalRef} events={stream.events} title="LIVE EXECUTION" status={<span className="font-mono text-[9px] uppercase tracking-widest text-zinc-600">{executionId.slice(0, 8)}</span>} className="min-h-0 flex-1" />
          </section>

          <aside className="order-3 flex min-h-0 flex-col gap-3">
            <ExecutionTimeline events={stream.events} currentState={state} />
            <ExecutionMetadata execution={execution} completion={completion} verificationStatus={verificationStatus} />
            <EvidenceBookmarks executionId={executionId} candidates={candidates} onJump={bookmark => { if (bookmark.lineNumber) terminalRef.current?.scrollToLine(bookmark.lineNumber) }} />
            <div className="flex items-center gap-2 rounded border border-white/10 bg-black/20 px-3 py-2 font-mono text-[10px] text-zinc-600"><Activity className="size-3" /> replay window bounded to 20k events</div>
          </aside>
        </div>
      </div>
    </main>
  )
}
