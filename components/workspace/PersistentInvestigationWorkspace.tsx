'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, FilePlus2, Play, Pencil, RefreshCw, Save, Square, StickyNote, Trash2 } from 'lucide-react'

import type { TTYEvidenceCandidate } from '@/components/tty/EvidenceBookmarks'
import { EvidenceGraphPanel } from '@/components/workspace/EvidenceGraphPanel'
import { InvestigationTitleEditor } from '@/components/workspace/InvestigationTitleEditor'
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
  const [metadataError, setMetadataError] = useState<string | null>(null)
  const [savingMetadata, setSavingMetadata] = useState(false)
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [editingNoteBody, setEditingNoteBody] = useState('')
  const [noteError, setNoteError] = useState<string | null>(null)
  const [executionInput, setExecutionInput] = useState('')
  const [executionError, setExecutionError] = useState<string | null>(null)
  const [submittingExecution, setSubmittingExecution] = useState(false)
  const [staleExecutionId, setStaleExecutionId] = useState<string | null>(null)
  const draftInvestigationIdRef = useRef<string | null>(null)

  useEffect(() => {
    const next = workspace.data?.investigation
    if (!next || next.investigationId === draftInvestigationIdRef.current) return
    setTitle(next.title)
    setDescription(next.description)
    draftInvestigationIdRef.current = next.investigationId
    setMetadataError(null)
    setEditingNoteId(null)
    setEditingNoteBody('')
  }, [workspace.data?.investigation])

  useEffect(() => {
    if (!workspace.data || workspace.data.investigation.ttySessionId) return
    void workspace.ensureSession().catch(() => {})
  }, [workspace.data?.investigation.investigationId, workspace.data?.investigation.ttySessionId, workspace.ensureSession])

  useEffect(() => {
    setStaleExecutionId(null)
  }, [requestedExecutionId, workspace.data?.investigation.investigationId])

  const activeExecutionId = [requestedExecutionId, selectedExecutionId, workspace.data?.executions.find(execution => execution.executionId !== staleExecutionId)?.executionId ?? null].find(id => id !== null && id !== staleExecutionId) ?? null
  const history = useMemo(() => workspace.data?.executions.map(execution => ({ executionId: execution.executionId, state: execution.state, updatedAt: execution.updatedAt, durationMs: execution.durationMs ?? undefined })) ?? [], [workspace.data?.executions])
  const bookmarks = useMemo(() => workspace.data?.bookmarks.filter(bookmark => bookmark.executionId === activeExecutionId).map(toTTYBookmark) ?? [], [activeExecutionId, workspace.data?.bookmarks])
  const candidates = useMemo<readonly TTYEvidenceCandidate[]>(() => workspace.data?.timeline.filter(event => event.executionId === activeExecutionId && (event.type === 'stdout' || event.type === 'stderr')).slice(-8).map(event => ({ sequence: event.sequence ?? 0, lineNumber: null, kind: event.type === 'stderr' ? 'error' : 'output', label: event.type, excerpt: String(event.payload.text ?? '') })) ?? [], [activeExecutionId, workspace.data?.timeline])

  const activeSessionId = sessionId ?? workspace.data?.executions.find(execution => execution.executionId === activeExecutionId)?.sessionId ?? workspace.data?.investigation.ttySessionId ?? null
  const sessionFailure = workspace.sessionFailure

  const saveMetadata = async () => {
    if (!workspace.data) return
    const nextTitle = title.trim()
    if (!nextTitle) {
      const restoredTitle = workspace.data.investigation.title.trim() || 'Untitled Investigation'
      setTitle(restoredTitle)
      setMetadataError('Title was restored because investigation titles cannot be empty.')
      return
    }
    if (nextTitle.length > 200) {
      setMetadataError('Investigation title must be 200 characters or fewer.')
      return
    }
    if (description.length > 10_000) {
      setMetadataError('Investigation description must be 10,000 characters or fewer.')
      return
    }
    setSavingMetadata(true)
    setMetadataError(null)
    try {
      if (onRename) await onRename(nextTitle, description)
      else await workspace.rename(nextTitle, description)
    } catch (cause) {
      setMetadataError(cause instanceof Error ? cause.message : 'The investigation could not be saved.')
    } finally {
      setSavingMetadata(false)
    }
  }

  const archiveInvestigation = async () => { if (onArchive) await onArchive(); else await workspace.archive() }
  const restoreInvestigation = async () => { if (onRestore) await onRestore(); else await workspace.restore() }
  const deleteInvestigation = async () => { if (onDelete) await onDelete(); else await workspace.remove() }
  const createInvestigation = async () => { if (onNewInvestigation) await onNewInvestigation(); else await workspace.create() }

  const addNote = async () => {
    const body = note.trim()
    if (!body) return
    try {
      setNoteError(null)
      await workspace.addNote(body)
      setNote('')
    } catch (cause) {
      setNoteError(cause instanceof Error ? cause.message : 'The note could not be saved.')
    }
  }

  const saveNote = async () => {
    if (!editingNoteId) return
    const body = editingNoteBody.trim()
    if (!body) {
      setNoteError('Note text cannot be empty.')
      return
    }
    try {
      setNoteError(null)
      await workspace.editNote(editingNoteId, body)
      setEditingNoteId(null)
      setEditingNoteBody('')
    } catch (cause) {
      setNoteError(cause instanceof Error ? cause.message : 'The note could not be updated.')
    }
  }

  const removeNote = async (noteId: string) => {
    try {
      setNoteError(null)
      await workspace.deleteNote(noteId)
      if (editingNoteId === noteId) {
        setEditingNoteId(null)
        setEditingNoteBody('')
      }
    } catch (cause) {
      setNoteError(cause instanceof Error ? cause.message : 'The note could not be deleted.')
    }
  }

  const execute = async (rawInput: string) => {
    const input = rawInput.trim()
    if (!input) return
    setSubmittingExecution(true)
    setExecutionError(null)
    try {
      const attachedSessionId = activeSessionId ?? await workspace.ensureSession()
      if (!attachedSessionId) throw new Error('No execution session is attached to this investigation.')
      const executionId = await workspace.attachExecution({ sessionId: attachedSessionId, input, idempotencyKey: crypto.randomUUID() })
      if (!executionId) throw new Error('The execution could not be attached.')
      setSelectedExecutionId(executionId)
      setExecutionInput('')
    } catch (cause) {
      setExecutionError(cause instanceof Error ? cause.message : 'The execution could not be submitted.')
      throw cause
    } finally {
      setSubmittingExecution(false)
    }
  }

  const selectExecution = (nextExecutionId: string) => {
    setStaleExecutionId(null)
    setSelectedExecutionId(nextExecutionId)
  }

  const clearStaleExecution = () => {
    if (activeExecutionId) setStaleExecutionId(activeExecutionId)
    setSelectedExecutionId(null)
    setExecutionError('No active execution')
  }

  const terminateSession = async () => {
    try {
      setExecutionError(null)
      await workspace.terminateSession()
    } catch (cause) {
      setExecutionError(cause instanceof Error ? cause.message : 'The execution session could not be terminated.')
    }
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
          <InvestigationTitleEditor title={title} disabled={savingMetadata} onTitleChange={setTitle} onSave={() => void saveMetadata()} />
          <input value={description} onChange={event => setDescription(event.target.value)} aria-label="Investigation description" placeholder="Describe the investigation" className="mt-1 w-full bg-transparent font-mono text-[10px] text-zinc-500 outline-none" />
        </div>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
          <span className={workspace.loading ? 'text-amber-300' : 'text-emerald-300'} aria-live="polite">{workspace.loading ? 'hydrating' : 'hydrated'}</span>
          <span className={investigation.status === 'archived' ? 'text-amber-300' : 'text-emerald-300'}>{investigation.status}</span>
          <button type="button" onClick={() => void saveMetadata()} disabled={savingMetadata} className="rounded border border-white/10 px-2 py-1 text-zinc-400 hover:border-cyan-400/40 hover:text-cyan-200 disabled:opacity-50" title="Save investigation metadata"><Save className="mr-1 inline size-3" />{savingMetadata ? 'Saving' : 'Save'}</button>
          {investigation.status === 'active' ? <button type="button" onClick={() => void archiveInvestigation()} className="rounded border border-white/10 px-2 py-1 text-zinc-400 hover:border-amber-400/40 hover:text-amber-200"><Archive className="mr-1 inline size-3" />Archive</button> : <button type="button" onClick={() => void restoreInvestigation()} className="rounded border border-white/10 px-2 py-1 text-zinc-400 hover:border-emerald-400/40 hover:text-emerald-200"><RefreshCw className="mr-1 inline size-3" />Restore</button>}
          <button type="button" onClick={() => void createInvestigation()} className="rounded border border-cyan-400/30 px-2 py-1 text-cyan-200 hover:bg-cyan-400/10"><FilePlus2 className="mr-1 inline size-3" />New</button>
          <button type="button" onClick={() => void deleteInvestigation()} className="rounded border border-rose-400/20 px-2 py-1 text-rose-300 hover:bg-rose-400/10" title="Delete investigation"><Trash2 className="size-3" /></button>
        </div>
      </header>
      {metadataError && <p role="alert" className="border-b border-rose-400/20 bg-rose-400/[0.04] px-4 py-2 font-mono text-[10px] text-rose-300">{metadataError}</p>}

      <div className="border-b border-white/10 bg-black/20 px-4 py-2 font-mono text-[10px] text-zinc-500">
        <span className="mr-4">executions {investigation.executionCount}</span><span className="mr-4">evidence {investigation.evidenceCount}</span><span className="mr-4">findings {investigation.findingCount}</span><span className={activeSessionId ? 'text-emerald-300' : sessionFailure ? 'text-rose-300' : 'text-amber-300'}>{activeSessionId ? 'session attached' : sessionFailure ? 'session unavailable' : 'attaching session'}</span>
      </div>
      {!activeSessionId && sessionFailure && <div role="alert" className="border-b border-rose-400/20 bg-rose-400/[0.04] px-4 py-2 font-mono text-[10px] text-rose-300"><span>{sessionFailure.message}</span>{sessionFailure.code === 'CAPABILITY_LOCKED' && <span className="ml-2 text-amber-200">Upgrade to Pro to enable the execution workspace.</span>}<button type="button" onClick={() => void workspace.ensureSession()} className="ml-3 text-cyan-200 underline underline-offset-2">Retry session</button></div>}

      <EvidenceGraphPanel investigationId={investigation.investigationId} />

      {showExecution ? <InvestigationWorkspace executionId={activeExecutionId} sessionId={activeSessionId ?? undefined} command={investigation.title} history={history} onSelectHistory={selectExecution} onExecute={execute} onCancel={terminateSession} onRestart={() => execute(investigation.title)} onExecutionNotFound={clearStaleExecution} initialBookmarks={bookmarks} onBookmarkAdded={bookmark => workspace.addBookmark({ executionId: bookmark.executionId, sequence: bookmark.sequence, lineNumber: bookmark.lineNumber, kind: bookmark.kind, label: bookmark.label, excerpt: bookmark.excerpt })} /> : <section className="mx-auto grid max-w-5xl gap-4 p-6 lg:grid-cols-[minmax(0,1fr)_minmax(260px,360px)]">
        <div className="rounded-lg border border-white/10 bg-black/20 p-4">
          <div className="mb-4 rounded border border-cyan-400/20 bg-cyan-400/[0.03] p-3"><div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-300"><span>Execute in investigation</span>{activeSessionId && <button type="button" onClick={() => void terminateSession()} className="text-zinc-500 hover:text-rose-300"><Square className="mr-1 inline size-3" />Terminate session</button>}</div><textarea value={executionInput} onChange={event => setExecutionInput(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void execute(executionInput) } }} disabled={!activeSessionId || submittingExecution} aria-label="Investigation execution command" placeholder={activeSessionId ? 'Enter an approved command. Ctrl+Enter runs it.' : sessionFailure?.message ?? 'Attaching investigation session…'} className="min-h-20 w-full rounded border border-white/10 bg-black/30 p-2 font-mono text-xs text-zinc-200 outline-none disabled:cursor-not-allowed disabled:opacity-60" /><button type="button" onClick={() => void execute(executionInput)} disabled={!activeSessionId || submittingExecution || !executionInput.trim()} className="mt-2 rounded border border-cyan-400/30 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-50"><Play className="mr-1 inline size-3" />{submittingExecution ? 'Queueing' : 'Execute'}</button>{executionError && <p role="alert" className="mt-2 font-mono text-[10px] text-rose-300">{executionError}</p>}</div>
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
            {noteError && <p role="alert" className="mt-2 font-mono text-[10px] text-rose-300">{noteError}</p>}
            <div className="mt-3 space-y-2">{workspace.data.notes.slice(-8).map(item => editingNoteId === item.noteId ? <div key={item.noteId} className="space-y-2 border-l border-amber-400/30 pl-2"><textarea autoFocus value={editingNoteBody} onChange={event => setEditingNoteBody(event.target.value)} className="min-h-16 w-full rounded border border-amber-400/20 bg-black/20 p-2 font-mono text-[10px] text-zinc-300 outline-none" /><div className="flex gap-2"><button type="button" onClick={() => void saveNote()} className="font-mono text-[10px] text-emerald-300">Save</button><button type="button" onClick={() => { setEditingNoteId(null); setEditingNoteBody('') }} className="font-mono text-[10px] text-zinc-500">Cancel</button></div></div> : <div key={item.noteId} className="flex items-start gap-2 border-l border-amber-400/30 pl-2"><p className="min-w-0 flex-1 font-mono text-[10px] text-zinc-500">{item.body}</p><button type="button" onClick={() => { setEditingNoteId(item.noteId); setEditingNoteBody(item.body); setNoteError(null) }} className="text-zinc-600 hover:text-amber-200" aria-label="Edit note"><Pencil className="size-3" /></button><button type="button" onClick={() => void removeNote(item.noteId)} className="text-zinc-600 hover:text-rose-300" aria-label="Delete note"><Trash2 className="size-3" /></button></div>)}</div>
          </div>
          <div className="rounded-lg border border-white/10 bg-black/20 p-4 font-mono text-[10px] text-zinc-500">Executions remain attached to this investigation across refresh, reconnect, and worker restart.</div>
        </aside>
      </section>}
    </div>
  )
}
