'use client'

import { useState, useEffect, useRef } from 'react'
import { 
  MessageSquare, MoreVertical, Trash2, Edit2, Pin, Settings, 
  Plus, PanelLeftClose, PanelLeftOpen, Download 
} from 'lucide-react'

// --- CLERK AUTHENTICATION IMPORTS ---
// FIXED: Ripped out SignedIn/SignedOut wrappers to bypass Turbopack export errors.
// Added 'useAuth' for programmatic, flicker-free client-side authentication.
import { UserButton, SignInButton, useAuth } from '@clerk/nextjs'

// --- PROJECT SPECIFIC IMPORTS ---
import { HexicalLogo } from './hexical-logo'

// -----------------------------------------------------------------------------
// INTERFACES
// -----------------------------------------------------------------------------

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
  avatarUrl: string | null
  onToggleOpen: () => void
  onSelect: (id: string) => void
  onNewChat: () => void
  onDeleteChat: (id: string) => void
  onRenameChat: (id: string, newTitle: string) => void
  onTogglePin: (id: string) => void
  onSignOut: () => void
  onOpenSettings: () => void
}

// -----------------------------------------------------------------------------
// MAIN COMPONENT: ChatSidebar
// -----------------------------------------------------------------------------

export function ChatSidebar({ 
  chats, 
  activeId, 
  isOpen, 
  userName, 
  userEmail, 
  avatarUrl, 
  onToggleOpen, 
  onSelect, 
  onNewChat, 
  onDeleteChat, 
  onRenameChat, 
  onTogglePin, 
  onSignOut,
  onOpenSettings
}: ChatSidebarProps) {
  
  // --- AUTHENTICATION STATE ---
  // This completely bypasses the Turbopack export bug.
  const { isLoaded, userId } = useAuth()

  // --- UI STATE MANAGEMENT ---
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  // --- MENU CLICK-OUTSIDE HANDLER ---
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpenId(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // --- CHAT RENAME LOGIC ---
  const startRename = (id: string, currentTitle: string) => {
    setEditingId(id)
    setEditValue(currentTitle)
    setMenuOpenId(null)
  }

  const submitRename = (id: string) => {
    if (editValue.trim()) onRenameChat(id, editValue.trim())
    setEditingId(null)
  }

  // --- FILTERING CHATS ---
  const pinnedChats = chats.filter(c => c.pinned)
  const recentChats = chats.filter(c => !c.pinned)

  // --- SHARED PROPS FOR CHAT ITEMS ---
  const chatItemProps = {
    menuOpenId,
    setMenuOpenId,
    menuRef,
    editingId,
    setEditingId,
    editValue,
    setEditValue,
    onSelect,
    submitRename,
    startRename,
    onTogglePin,
    onDeleteChat,
    activeId
  }

  // ---------------------------------------------------------------------------
  // RENDER LOGIC
  // ---------------------------------------------------------------------------

  return (
    <div className="relative flex flex-col h-full w-full bg-[#0a0a0c] text-foreground transition-all duration-300 border-r border-white/5">
      
      {/* 1. Sidebar Header Area */}
      <div className="flex items-center p-4 gap-3 h-16">
        <button 
          onClick={onToggleOpen} 
          className="p-2 hover:bg-white/10 rounded-xl transition-colors text-muted-foreground hover:text-cyan-400 flex-shrink-0"
        >
          {isOpen ? <PanelLeftClose size={20} /> : <PanelLeftOpen size={20} />}
        </button>
        {isOpen && (
          <div className="flex items-center gap-2 animate-fade-in whitespace-nowrap overflow-hidden">
            <HexicalLogo className="size-7 text-cyan-400" />
            <span className="font-sans text-xl font-semibold tracking-wide">Hexical</span>
          </div>
        )}
      </div>

      {/* 2. New Chat Button Area */}
      <div className="px-3 mb-6 mt-2">
        <button 
          onClick={onNewChat} 
          className={`flex items-center gap-3 bg-white/[0.03] hover:bg-white/[0.08] border border-white/5 text-muted-foreground hover:text-cyan-400 transition-all rounded-xl ${isOpen ? 'px-4 py-3 w-full' : 'p-3 w-12 mx-auto justify-center'}`}
        >
          <Plus size={20} className="flex-shrink-0" />
          {isOpen && <span className="text-sm font-medium whitespace-nowrap">New Target</span>}
        </button>
      </div>

      {/* 3. Chat History List */}
      {isOpen && (
        <div className="flex-1 overflow-y-auto px-3 space-y-6 scrollbar-thin scrollbar-thumb-white/10">
          {pinnedChats.length > 0 && (
            <div>
              <p className="px-4 mb-2 text-[10px] font-bold text-cyan-500/70 uppercase tracking-widest">Pinned</p>
              <div className="space-y-[2px]">
                {pinnedChats.map(chat => (
                  <ChatItem key={chat.id} chat={chat} {...chatItemProps} />
                ))}
              </div>
            </div>
          )}
          
          <div>
            <p className="px-4 mb-2 text-[10px] font-bold text-muted-foreground/50 uppercase tracking-widest">Recents</p>
            <div className="space-y-[2px]">
              {recentChats.map(chat => (
                <ChatItem key={chat.id} chat={chat} {...chatItemProps} />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 4. Auth & User Button Area */}
      <div className="p-3 mt-auto border-t border-white/5 flex flex-col gap-1 bg-[#0a0a0c]">
        
        {/* Settings Button */}
        <button 
          onClick={onOpenSettings}
          className={`flex items-center gap-3 p-2.5 rounded-xl hover:bg-white/5 transition-colors text-muted-foreground hover:text-cyan-400 group ${isOpen ? 'w-full' : 'justify-center w-12 mx-auto'}`}
        >
          <Settings size={18} className="flex-shrink-0 group-hover:rotate-45 transition-transform duration-300" />
          {isOpen && <span className="text-sm font-medium">System Config</span>}
          {isOpen && <span className="ml-auto text-[9px] text-zinc-600 bg-white/5 px-1.5 py-0.5 rounded border border-white/5 tracking-widest hidden md:inline">Cmd+,</span>}
        </button>
        
        {/* User Account / Login Toggle */}
        <div className={`flex items-center rounded-xl transition-colors mt-1 ${isOpen ? 'w-full hover:bg-white/5 p-2' : 'justify-center w-12 mx-auto p-2 min-h-[48px]'}`}>
          
          {/* THE UPGRADE: Skeleton Loader while Clerk boots up */}
          {!isLoaded && (
             <div className="flex items-center gap-3 w-full animate-pulse">
                <div className="size-8 bg-white/10 rounded-md flex-shrink-0" />
                {isOpen && (
                  <div className="flex flex-col gap-1.5 flex-1 w-full">
                    <div className="h-3.5 bg-white/10 rounded w-2/3" />
                    <div className="h-2.5 bg-white/5 rounded w-1/2" />
                  </div>
                )}
             </div>
          )}

          {/* SIGNED IN STATE */}
          {isLoaded && userId && (
            <div className="flex items-center gap-3 w-full">
              <div className="flex-shrink-0 flex items-center justify-center">
                <UserButton afterSignOutUrl="/" appearance={{ elements: { avatarBox: "size-8 rounded-md" } }} />
              </div>
              {isOpen && (
                <div className="flex flex-col overflow-hidden text-left flex-1">
                  <span className="text-sm font-semibold text-foreground truncate w-full">{userName}</span>
                  <span className="text-xs text-muted-foreground truncate w-full">{userEmail}</span>
                </div>
              )}
            </div>
          )}

          {/* SIGNED OUT STATE */}
          {isLoaded && !userId && (
            <SignInButton mode="modal">
               <button className="flex items-center gap-3 w-full text-sm font-medium text-cyan-400">
                 {isOpen && <span>Authenticate Identity</span>}
               </button>
            </SignInButton>
          )}
          
        </div>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// SUB-COMPONENT: ChatItem 
// -----------------------------------------------------------------------------

interface ChatItemProps {
  chat: ChatThread
  menuOpenId: string | null
  setMenuOpenId: (id: string | null) => void
  menuRef: React.RefObject<HTMLDivElement>
  editingId: string | null
  setEditingId: (id: string | null) => void
  editValue: string
  setEditValue: (val: string) => void
  onSelect: (id: string) => void
  submitRename: (id: string) => void
  startRename: (id: string, title: string) => void
  onTogglePin: (id: string) => void
  onDeleteChat: (id: string) => void
  activeId: string
}

function ChatItem({ 
  chat, menuOpenId, setMenuOpenId, menuRef, editingId, setEditingId, 
  editValue, setEditValue, onSelect, submitRename, startRename, 
  onTogglePin, onDeleteChat, activeId 
}: ChatItemProps) {
  const isActive = activeId === chat.id
  
  return (
    <div className="relative group flex items-center w-full">
      {editingId === chat.id ? (
        <input 
          autoFocus 
          value={editValue} 
          onChange={(e) => setEditValue(e.target.value)} 
          onBlur={() => submitRename(chat.id)} 
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitRename(chat.id)
            if (e.key === 'Escape') setEditingId(null) 
          }} 
          className="flex-1 bg-black/40 border border-cyan-500/50 text-sm px-3 py-2 rounded-lg outline-none text-cyan-400 w-full font-sans shadow-[0_0_10px_rgba(34,211,238,0.1)]" 
        />
      ) : (
        <button onClick={() => onSelect(chat.id)} className={`flex-1 flex items-center gap-3 p-2.5 rounded-lg text-sm truncate transition-colors font-sans ${isActive ? 'bg-white/10 text-white font-medium border border-white/5' : 'text-muted-foreground hover:bg-white/5 border border-transparent'}`}>
          <MessageSquare size={16} className={`flex-shrink-0 ${isActive ? 'text-cyan-400' : ''}`} />
          <span className="truncate">{chat.title}</span>
        </button>
      )}
      
      {!editingId && (
        <button onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === chat.id ? null : chat.id) }} className={`absolute right-1 p-1.5 rounded-md hover:bg-white/20 text-muted-foreground transition-all ${menuOpenId === chat.id ? 'opacity-100 bg-white/10' : 'opacity-0 group-hover:opacity-100'}`}>
          <MoreVertical size={16} />
        </button>
      )}
      
      {menuOpenId === chat.id && (
        <div ref={menuRef} className="absolute right-2 top-10 w-48 bg-[#111116] border border-white/10 shadow-2xl rounded-xl py-1.5 z-[999] animate-fade-in font-sans">
          <button onClick={(e) => { e.stopPropagation(); setMenuOpenId(null) }} className="w-full text-left px-4 py-2 text-xs text-foreground/80 hover:text-white hover:bg-white/10 flex items-center gap-2 transition-colors"><Download size={14} /> Export Trace Log</button>
          <button onClick={(e) => { e.stopPropagation(); onTogglePin(chat.id); setMenuOpenId(null) }} className="w-full text-left px-4 py-2 text-xs text-foreground/80 hover:text-white hover:bg-white/10 flex items-center gap-2 transition-colors"><Pin size={14} /> {chat.pinned ? 'Unpin Target' : 'Pin Target'}</button>
          <button onClick={(e) => { e.stopPropagation(); startRename(chat.id, chat.title) }} className="w-full text-left px-4 py-2 text-xs text-foreground/80 hover:text-white hover:bg-white/10 flex items-center gap-2 transition-colors"><Edit2 size={14} /> Rename</button>
          
          <div className="h-px bg-white/5 my-1 mx-2" />
          
          <button onClick={(e) => { e.stopPropagation(); onDeleteChat(chat.id); setMenuOpenId(null) }} className="w-full text-left px-4 py-2 text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 flex items-center gap-2 transition-colors"><Trash2 size={14} /> Delete Thread</button>
        </div>
      )}
    </div>
  )
}