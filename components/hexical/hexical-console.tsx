'use client'

import { useState, useEffect, useRef } from 'react'
import { PanelLeftClose, PanelLeftOpen, MoreVertical, Settings, Trash2, Download, Moon, Sun } from 'lucide-react'
import { HexicalLogo } from '@/components/hexical/hexical-logo'
import { supabase } from '@/lib/supabase'
import { useGuestLimit } from '@/hooks/use-guest-limit'
import { inferRoute, type StreamMessage, type VerifyResponse } from '@/lib/hexical-types'
import { ChatSidebar } from '@/components/hexical/chat-sidebar'
import { DataStream } from '@/components/hexical/data-stream'
import { CommandInput } from '@/components/hexical/command-input'

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const INITIAL_CHAT = { 
  id: '1', 
  title: 'New Chat', 
  messages: [{ 
    id: 'init', 
    role: 'hexical', 
    text: 'SYSTEM ONLINE. READY FOR INPUT.', 
    ts: '00:00', 
    steps: [], 
    valid: true 
  }] 
}

function getGreeting() {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 17) return 'Good afternoon'
  if (hour >= 17 && hour < 22) return 'Good evening'
  return 'Working late'
}

export function HexicalConsole() {
  const [chats, setChats] = useState<any[]>([INITIAL_CHAT])
  const [activeId, setActiveId] = useState('1')
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [userName, setUserName] = useState('Guest')
  const [isMounted, setIsMounted] = useState(false)
  const [theme, setTheme] = useState('dark')
  
  const menuRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const { checkLimit } = useGuestLimit()

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  useEffect(() => {
    setIsMounted(true)
    const savedChats = localStorage.getItem('hexical_chats')
    if (savedChats) try { setChats(JSON.parse(savedChats)) } catch (err) { console.error(err) }
    
    const savedTheme = localStorage.getItem('hexical_theme')
    if (savedTheme === 'light') {
      setTheme('light')
      document.documentElement.classList.remove('dark')
    } else {
      setTheme('dark')
      document.documentElement.classList.add('dark')
    }
    
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        const name = data.user.user_metadata.full_name?.split(' ')[0] || 'User'
        setUserName(name)
      }
    })
  }, [])

  useEffect(() => {
    if (isMounted) localStorage.setItem('hexical_chats', JSON.stringify(chats))
  }, [chats, isMounted])

  // ---------------------------------------------------------------------------
  // Submission Logic
  // ---------------------------------------------------------------------------

  async function handleSubmit(logic: string) {
    if (busy || !logic.trim()) return
    
    const tsNow = () => new Date().toLocaleTimeString('en-GB', { hour12: false })
    const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36)
    
    // 1. ADD USER MESSAGE IMMEDIATELY (Optimistic)
    const userMsg: StreamMessage = { id: uid(), role: 'user', text: logic, ts: tsNow() }
    
    setChats(prev => prev.map(chat => {
        if (chat.id === activeId) {
            return { ...chat, messages: [...chat.messages, userMsg] }
        }
        return chat
    }))

    setBusy(true)
    abortControllerRef.current = new AbortController()

    try {
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logic }),
        signal: abortControllerRef.current.signal 
      })

      if (!res.ok) throw new Error(`Status: ${res.status}`)

      const data: VerifyResponse = await res.json()
      
      const hexMsg: StreamMessage = { 
        id: uid(), 
        role: 'hexical', 
        text: data.analysis ?? 'Response empty.', 
        steps: data.steps ?? [], 
        valid: Boolean(data.valid), 
        route: inferRoute(data.steps ?? []), 
        ts: tsNow() 
      }
      
      // 2. APPEND AI RESPONSE TO EXISTING CHAT
      setChats(prev => prev.map(chat => {
        if (chat.id === activeId) {
          // Explicitly merge the new message with the existing array
          return { ...chat, messages: [...chat.messages, hexMsg] }
        }
        return chat
      }))
      
    } catch (err: any) {
      if (err.name !== 'AbortError') {
          console.error("Fetch Error:", err)
          setChats(prev => prev.map(c => 
            c.id === activeId 
              ? { ...c, messages: [...c.messages, { id: uid(), role: 'error', text: 'Connection lost.', ts: tsNow(), steps: [], valid: false }] } 
              : c
          ))
      }
    } finally {
      setBusy(false)
      abortControllerRef.current = null
    }
  }

  function handleNewChat() {
    const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36)
    const newChat = {
      id: uid(),
      title: 'New Chat',
      messages: [{
        id: uid(),
        role: 'hexical',
        text: 'SYSTEM ONLINE. READY FOR INPUT.',
        ts: new Date().toLocaleTimeString('en-GB', { hour12: false }),
        steps: [],
        valid: true
      }]
    }

    setChats(prev => [...prev, newChat])
    setActiveId(newChat.id)
    setIsSidebarOpen(true)
  }

  function handleDeleteChat(id: string) {
    setChats(prev => {
      const nextChats = prev.filter(chat => chat.id !== id)

      if (nextChats.length === 0) {
        setActiveId(INITIAL_CHAT.id)
        return [INITIAL_CHAT]
      }

      if (activeId === id) {
        setActiveId(nextChats[0].id)
      }

      return nextChats
    })
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!isMounted) return null
  const activeChat = chats.find(c => c.id === activeId) || chats[0]

  function handleStopGeneration(): void {
    // Abort any in-flight verification/generation request
    if (abortControllerRef.current) {
      try {
        abortControllerRef.current.abort()
      } catch (e) {
        console.error('Abort error', e)
      }
      abortControllerRef.current = null
    }

    // Mark not busy
    setBusy(false)

    // Optionally append a stopped message to the active chat
    const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36)
    const tsNow = () => new Date().toLocaleTimeString('en-GB', { hour12: false })
    setChats(prev => prev.map(c => c.id === activeId ? { ...c, messages: [...c.messages, { id: uid(), role: 'error', text: 'Generation stopped.', ts: tsNow(), steps: [], valid: false }] } : c))
  }

  return (
    <div className="flex h-screen w-full bg-background text-foreground overflow-hidden hud-grid">
      <div className={`z-50 bg-card transition-all duration-300 ease-in-out flex flex-col h-full ${isSidebarOpen ? 'w-64 border-r border-border' : 'w-0 border-none'}`}>
         <div className="w-64 h-full">
            {isSidebarOpen && <ChatSidebar chats={chats} activeId={activeId} onSelect={(id: string) => setActiveId(id)} onNewChat={handleNewChat} onDeleteChat={handleDeleteChat} onClose={() => setIsSidebarOpen(false)} />}
         </div>
      </div>

      <main className="flex-1 flex flex-col relative transition-all duration-300 bg-gradient-to-b from-background to-background/80 min-w-0">
        <div className="p-4 flex items-center justify-between z-10 sticky top-0">
            <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="p-2 hover:bg-muted/50 rounded-lg">
                {isSidebarOpen ? <PanelLeftClose className="size-5 text-muted-foreground" /> : <PanelLeftOpen className="size-5 text-muted-foreground" />}
            </button>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center overflow-hidden w-full relative p-4">
           {activeChat.messages.length <= 1 ? (
             <div className="w-full text-center max-w-2xl mx-auto animate-rise">
               <h2 className="text-3xl md:text-4xl font-sans mb-8 text-foreground">
                  {getGreeting()}, <span className="text-cyan text-glow-cyan">{userName}</span>.
               </h2>
               <div className="w-full shadow-2xl rounded-full border-glow-cyan glass p-2">
                   <CommandInput onSubmit={handleSubmit} busy={busy} onStop={handleStopGeneration} />
               </div>
             </div>
           ) : (
             <div className="w-full max-w-3xl flex flex-col h-full overflow-hidden">
               <div className="flex-1 overflow-y-auto py-6 px-4">
                   <DataStream messages={activeChat.messages} busy={busy} />
                   <div ref={messagesEndRef} className="h-4 w-full" /> 
               </div>
               <div className="pb-6 px-4 pt-2 bg-gradient-to-t from-background via-background/95 to-transparent">
                   <div className="shadow-xl rounded-2xl border border-muted/20 bg-background/80 backdrop-blur-md">
                       <CommandInput onSubmit={handleSubmit} busy={busy} onStop={handleStopGeneration} />
                   </div>
               </div>
             </div>
           )}
        </div>
      </main>
    </div>
  )
}