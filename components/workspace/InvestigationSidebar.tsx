'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Archive,
  ArchiveRestore,
  Edit2,
  Loader2,
  LogOut,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  UserRound
} from 'lucide-react'
import { UserButton } from '@clerk/nextjs'

import type { PlanTier } from '@/lib/hexical-types'
import type { PublicInvestigation } from '@/hooks/useInvestigations'
import { HexicalLogo } from '@/components/hexical/hexical-logo'

interface InvestigationSidebarProps {
  readonly investigations: readonly PublicInvestigation[]
  readonly activeId: string | null
  readonly isOpen: boolean
  readonly loading: boolean
  readonly error: string | null
  readonly nextCursor: string | null
  readonly userName: string
  readonly userEmail: string
  readonly avatarUrl?: string | null
  readonly currentTier?: PlanTier | null
  readonly onToggleOpen: () => void
  readonly onSelect: (id: string) => void
  readonly onNewInvestigation: () => void
  readonly onRename: (id: string, title: string) => Promise<void> | void
  readonly onArchive: (id: string) => Promise<void> | void
  readonly onRestore: (id: string) => Promise<void> | void
  readonly onDelete: (id: string) => Promise<void> | void
  readonly onLoadMore: () => Promise<void> | void
  readonly onSignOut?: () => void
  readonly onOpenUpgrade: () => void
}

const MAX_TITLE_LENGTH = 120

function formatUpdatedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'unknown'
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function InvestigationSidebar({
  investigations,
  activeId,
  isOpen,
  loading,
  error,
  nextCursor,
  userName,
  userEmail,
  avatarUrl,
  currentTier,
  onToggleOpen,
  onSelect,
  onNewInvestigation,
  onRename,
  onArchive,
  onRestore,
  onDelete,
  onLoadMore,
  onSignOut,
  onOpenUpgrade
}: InvestigationSidebarProps) {
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  useEffect(() => {
    if (!menuOpenId) return
    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (!(event.target instanceof Element)) return
      if (event.target.closest('[data-investigation-menu], [data-investigation-menu-trigger]')) return
      setMenuOpenId(null)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('touchstart', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
    }
  }, [menuOpenId])

  const startRename = useCallback((investigation: PublicInvestigation) => {
    setEditingId(investigation.investigationId)
    setEditValue(investigation.title.slice(0, MAX_TITLE_LENGTH))
    setMenuOpenId(null)
  }, [])

  const submitRename = useCallback((id: string, value: string) => {
    const title = value.trim().slice(0, MAX_TITLE_LENGTH)
    if (title) void onRename(id, title)
    setEditingId(null)
    setEditValue('')
  }, [onRename])

  const activeCount = useMemo(() => investigations.filter(item => item.status === 'active').length, [investigations])

  return (
    <div className="relative flex h-full w-full flex-col border-r border-white/5 bg-[#0a0a0c] text-foreground shadow-[4px_0_24px_rgba(0,0,0,0.5)]">
      <div className="flex h-16 items-center gap-3 p-4">
        <button type="button" onClick={onToggleOpen} aria-label={isOpen ? 'Collapse sidebar' : 'Expand sidebar'} className="flex-shrink-0 rounded-xl p-2 text-muted-foreground transition-colors hover:bg-white/10 hover:text-[var(--accent-text)]">
          {isOpen ? <PanelLeftClose size={20} /> : <PanelLeftOpen size={20} />}
        </button>
        {isOpen && <div className="flex items-center gap-2 overflow-hidden whitespace-nowrap animate-fade-in"><HexicalLogo className="size-7 text-[var(--accent-text)] drop-shadow-[0_0_8px_var(--accent-border)]" /><span className="font-sans text-xl font-bold tracking-wide text-white">Hexical</span></div>}
      </div>

      <div className="mb-5 mt-2 px-3">
        <button type="button" onClick={onNewInvestigation} disabled={loading} className={`flex items-center gap-3 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.06] text-cyan-200 transition-all hover:bg-cyan-400/[0.12] disabled:cursor-wait disabled:opacity-60 ${isOpen ? 'w-full px-4 py-3' : 'mx-auto w-12 justify-center p-3'}`}>
          {loading ? <Loader2 size={20} className="animate-spin" /> : <Plus size={20} className="flex-shrink-0" />}
          {isOpen && <span className="whitespace-nowrap text-sm font-medium">New Investigation</span>}
        </button>
      </div>

      {isOpen && <div className="flex-1 space-y-4 overflow-y-auto px-3 scrollbar-thin scrollbar-thumb-white/10">
        <div className="flex items-center justify-between px-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">Investigations</p>
          <span className="font-mono text-[9px] text-zinc-600">{activeCount} active</span>
        </div>

        <div className="space-y-[2px]">
          {investigations.map(investigation => {
            const selected = investigation.investigationId === activeId
            const editing = investigation.investigationId === editingId
            return <div key={investigation.investigationId} className={`group relative rounded-lg border ${selected ? 'border-cyan-400/20 bg-cyan-400/[0.06]' : 'border-transparent hover:border-white/10 hover:bg-white/[0.03]'}`}>
              {editing ? <input autoFocus value={editValue} onChange={event => setEditValue(event.target.value.slice(0, MAX_TITLE_LENGTH))} onBlur={() => submitRename(investigation.investigationId, editValue)} onKeyDown={event => { if (event.key === 'Enter') submitRename(investigation.investigationId, editValue); if (event.key === 'Escape') { setEditingId(null); setEditValue('') } }} aria-label="Rename investigation" className="m-2 w-[calc(100%-1rem)] rounded border border-cyan-400/30 bg-black/40 px-2 py-1.5 font-mono text-xs text-cyan-100 outline-none" /> : <>
                <button type="button" onClick={() => onSelect(investigation.investigationId)} className="w-full px-3 py-2.5 pr-10 text-left">
                  <span className={`block truncate font-mono text-xs ${selected ? 'text-cyan-100' : 'text-zinc-300'}`}>{investigation.title}</span>
                  <span className="mt-1 flex items-center gap-2 font-mono text-[9px] uppercase tracking-wider text-zinc-600"><span>{investigation.status}</span><span>·</span><span>{formatUpdatedAt(investigation.updatedAt)}</span></span>
                </button>
                <button type="button" data-investigation-menu-trigger onClick={() => setMenuOpenId(current => current === investigation.investigationId ? null : investigation.investigationId)} aria-label={`Actions for ${investigation.title}`} className="absolute right-2 top-2 rounded p-1 text-zinc-600 opacity-0 transition-opacity hover:bg-white/10 hover:text-zinc-200 group-hover:opacity-100"><MoreVertical size={14} /></button>
                {menuOpenId === investigation.investigationId && <div data-investigation-menu className="absolute right-2 top-9 z-50 w-36 rounded-lg border border-white/10 bg-[#111116] p-1 shadow-2xl">
                  <button type="button" onClick={() => startRename(investigation)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-[10px] text-zinc-400 hover:bg-white/5 hover:text-white"><Edit2 size={12} />Rename</button>
                  {investigation.status === 'archived' ? <button type="button" onClick={() => { setMenuOpenId(null); void onRestore(investigation.investigationId) }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-[10px] text-emerald-300 hover:bg-emerald-400/10"><ArchiveRestore size={12} />Restore</button> : <button type="button" onClick={() => { setMenuOpenId(null); void onArchive(investigation.investigationId) }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-[10px] text-amber-300 hover:bg-amber-400/10"><Archive size={12} />Archive</button>}
                  <button type="button" onClick={() => { setMenuOpenId(null); void onDelete(investigation.investigationId) }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-[10px] text-rose-300 hover:bg-rose-400/10"><Trash2 size={12} />Delete</button>
                </div>}
              </>}
            </div>
          })}
          {investigations.length === 0 && <div className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center font-mono text-[10px] leading-relaxed text-zinc-600">No investigations yet.<br />Create one to establish a persistent evidence workspace.</div>}
        </div>

        {nextCursor && <button type="button" onClick={() => void onLoadMore()} disabled={loading} className="flex w-full items-center justify-center gap-2 rounded border border-white/10 px-3 py-2 font-mono text-[10px] text-zinc-500 hover:border-cyan-400/30 hover:text-cyan-200 disabled:opacity-50"><RefreshCw size={12} className={loading ? 'animate-spin' : ''} />Load more</button>}
        {errorMessage(loading, error)}
      </div>}

      <div className="mt-auto flex flex-col gap-2 border-t border-white/5 bg-[#0a0a0c] p-3">
        {isOpen && <div className="flex items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-2 py-2"><UserButton appearance={{ elements: { avatarBox: 'size-7' } }} /><div className="min-w-0 flex-1"><div className="truncate font-sans text-xs text-zinc-300">{userName}</div><div className="truncate font-mono text-[9px] text-zinc-600">{userEmail}</div></div></div>}
        <div className="flex items-center gap-1">
          <button type="button" onClick={onOpenUpgrade} className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2 py-2 font-mono text-[9px] uppercase tracking-wider text-cyan-300 hover:bg-cyan-500/20"><UserRound size={13} />{isOpen ? 'Plan' : ''}</button>
          {isOpen && <Link href="/dashboard/settings" className="rounded-lg border border-white/5 p-2 text-zinc-500 hover:bg-white/5 hover:text-zinc-200" aria-label="Settings"><Settings size={14} /></Link>}
          {isOpen && onSignOut && <button type="button" onClick={onSignOut} className="rounded-lg border border-white/5 p-2 text-zinc-500 hover:bg-white/5 hover:text-rose-300" aria-label="Sign out"><LogOut size={14} /></button>}
        </div>
      </div>
    </div>
  )
}

function errorMessage(loading: boolean, error: string | null): React.ReactNode {
  if (loading) return <p className="px-4 font-mono text-[9px] text-zinc-600">Syncing owner-scoped investigations…</p>
  return error ? <p className="px-4 font-mono text-[9px] text-rose-300">{error}</p> : null
}
