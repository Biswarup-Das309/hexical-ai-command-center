'use client'

import { useEffect, useState } from 'react'
import { Bookmark, Plus, Trash2 } from 'lucide-react'

import {
  createTTYEvidenceBookmark,
  parseTTYEvidenceBookmarks,
  serializeTTYEvidenceBookmarks,
  ttyEvidenceStorageKey,
  type TTYEvidenceBookmark,
  type TTYEvidenceKind
} from '@/lib/tty/tty-evidence-bookmarks'

export interface TTYEvidenceCandidate {
  readonly sequence: number
  readonly lineNumber: number | null
  readonly kind: TTYEvidenceKind
  readonly label: string
  readonly excerpt: string
}

export interface EvidenceBookmarksProps {
  readonly executionId: string
  readonly candidates?: readonly TTYEvidenceCandidate[]
  readonly initialBookmarks?: readonly TTYEvidenceBookmark[]
  readonly onBookmarkAdded?: (bookmark: TTYEvidenceBookmark) => Promise<void> | void
  readonly onJump?: (candidate: TTYEvidenceBookmark) => void
  readonly className?: string
}

export function EvidenceBookmarks({ executionId, candidates = [], initialBookmarks, onBookmarkAdded, onJump, className = '' }: EvidenceBookmarksProps) {
  const [bookmarks, setBookmarks] = useState<readonly TTYEvidenceBookmark[]>([])

  useEffect(() => {
    if (initialBookmarks !== undefined) {
      setBookmarks(initialBookmarks)
      return
    }
    try {
      setBookmarks(parseTTYEvidenceBookmarks(localStorage.getItem(ttyEvidenceStorageKey(executionId)), executionId as never))
    } catch {
      setBookmarks([])
    }
  }, [executionId, initialBookmarks])

  const persist = (next: readonly TTYEvidenceBookmark[]) => {
    setBookmarks(next)
    try {
      localStorage.setItem(ttyEvidenceStorageKey(executionId), serializeTTYEvidenceBookmarks(next))
    } catch {
      // Private browsing and storage quotas must not break the investigation surface.
    }
  }

  const add = (candidate: TTYEvidenceCandidate) => {
    const existing = bookmarks.find(bookmark => bookmark.sequence === candidate.sequence && bookmark.kind === candidate.kind)
    if (existing) return
    const bookmark = createTTYEvidenceBookmark({ executionId: executionId as never, ...candidate })
    persist([...bookmarks, bookmark])
    void onBookmarkAdded?.(bookmark)
  }

  const remove = (id: string) => persist(bookmarks.filter(bookmark => bookmark.id !== id))

  return (
    <section className={`min-h-0 rounded-lg border border-white/10 bg-black/20 p-3 ${className}`} aria-label="Evidence bookmarks">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-400">Evidence</span>
        <Bookmark className="size-3 text-amber-300" />
      </div>
      <div className="space-y-1.5">
        {bookmarks.map(bookmark => (
          <div key={bookmark.id} className="group flex items-start gap-2 rounded border border-amber-400/15 bg-amber-400/5 p-2">
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onJump?.(bookmark)}>
              <span className="block truncate font-mono text-[10px] text-amber-200">{bookmark.label}</span>
              <span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-500">{bookmark.excerpt}</span>
            </button>
            <button type="button" className="shrink-0 p-1 text-zinc-600 hover:text-rose-300" onClick={() => remove(bookmark.id)} aria-label={`Remove ${bookmark.label}`}><Trash2 className="size-3" /></button>
          </div>
        ))}
        {candidates.map(candidate => (
          <button key={`${candidate.kind}-${candidate.sequence}`} type="button" className="flex w-full items-center gap-2 rounded border border-dashed border-white/10 px-2 py-1.5 text-left font-mono text-[10px] text-zinc-500 transition hover:border-cyan-400/30 hover:text-cyan-300" onClick={() => add(candidate)}>
            <Plus className="size-3 shrink-0" /> <span className="truncate">{candidate.label}: {candidate.excerpt}</span>
          </button>
        ))}
        {bookmarks.length === 0 && candidates.length === 0 && <p className="font-mono text-[10px] text-zinc-600">No evidence bookmarked.</p>}
      </div>
    </section>
  )
}
