'use client'

import { useMemo, useState } from 'react'
import { Archive, FilePlus2, RefreshCw, Save, StickyNote, Trash2 } from 'lucide-react'

import type { TTYEvidenceCandidate } from '@/components/tty/EvidenceBookmarks'
import { EvidenceGraphPanel } from '@/components/workspace/EvidenceGraphPanel'
import { InvestigationWorkspace } from '@/components/workspace/InvestigationWorkspace'
import { useInvestigationWorkspace } from '@/hooks/useInvestigationWorkspace'
import type { InvestigationBookmark } from '@/lib/investigations/investigation-types'

export interface PersistentInvestigationWorkspaceProps {
  readonly investigationId?: string | null
  readonly autoCreate?: boolean
  readonly sessionId?: string
  readonly executionId?: string | null
  readonly onNewInvestigation?: () => Promise<void> | void
  readonly onRename?: (title: string, description: string) => Promise<void> | void
  readonly onArchive?: () => Promise<void> | void
  readonly onRestore?: () => Promise<void> | void
  readonly onDelete?: () => Promise<void> | void
}

function toTTYBookmark(bookmark: InvestigationBookmark) {
  return {
    id: bookmark.bookmarkId,
    executionId: bookmark.executionId as never,
    sequence: bookmark.sequence,
    lineNumber: bookmark.lineNumber,
    kind: bookmark.kind,
    label: bookmark.label,
    excerpt: bookmark.excerpt,
    createdAt: bookmark.createdAt
  }
}

export function PersistentInvestigationWorkspace({ investigationId, autoCreate = true, sessionId, executionId: requestedExecutionId, onNewInvestigation, onRename, onArchive, onRestore, onDelete }: PersistentInvestigationWorkspaceProps) {
  const workspace = useInvestigationWorkspace({ investigationId, autoCreate })
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(requestedExecutionId ?? null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [note, setNote] = useState('')

  const activeExecutionId = requestedExecutionId ?? selectedExecutionId ?? workspace.data?.executions[0]?.executionId ?? null
  const history = useMemo(() => workspace.data?.executions.map(execution => ({ executionId: execution.executionId, state: execution.state, updatedAt: execution.updatedAt, durationMs: execution.durationMs ?? undefined })) ?? [], [workspace.data?.executions])
  const bookmarks = useMemo(() => workspace.data?.bookmarks.filter(bookmark => bookmark.executionId === activeExecutionId).map(toTTYBookmark) ?? [], [activeExecutionId, workspace.data?.bookmarks])
  const candidates = useMemo<readonly TTYEvidenceCandidate[]>(() => workspace.data?.timeline.filter(event => event.executionId === activeExecutionId && (event.type === 'stdout' || event.type === 'stderr')).slice(-8).map(event => ({ sequence: event.sequence ?? 0, lineNumber: null, kind: event.type === 'stderr' ? 'error' : 'output', label: event.type, excerpt: String(event.payload.text ?? '') })) ?? [], [activeExecutionId, workspace.data?.timeline])

  const saveMetadata = async () => {
    if (!workspace.data) return
    const nextTitle = title.trim() || workspace.data.investigation.title
    if (onRename) await onRename(nextTitle, description)
    else await workspace.rename(nextTitle, description)
  }

  const archiveInvestigation = async () => { if (onArchive) await onArchive(); else await workspace.archive() }
  const restoreInvestigation = async () => { if (onRestore) await onRestore(); else await workspace.restore() }
  const deleteInvestigation = async () => { if (onDelete) await onDelete(); else await workspace.remove() }
  const createInvestigation = async () => { if (onNewInvestigation) await onNewInvestigation(); else await workspace.create() }

  const addNote = async () => {
    const body = note.trim()
    if (!body) return
    await workspace.addNote(body)
    setNote('')
  }

  if (!workspace.data) {
    return <main className="min-h-screen bg-[#070709] p-6 text-zinc-200" aria-label="Investigation workspace loading"><div className="mx-auto max-w-3xl rounded-lg border border-white/10 bg-black/30 p-6 font-mono text-xs text-zinc-500">{workspace.loading ? 'Hydrating investigation…' : workspace.error ?? 'Preparing investigation workspace…'}</div></main>
  }

  const investigation = workspace.data.investigation
  const showExecution = activeExecutionId !== null
  return (
    <div className="min-h-screen bg-[#070709] text-zinc-200">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-black/30 px-4 py-3">
        <div className="min-w-0 flex-1">
          <input value={title || investigation.title} onChange={event => setTitle(event.target.value)} aria-label="Investigation title" className="w-full bg-transparent font-mono text-sm font-semibold text-cyan-200 outline-none" />
          <input value={description || investigation.description} onChange={event => setDescription(event.target.value)} aria-label="Investigation description" placeholder="Describe the investigation" className="mt-1 w-full bg-transparent font-mono text-[10px] text-zinc-500 outline-none" />
        </div>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
          <span className={workspace.loading ? 'text-amber-300' : 'text-emerald-300'} aria-live="polite">{workspace.loading ? 'hydrating' : 'hydrated'}</span>
          <span className={investigation.status === 'archived' ? 'text-amber-300' : 'text-emerald-300'}>{investigation.status}</span>
          <button type="button" onClick={() => void saveMetadata()} className="rounded border border-white/10 px-2 py-1 text-zinc-400 hover:border-cyan-400/40 hover:text-cyan-200" title="Save investigation metadata"><Save className="mr-1 inline size-3" />Save</button>
          {investigation.status === 'active' ? <button type="button" onClick={() => void archiveInvestigation()} className="rounded border border-white/10 px-2 py-1 text-zinc-400 hover:border-amber-400/40 hover:text-amber-200"><Archive className="mr-1 inline size-3" />Archive</button> : <button type="button" onClick={() => void restoreInvestigation()} className="rounded border border-white/10 px-2 py-1 text-zinc-400 hover:border-emerald-400/40 hover:text-emerald-200"><RefreshCw className="mr-1 inline size-3" />Restore</button>}
          <button type="button" onClick={() => void createInvestigation()} className="rounded border border-cyan-400/30 px-2 py-1 text-cyan-200 hover:bg-cyan-400/10"><FilePlus2 className="mr-1 inline size-3" />New</button>
          <button type="button" onClick={() => void deleteInvestigation()} className="rounded border border-rose-400/20 px-2 py-1 text-rose-300 hover:bg-rose-400/10" title="Delete investigation"><Trash2 className="size-3" /></button>
        </div>
      </header>

      <div className="border-b border-white/10 bg-black/20 px-4 py-2 font-mono text-[10px] text-zinc-500">
        <span className="mr-4">executions {investigation.executionCount}</span><span className="mr-4">evidence {investigation.evidenceCount}</span><span>findings {investigation.findingCount}</span>
      </div>

      <EvidenceGraphPanel investigationId={investigation.investigationId} />

      {showExecution ? <InvestigationWorkspace executionId={activeExecutionId} sessionId={sessionId} command={investigation.title} history={history} onSelectHistory={setSelectedExecutionId} initialBookmarks={bookmarks} onBookmarkAdded={bookmark => workspace.addBookmark({ executionId: bookmark.executionId, sequence: bookmark.sequence, lineNumber: bookmark.lineNumber, kind: bookmark.kind, label: bookmark.label, excerpt: bookmark.excerpt })} /> : <section className="mx-auto grid max-w-5xl gap-4 p-6 lg:grid-cols-[minmax(0,1fr)_minmax(260px,360px)]">
        <div className="rounded-lg border border-white/10 bg-black/20 p-4">
          <div className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-400">Investigation timeline</div>
          <div className="space-y-2">
            {workspace.data.timeline.map(event => <div key={event.eventId} className="rounded border border-white/10 px-3 py-2 font-mono text-[10px] text-zinc-500"><span className="mr-2 text-cyan-300">{event.type}</span><time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString()}</time>{event.executionId && <span className="ml-2 text-zinc-700">{event.executionId.slice(0, 8)}</span>}</div>)}
            {workspace.data.timeline.length === 0 && <p className="text-xs text-zinc-600">No timeline events persisted.</p>}
          </div>
          {workspace.data.nextTimelineCursor && <button type="button" onClick={() => void workspace.loadMoreTimeline()} className="mt-3 font-mono text-[10px] text-cyan-300">Load older timeline</button>}
        </div>
        <aside className="space-y-4">
          <div className="rounded-lg border border-white/10 bg-black/20 p-4">
            <div className="mb-3 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-400"><StickyNote className="size-3 text-amber-300" /> Notes</div>
            <textarea value={note} onChange={event => setNote(event.target.value)} placeholder="Add an investigation note" className="min-h-20 w-full rounded border border-white/10 bg-black/20 p-2 font-mono text-xs text-zinc-300 outline-none" />
            <button type="button" onClick={() => void addNote()} className="mt-2 rounded border border-amber-400/20 px-2 py-1 font-mono text-[10px] text-amber-200">Add note</button>
            <div className="mt-3 space-y-2">{workspace.data.notes.slice(-8).map(item => <p key={item.noteId} className="border-l border-amber-400/30 pl-2 font-mono text-[10px] text-zinc-500">{item.body}</p>)}</div>
          </div>
          <div className="rounded-lg border border-white/10 bg-black/20 p-4 font-mono text-[10px] text-zinc-500">Executions remain attached to this investigation across refresh, reconnect, and worker restart.</div>
        </aside>
      </section>}
    </div>
  )
}
