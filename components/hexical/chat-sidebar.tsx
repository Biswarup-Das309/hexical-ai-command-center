'use client'

import { useState, useRef, useEffect } from 'react'
import { 
  MessageSquare, MoreVertical, Trash2, Edit2, Pin, Settings, 
  Plus, PanelLeftClose, PanelLeftOpen, Share2 
} from 'lucide-react'

// --- CLERK AUTHENTICATION IMPORTS ---
// We import 'Show' instead of SignedIn/SignedOut based on your project's documentation.
import { UserButton, SignInButton, Show } from '@clerk/nextjs'

// --- PROJECT SPECIFIC IMPORTS ---
import { HexicalLogo } from './hexical-logo'

// -----------------------------------------------------------------------------
// INTERFACES
// -----------------------------------------------------------------------------

interface ChatSidebarProps {
  chats: any[]
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
  onSignOut 
}: ChatSidebarProps) {
  
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

  // ---------------------------------------------------------------------------
  // RENDER LOGIC
  // ---------------------------------------------------------------------------

  return (
    <div className="relative flex flex-col h-full w-full bg-[#0a0a0c] text-foreground transition-all duration-300 border-r border-white/5">
      
      {/* 1. Sidebar Header Area */}
      <div className="flex items-center p-4 gap-3 h-16">
        <button 
          onClick={onToggleOpen} 
          className="p-2 hover:bg-white/10 rounded-full transition-colors text-muted-foreground hover:text-cyan flex-shrink-0"
        >
          {isOpen ? <PanelLeftClose size={20} /> : <PanelLeftOpen size={20} />}
        </button>
        {isOpen && (
          <div className="flex items-center gap-2 animate-fade-in whitespace-nowrap overflow-hidden">
            <HexicalLogo className="size-7" />
            <span className="font-sans text-xl font-semibold tracking-wide">Hexical</span>
          </div>
        )}
      </div>

      {/* 2. New Chat Button Area */}
      <div className="px-3 mb-6">
        <button 
          onClick={onNewChat} 
          className={`flex items-center gap-3 bg-white/5 hover:bg-white/10 text-muted-foreground hover:text-cyan transition-all rounded-full ${isOpen ? 'px-4 py-3 w-full' : 'p-3 w-12 mx-auto justify-center'}`}
        >
          <Plus size={20} className="flex-shrink-0" />
          {isOpen && <span className="text-sm font-medium whitespace-nowrap">New chat</span>}
        </button>
      </div>

      {/* 3. Chat History List */}
      {isOpen && (
        <div className="flex-1 overflow-y-auto px-3 space-y-6 scrollbar-thin">
          {pinnedChats.length > 0 && (
            <div>
              <p className="px-4 mb-2 text-[11px] font-bold text-cyan/70 uppercase">Pinned</p>
              <div className="space-y-[2px]">
                {pinnedChats.map(chat => (
                  <ChatItem key={chat.id} chat={chat} menuOpenId={menuOpenId} setMenuOpenId={setMenuOpenId} menuRef={menuRef} editingId={editingId} editValue={editValue} setEditValue={setEditValue} onSelect={onSelect} submitRename={submitRename} startRename={startRename} onTogglePin={onTogglePin} onDeleteChat={onDeleteChat} activeId={activeId} />
                ))}
              </div>
            </div>
          )}
          
          <div>
            <p className="px-4 mb-2 text-[11px] font-bold text-muted-foreground/50 uppercase">Recents</p>
            <div className="space-y-[2px]">
              {recentChats.map(chat => (
                <ChatItem key={chat.id} chat={chat} menuOpenId={menuOpenId} setMenuOpenId={setMenuOpenId} menuRef={menuRef} editingId={editingId} editValue={editValue} setEditValue={setEditValue} onSelect={onSelect} submitRename={submitRename} startRename={startRename} onTogglePin={onTogglePin} onDeleteChat={onDeleteChat} activeId={activeId} />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 4. Clerk Auth & User Button Area */}
      <div className="p-3 mt-auto border-t border-white/5 flex flex-col gap-1">
        
        {/* Settings button */}
        <button className={`flex items-center gap-3 p-3 rounded-full hover:bg-white/10 transition-colors text-muted-foreground hover:text-cyan ${isOpen ? 'w-full' : 'justify-center w-12 mx-auto'}`}>
          <Settings size={20} />
          {isOpen && <span className="text-sm font-medium">Settings</span>}
        </button>
        
        {/* User Account / Login Toggle using Clerk Show components */}
        <div className={`flex items-center gap-3 p-2 rounded-full hover:bg-white/10 transition-colors ${isOpen ? 'w-full' : 'justify-center w-12 mx-auto'}`}>
          
          {/* User is signed in */}
          <Show when="signed-in">
            <UserButton afterSignOut="/" />
            {isOpen && <span className="text-sm font-medium text-foreground truncate">My Account</span>}
          </Show>

          {/* User is signed out */}
          <Show when="signed-out">
            <SignInButton mode="modal">
               <button className="flex items-center gap-3 w-full text-sm font-medium text-cyan px-2">
                 {isOpen && <span>Sign In</span>}
               </button>
            </SignInButton>
          </Show>
          
        </div>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// SUB-COMPONENT: ChatItem (Handles list items and menu)
// -----------------------------------------------------------------------------

function ChatItem({ chat, menuOpenId, setMenuOpenId, menuRef, editingId, editValue, setEditValue, onSelect, submitRename, startRename, onTogglePin, onDeleteChat, activeId }: any) {
  const isActive = activeId === chat.id
  
  return (
    <div className="relative group flex items-center w-full">
      {editingId === chat.id ? (
        <input 
          autoFocus 
          value={editValue} 
          onChange={(e) => setEditValue(e.target.value)} 
          onBlur={() => submitRename(chat.id)} 
          onKeyDown={(e) => e.key === 'Enter' && submitRename(chat.id)} 
          className="flex-1 bg-white/5 border border-cyan/50 text-sm p-2.5 rounded-full outline-none text-cyan w-full" 
        />
      ) : (
        <button onClick={() => onSelect(chat.id)} className={`flex-1 flex items-center gap-3 p-2.5 rounded-full text-sm truncate transition-colors ${isActive ? 'bg-white/10 text-white font-medium' : 'text-muted-foreground hover:bg-white/5'}`}>
          <MessageSquare size={16} />
          <span className="truncate">{chat.title}</span>
        </button>
      )}
      
      {!editingId && (
        <button onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === chat.id ? null : chat.id) }} className={`p-2 rounded-full hover:bg-white/20 text-muted-foreground transition-all ${menuOpenId === chat.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
          <MoreVertical size={16} />
        </button>
      )}
      
      {menuOpenId === chat.id && (
        <div ref={menuRef} className="absolute right-2 top-8 w-48 bg-[#1f2128] border border-white/10 shadow-2xl rounded-xl py-1 z-[999]">
          <button onClick={() => { setMenuOpenId(null) }} className="w-full text-left px-4 py-2 text-sm hover:bg-white/10 flex items-center gap-2"><Share2 size={14} /> Share conversation</button>
          <button onClick={() => { onTogglePin(chat.id); setMenuOpenId(null) }} className="w-full text-left px-4 py-2 text-sm hover:bg-white/10 flex items-center gap-2"><Pin size={14} /> {chat.pinned ? 'Unpin' : 'Pin'}</button>
          <button onClick={() => startRename(chat.id, chat.title)} className="w-full text-left px-4 py-2 text-sm hover:bg-white/10 flex items-center gap-2"><Edit2 size={14} /> Rename</button>
          <button onClick={() => { onDeleteChat(chat.id); setMenuOpenId(null) }} className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-red-500/10 flex items-center gap-2"><Trash2 size={14} /> Delete</button>
        </div>
      )}
    </div>
  )
}