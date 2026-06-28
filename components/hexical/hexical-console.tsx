'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Loader2 } from 'lucide-react'
import { HexicalLogo } from '@/components/hexical/hexical-logo'
import { supabase } from '@/lib/supabase'
import { useGuestLimit } from '@/hooks/use-guest-limit'
import { inferRoute, type StreamMessage, type VerifyResponse } from '@/lib/hexical-types'
import { ChatSidebar } from '@/components/hexical/chat-sidebar'
import { DataStream } from '@/components/hexical/data-stream'
import { CommandInput } from '@/components/hexical/command-input'

// -----------------------------------------------------------------------------
// CONSTANTS AND CONFIGURATIONS
// -----------------------------------------------------------------------------

const DEFAULT_GUEST_NAME = 'Guest'
const DEFAULT_GUEST_EMAIL = 'guest@hexical.ai'

const INITIAL_CHAT_STATE = { 
  id: '1', 
  title: 'New Chat', 
  pinned: false,
  messages: [{ 
    id: 'init', 
    role: 'hexical', 
    text: 'SYSTEM ONLINE. READY FOR INPUT.', 
    ts: '00:00', 
    steps: [], 
    valid: true 
  }] 
}

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS
// -----------------------------------------------------------------------------

/**
 * Returns a contextual greeting string based on the current hour.
 */
function getContextualGreeting(): string {
  const currentHour = new Date().getHours()
  if (currentHour >= 5 && currentHour < 12) return 'Good morning'
  if (currentHour >= 12 && currentHour < 17) return 'Good afternoon'
  if (currentHour >= 17 && currentHour < 22) return 'Good evening'
  return 'Working late'
}

/**
 * Generates a standard timestamp for messages.
 */
function generateTimestamp(): string {
  return new Date().toLocaleTimeString('en-GB', { hour12: false })
}

/**
 * Generates a unique message/chat ID.
 */
function generateUniqueID(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------

export function HexicalConsole() {
  // 1. APPLICATION DATA STATE
  const [chats, setChats] = useState<any[]>([INITIAL_CHAT_STATE])
  const [activeId, setActiveId] = useState<string>('1')
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true)
  const [busy, setBusy] = useState<boolean>(false)

  // 2. IDENTITY AND AUTHENTICATION STATE
  const [userName, setUserName] = useState<string>(DEFAULT_GUEST_NAME)
  const [userEmail, setUserEmail] = useState<string>(DEFAULT_GUEST_EMAIL)
  const [userAvatar, setUserAvatar] = useState<string | null>(null)
  const [isAuthLoading, setIsAuthLoading] = useState<boolean>(true)
  const [isMounted, setIsMounted] = useState<boolean>(false)

  // 3. REFERENCES
  const abortControllerRef = useRef<AbortController | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const { checkLimit } = useGuestLimit()

  // ---------------------------------------------------------------------------
  // LIFECYCLE: Persistence & Auth Hooks
  // ---------------------------------------------------------------------------

  useEffect(() => {
    setIsMounted(true)

    // Load persisted data
    const savedChats = localStorage.getItem('hexical_chats')
    if (savedChats) {
      try {
        const parsed = JSON.parse(savedChats)
        if (Array.isArray(parsed)) {
          console.log("DEBUG: Persistence loaded successfully.")
          setChats(parsed)
        }
      } catch (err) {
        console.error("DEBUG: Failed to parse persistence:", err)
      }
    }

    // Initialize Auth Session
    const initializeAuth = async () => {
      try {
        const { data } = await supabase.auth.getUser()
        if (data.user) {
          setUserName(data.user.user_metadata.full_name || 'User')
          setUserEmail(data.user.email || DEFAULT_GUEST_EMAIL)
          setUserAvatar(data.user.user_metadata.avatar_url || null)
        }
      } catch (err) {
        console.error("DEBUG: Auth initialization failed:", err)
      } finally {
        setIsAuthLoading(false)
      }
    }
    initializeAuth()
  }, [])

  useEffect(() => {
    if (isMounted) {
      localStorage.setItem('hexical_chats', JSON.stringify(chats))
    }
  }, [chats, isMounted])

  // ---------------------------------------------------------------------------
  // ACTION HANDLERS: Submission, Chat Mgmt
  // ---------------------------------------------------------------------------

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    window.location.reload()
  }

  const handleNewChat = useCallback(() => {
    const activeChat = chats.find(c => c.id === activeId)
    // Guard: Prevent duplicate empty chats
    if (activeChat && activeChat.messages.length <= 1 && activeChat.title === 'New Chat') return

    const newId = generateUniqueID()
    const newChat = { 
      id: newId, 
      title: 'New Chat', 
      pinned: false, 
      messages: [{ 
        id: generateUniqueID(), 
        role: 'hexical', 
        text: 'SYSTEM ONLINE.', 
        ts: generateTimestamp(), 
        steps: [], 
        valid: true 
      }] 
    }
    setChats(prev => [newChat, ...prev])
    setActiveId(newId)
  }, [chats, activeId])

  const handleRename = useCallback((id: string, newTitle: string) => {
    setChats(prev => prev.map(c => c.id === id ? { ...c, title: newTitle } : c))
  }, [])

  const handleTogglePin = useCallback((id: string) => {
    setChats(prev => prev.map(c => c.id === id ? { ...c, pinned: !c.pinned } : c))
  }, [])

  const handleDelete = useCallback((id: string) => {
    setChats(prev => {
      const filtered = prev.filter(c => c.id !== id)
      if (filtered.length === 0) {
        const newId = generateUniqueID()
        const fallback = { id: newId, title: 'New Chat', pinned: false, messages: [] }
        setActiveId(newId)
        return [fallback]
      }
      if (activeId === id) setActiveId(filtered[0].id)
      return filtered
    })
  }, [activeId])

  const handleSubmit = async (logic: string) => {
    if (busy || !logic.trim()) return

    // 1. Prepare optimistic message
    const activeChat = chats.find(c => c.id === activeId) || chats[0]
    const isFirstMessage = activeChat.messages.length <= 1
    const generatedTitle = isFirstMessage 
        ? logic.split(' ').slice(0, 5).join(' ') + (logic.length > 30 ? '...' : '') 
        : activeChat.title

    const userMsg: StreamMessage = { id: generateUniqueID(), role: 'user', text: logic, ts: generateTimestamp() }
    
    setChats(prev => prev.map(c => c.id === activeId 
        ? { ...c, title: generatedTitle, messages: [...c.messages, userMsg] } 
        : c
    ))

    // 2. Fetch API
    setBusy(true)
    abortControllerRef.current = new AbortController()

    try {
      const response = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logic }),
        signal: abortControllerRef.current.signal
      })

      if (!response.ok) throw new Error(`API Status: ${response.status}`)
      
      const data: VerifyResponse = await response.json()
      
      const hexMsg: StreamMessage = { 
        id: generateUniqueID(), 
        role: 'hexical', 
        text: data.analysis ?? 'Response empty.', 
        steps: data.steps ?? [], 
        valid: Boolean(data.valid), 
        route: inferRoute(data.steps ?? []), 
        ts: generateTimestamp() 
      }

      setChats(prev => prev.map(c => c.id === activeId ? { ...c, messages: [...c.messages, hexMsg] } : c))
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.error("System Error:", err)
      }
    } finally {
      setBusy(false)
    }
  }

  // ---------------------------------------------------------------------------
  // MAIN RENDER
  // ---------------------------------------------------------------------------

  if (!isMounted) return null
  const activeChat = chats.find(c => c.id === activeId) || chats[0]

  return (
    <div className="flex h-screen w-full bg-[#0a0a0c] text-foreground overflow-hidden">
      
      {/* SIDEBAR RENDER */}
      {isSidebarOpen && (
        <div className="w-[280px] h-full border-r border-white/5 transition-all duration-300">
           <ChatSidebar 
            chats={chats} 
            activeId={activeId} 
            isOpen={isSidebarOpen}
            userName={userName}
            userEmail={userEmail}
            avatarUrl={userAvatar}
            onToggleOpen={() => setIsSidebarOpen(false)}
            onSelect={(id: string) => setActiveId(id)} 
            onNewChat={handleNewChat} 
            onDeleteChat={handleDelete} 
            onRenameChat={handleRename}
            onTogglePin={handleTogglePin}
            onSignOut={handleSignOut}
           />
        </div>
      )}

      {/* MAIN CONTENT AREA */}
      <main className={`flex-1 flex flex-col relative transition-all duration-300 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-cyan-950/40 via-[#0a0a0c] to-[#0a0a0c] min-w-0 ${isSidebarOpen ? '' : 'pl-0'}`}>
        
        {/* Sidebar Trigger (When sidebar is hidden) */}
        {!isSidebarOpen && (
          <div className="absolute top-4 left-4 z-[999]">
            <button 
              onClick={() => setIsSidebarOpen(true)}
              className="flex items-center gap-3 hover:bg-white/5 p-2 rounded-xl transition-all group"
            >
              <HexicalLogo className="size-8" />
              <span className="font-sans text-xl font-semibold tracking-wide text-foreground group-hover:text-cyan transition-colors">
                Hexical
              </span>
            </button>
          </div>
        )}

        {/* Input/Message Flow */}
        <div className="flex-1 flex flex-col items-center justify-center overflow-hidden w-full relative p-4">
           {activeChat.messages.length <= 1 ? (
             <div className="w-full text-center max-w-2xl mx-auto animate-rise">
               <h2 className="text-3xl md:text-4xl font-sans mb-8 text-foreground drop-shadow-md">
                  {isAuthLoading ? <Loader2 className="animate-spin inline size-8 mr-2 text-cyan" /> : (
                    <>{getContextualGreeting()}, <span className="text-cyan font-semibold">{userName}</span>.</>
                  )}
               </h2>
               <div className="w-full rounded-2xl border border-cyan/10 p-2 backdrop-blur-2xl bg-white/5">
                   <CommandInput onSubmit={handleSubmit} busy={busy} onStop={() => abortControllerRef.current?.abort()} />
               </div>
             </div>
           ) : (
             <div className="w-full max-w-3xl flex flex-col h-full overflow-hidden pt-4">
               <div className="flex-1 overflow-y-auto px-4"><DataStream messages={activeChat.messages} busy={busy} /><div ref={messagesEndRef} className="h-4" /></div>
               <div className="pb-6 px-4 pt-2 bg-gradient-to-t from-[#0a0a0c] to-transparent">
                   <div className="rounded-3xl border border-white/5 bg-white/5 backdrop-blur-2xl"><CommandInput onSubmit={handleSubmit} busy={busy} onStop={() => abortControllerRef.current?.abort()} /></div>
               </div>
             </div>
           )}
        </div>
      </main>
    </div>
  )
}