'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Download,
  Edit2,
  LogOut,
  MessageSquare,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Plus,
  Settings,
  ShieldCheck,
  Trash2,
  Zap,
} from 'lucide-react'
import { SignInButton, UserButton, useAuth } from '@clerk/nextjs'

import type { PlanTier } from '@/lib/hexical-types'
import { HexicalLogo } from './hexical-logo'

export interface ChatThread {
  id: string
  title: string
  pinned: boolean
}

interface ChatSidebarProps {
  chats: ChatThread[]
  activeId: string
  isOpen: boolean
  userName: string
  userEmail: string
  avatarUrl?: string | null
  currentTier?: PlanTier | null
  onToggleOpen: () => void
  onSelect: (id: string) => void
  onNewChat: () => void
  onDeleteChat: (id: string) => void
  onRenameChat: (id: string, newTitle: string) => void
  onTogglePin: (id: string) => void
  onSignOut?: () => void
  onOpenUpgrade: () => void
}

const TIER_LABELS: Record<PlanTier, string> = {
  free: 'FREE',
  go: 'GO',
  plus: 'PLUS',
  pro: 'PRO',
}

const CHAT_TITLE_MAX_LENGTH = 120

function normalizeTier(currentTier: ChatSidebarProps['currentTier']): PlanTier {
  if (currentTier === 'free' || currentTier === 'go' || currentTier === 'plus' || currentTier === 'pro') {
    return currentTier
  }
  return 'free'
}

export function ChatSidebar({
  chats,
  activeId,
  isOpen,
  userName,
  userEmail,
  avatarUrl,
  currentTier,
  onToggleOpen,
  onSelect,
  onNewChat,
  onDeleteChat,
  onRenameChat,
  onTogglePin,
  onSignOut,
  onOpenUpgrade,
}: ChatSidebarProps) {
  const { isLoaded, userId } = useAuth()

  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  const safeTier = normalizeTier(currentTier)

  useEffect(() => {
    if (!menuOpenId) return

    const handleClickOutside = (event: MouseEvent | TouchEvent) => {
      if (!(event.target instanceof Element)) return
      if (event.target.closest('[data-chat-menu], [data-chat-menu-trigger]')) return
      setMenuOpenId(null)
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('touchstart', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
    }
  }, [menuOpenId])

  const pinnedChats = useMemo(() => chats.filter((chat) => chat.pinned), [chats])
  const recentChats = useMemo(() => chats.filter((chat) => !chat.pinned), [chats])

  // Stable identities so React.memo on ChatItem actually skips re-rendering
  // sibling rows while one row is being renamed, hovered, or menu'd.
  const startRename = useCallback((id: string, currentTitle: string) => {
    setEditingId(id)
    setEditValue(currentTitle.slice(0, CHAT_TITLE_MAX_LENGTH))
    setMenuOpenId(null)
  }, [])

  // Takes the current value explicitly rather than reading it from a
  // component-level closure, so this can stay referentially stable across
  // every keystroke instead of being rebuilt each render.
  const submitRename = useCallback(
    (id: string, value: string) => {
      const nextTitle = value.trim().slice(0, CHAT_TITLE_MAX_LENGTH)
      if (nextTitle) onRenameChat(id, nextTitle)
      setEditingId(null)
      setEditValue('')
    },
    [onRenameChat],
  )

  const chatItemProps = {
    activeId,
    editingId,
    editValue,
    menuOpenId,
    onDeleteChat,
    onSelect,
    onTogglePin,
    setEditingId,
    setEditValue,
    setMenuOpenId,
    startRename,
    submitRename,
  }

  return (
    <div className="relative flex h-full w-full flex-col border-r border-white/5 bg-[#0a0a0c] text-foreground shadow-[4px_0_24px_rgba(0,0,0,0.5)] transition-all duration-300">
      <div className="flex h-16 items-center gap-3 p-4">
        <button
          type="button"
          onClick={onToggleOpen}
          aria-label={isOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          className="flex-shrink-0 rounded-xl p-2 text-muted-foreground transition-colors hover:bg-white/10 hover:text-[var(--accent-text)]"
        >
          {isOpen ? <PanelLeftClose size={20} /> : <PanelLeftOpen size={20} />}
        </button>

        {isOpen && (
          <div className="flex items-center gap-2 overflow-hidden whitespace-nowrap animate-fade-in">
            <HexicalLogo className="size-7 text-[var(--accent-text)] drop-shadow-[0_0_8px_var(--accent-border)]" />
            <span className="font-sans text-xl font-bold tracking-wide text-white">Hexical</span>
          </div>
        )}
      </div>

      <div className="mb-6 mt-2 px-3">
        <button
          type="button"
          onClick={onNewChat}
          className={`flex items-center gap-3 rounded-xl border border-white/5 bg-white/[0.03] text-muted-foreground transition-all hover:bg-white/[0.08] hover:text-[var(--accent-text)] ${
            isOpen ? 'w-full px-4 py-3' : 'mx-auto w-12 justify-center p-3'
          }`}
        >
          <Plus size={20} className="flex-shrink-0" />
          {isOpen && <span className="whitespace-nowrap text-sm font-medium">New Target</span>}
        </button>
      </div>

      {isOpen && (
        <div className="flex-1 space-y-6 overflow-y-auto px-3 scrollbar-thin scrollbar-thumb-white/10">
          {pinnedChats.length > 0 && (
            <div>
              <p className="mb-2 px-4 text-[10px] font-bold uppercase tracking-widest text-[var(--accent-text)]/70">
                Pinned Targets
              </p>
              <div className="space-y-[2px]">
                {pinnedChats.map((chat) => (
                  <ChatItem key={chat.id} chat={chat} {...chatItemProps} />
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="mb-2 px-4 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">
              Recents
            </p>
            <div className="space-y-[2px]">
              {recentChats.map((chat) => (
                <ChatItem key={chat.id} chat={chat} {...chatItemProps} />
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="mt-auto flex flex-col gap-2 border-t border-white/5 bg-[#0a0a0c] p-3">
        <div
          className={`flex flex-col gap-2 rounded-xl border p-2 ${
            safeTier === 'pro'
              ? 'border-amber-500/20 bg-amber-500/5'
              : safeTier === 'plus'
                ? 'border-fuchsia-500/20 bg-fuchsia-500/5'
                : 'border-cyan-500/10 bg-cyan-500/5'
          }`}
        >
          <div className={`items-center justify-between ${isOpen ? 'flex px-1' : 'hidden'}`}>
            <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">System License</span>
            <span
              className={`text-[9px] font-bold uppercase tracking-widest ${
                safeTier === 'pro' ? 'text-amber-400' : safeTier === 'plus' ? 'text-fuchsia-400' : 'text-cyan-400'
              }`}
            >
              {TIER_LABELS[safeTier]} Active
            </span>
          </div>

          {safeTier === 'pro' ? (
            <Link
              href="/dashboard/settings"
              className={`flex items-center justify-center gap-2 rounded-lg border border-white/5 bg-black/40 text-zinc-400 transition-all hover:border-white/10 hover:bg-white/5 hover:text-zinc-300 ${
                isOpen ? 'w-full px-3 py-2' : 'mx-auto w-10 p-2'
              }`}
            >
              <ShieldCheck size={14} className="flex-shrink-0" />
              {isOpen && <span className="text-xs font-bold tracking-wide">MANAGE LICENSE</span>}
            </Link>
          ) : (
            <button
              type="button"
              onClick={onOpenUpgrade}
              className={`flex items-center justify-center gap-2 rounded-lg border transition-all ${
                safeTier === 'plus'
                  ? 'border-fuchsia-500/20 bg-fuchsia-500/10 text-fuchsia-400 hover:bg-fuchsia-500/20'
                  : 'border-cyan-500/20 bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20'
              } ${isOpen ? 'w-full px-3 py-2' : 'mx-auto w-10 p-2'}`}
            >
              <Zap size={14} className="flex-shrink-0" />
              {isOpen && <span className="text-xs font-bold tracking-wide">UPGRADE TO PRO</span>}
            </button>
          )}
        </div>

        <Link
          href="/dashboard/settings"
          className={`group flex items-center gap-3 rounded-xl p-2.5 text-muted-foreground transition-colors hover:bg-white/5 hover:text-white ${
            isOpen ? 'w-full' : 'mx-auto w-12 justify-center'
          }`}
        >
          <Settings size={18} className="flex-shrink-0 transition-transform duration-300 group-hover:rotate-45" />
          {isOpen && <span className="text-sm font-medium">System Config</span>}
          {isOpen && (
            <span className="ml-auto hidden rounded border border-white/5 bg-white/5 px-1.5 py-0.5 text-[9px] tracking-widest text-zinc-600 md:inline">
              Cmd+,
            </span>
          )}
        </Link>

        <div
          className={`group/identity mt-1 flex items-center rounded-xl transition-colors ${
            isOpen ? 'w-full p-2 hover:bg-white/5' : 'mx-auto min-h-[48px] w-12 justify-center p-2'
          }`}
        >
          {!isLoaded && (
            <div className="flex w-full items-center gap-3">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt=""
                  className="size-8 flex-shrink-0 rounded-md object-cover"
                />
              ) : (
                <div className="size-8 flex-shrink-0 animate-pulse rounded-md bg-white/10" />
              )}
              {isOpen && (
                <div className="flex w-full flex-1 flex-col gap-1.5">
                  <div className="h-3.5 w-2/3 animate-pulse rounded bg-white/10" />
                  <div className="h-2.5 w-1/2 animate-pulse rounded bg-white/5" />
                </div>
              )}
            </div>
          )}

          {isLoaded && userId && (
            <div className="flex w-full items-center gap-3">
              <div className="flex flex-shrink-0 items-center justify-center">
                <UserButton afterSignOutUrl="/" appearance={{ elements: { avatarBox: 'size-8 rounded-md' } }} />
              </div>
              {isOpen && (
                <div className="flex flex-1 items-center overflow-hidden text-left">
                  <div className="flex flex-1 flex-col overflow-hidden">
                    <span className="w-full truncate text-sm font-semibold text-foreground">{userName}</span>
                    <span className="w-full truncate text-xs text-muted-foreground">{userEmail}</span>
                  </div>
                  {onSignOut && (
                    <button
                      type="button"
                      onClick={onSignOut}
                      title="Sign out"
                      aria-label="Sign out"
                      className="ml-2 flex-shrink-0 rounded-lg p-1.5 text-muted-foreground opacity-0 transition-all hover:bg-white/10 hover:text-rose-400 group-hover/identity:opacity-100"
                    >
                      <LogOut size={14} />
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {isLoaded && !userId && (
            <SignInButton mode="modal">
              <button type="button" className="flex w-full items-center justify-center gap-3 text-sm font-medium text-[var(--accent-text)]">
                <ShieldCheck size={18} className="flex-shrink-0" />
                {isOpen && <span>Authenticate Identity</span>}
              </button>
            </SignInButton>
          )}
        </div>
      </div>
    </div>
  )
}

interface ChatItemProps {
  chat: ChatThread
  menuOpenId: string | null
  setMenuOpenId: (id: string | null) => void
  editingId: string | null
  setEditingId: (id: string | null) => void
  editValue: string
  setEditValue: (value: string) => void
  onSelect: (id: string) => void
  submitRename: (id: string, value: string) => void
  startRename: (id: string, title: string) => void
  onTogglePin: (id: string) => void
  onDeleteChat: (id: string) => void
  activeId: string
}

const ChatItem = memo(function ChatItem({
  chat,
  menuOpenId,
  setMenuOpenId,
  editingId,
  setEditingId,
  editValue,
  setEditValue,
  onSelect,
  submitRename,
  startRename,
  onTogglePin,
  onDeleteChat,
  activeId,
}: ChatItemProps) {
  const isActive = activeId === chat.id
  const isEditing = editingId === chat.id
  const isMenuOpen = menuOpenId === chat.id

  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // Guards against the rename input's onBlur re-firing after Enter/Escape
  // has already unmounted it — removing a focused element from the DOM
  // triggers a native blur, which would otherwise replay a stale submit.
  const suppressBlurRef = useRef(false)
  const menuId = `chat-menu-${chat.id}`

  // Accessible menu-button focus behavior: send focus to the first item
  // when the menu opens, and return it to the trigger when it closes —
  // via keyboard, an item click, or an outside click, all funnel through
  // the same isMenuOpen transition.
  useEffect(() => {
    if (!isMenuOpen) return
    const firstItem = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')
    firstItem?.focus()
    return () => {
      menuTriggerRef.current?.focus()
    }
  }, [isMenuOpen])

  const focusMenuItem = (direction: 1 | -1) => {
    const items = menuRef.current
      ? Array.from(menuRef.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      : []
    if (items.length === 0) return
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)
    const nextIndex = (currentIndex + direction + items.length) % items.length
    items[nextIndex]?.focus()
  }

  return (
    <div className="group relative flex w-full items-center">
      {isEditing ? (
        <input
          autoFocus
          value={editValue}
          maxLength={CHAT_TITLE_MAX_LENGTH}
          aria-label={`Rename ${chat.title}`}
          onChange={(event) => setEditValue(event.target.value.slice(0, CHAT_TITLE_MAX_LENGTH))}
          onBlur={() => {
            if (suppressBlurRef.current) {
              suppressBlurRef.current = false
              return
            }
            if (!editValue.trim()) {
              setEditingId(null)
              setEditValue('')
              return
            }
            submitRename(chat.id, editValue)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              suppressBlurRef.current = true
              submitRename(chat.id, editValue)
            }
            if (event.key === 'Escape') {
              suppressBlurRef.current = true
              setEditingId(null)
              setEditValue('')
            }
          }}
          className="w-full flex-1 rounded-lg border border-[var(--accent-border)] bg-black/40 px-3 py-2 font-sans text-sm text-[var(--accent-text)] shadow-[0_0_10px_var(--accent-border)] outline-none"
        />
      ) : (
        <button
          type="button"
          aria-current={isActive ? 'page' : undefined}
          onClick={() => onSelect(chat.id)}
          className={`flex flex-1 items-center gap-3 truncate rounded-lg border p-2.5 font-sans text-sm transition-colors ${
            isActive
              ? 'border-white/5 bg-white/10 font-medium text-white'
              : 'border-transparent text-muted-foreground hover:bg-white/5'
          }`}
        >
          <MessageSquare size={16} className={`flex-shrink-0 ${isActive ? 'text-[var(--accent-text)]' : ''}`} />
          <span className="truncate">{chat.title}</span>
        </button>
      )}

      {!isEditing && (
        <button
          type="button"
          ref={menuTriggerRef}
          data-chat-menu-trigger
          aria-label={`Open options for ${chat.title}`}
          aria-haspopup="menu"
          aria-expanded={isMenuOpen}
          aria-controls={menuId}
          onClick={(event) => {
            event.stopPropagation()
            setMenuOpenId(isMenuOpen ? null : chat.id)
          }}
          className={`absolute right-1 rounded-md p-1.5 text-muted-foreground transition-all hover:bg-white/20 ${
            isMenuOpen ? 'bg-white/10 opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          <MoreVertical size={16} />
        </button>
      )}

      {isMenuOpen && (
        <div
          ref={menuRef}
          data-chat-menu
          id={menuId}
          role="menu"
          aria-label={`Options for ${chat.title}`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setMenuOpenId(null)
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              focusMenuItem(1)
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              focusMenuItem(-1)
            }
          }}
          className="absolute right-2 top-10 z-[999] w-48 rounded-xl border border-white/10 bg-[#111116] py-1.5 font-sans shadow-2xl animate-fade-in"
        >
          <button
            type="button"
            role="menuitem"
            onClick={(event) => {
              event.stopPropagation()
              setMenuOpenId(null)
            }}
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-foreground/80 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Download size={14} /> Export Trace Log
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={(event) => {
              event.stopPropagation()
              onTogglePin(chat.id)
              setMenuOpenId(null)
            }}
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-foreground/80 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Pin size={14} /> {chat.pinned ? 'Unpin Target' : 'Pin Target'}
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={(event) => {
              event.stopPropagation()
              startRename(chat.id, chat.title)
            }}
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-foreground/80 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Edit2 size={14} /> Rename
          </button>

          <div className="mx-2 my-1 h-px bg-white/5" />

          <button
            type="button"
            role="menuitem"
            onClick={(event) => {
              event.stopPropagation()
              onDeleteChat(chat.id)
              setMenuOpenId(null)
            }}
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-xs text-rose-400 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
          >
            <Trash2 size={14} /> Delete Thread
          </button>
        </div>
      )}
    </div>
  )
})