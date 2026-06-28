'use client'

import { useState, useEffect, useRef } from 'react'
import { Hexagon, Menu, UserCircle2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useGuestLimit } from '@/hooks/use-guest-limit'
import { inferRoute, type StreamMessage, type VerifyResponse } from '@/lib/hexical-types'
import { ChatSidebar } from './chat-sidebar'
import { DataStream } from './data-stream'
import { CommandInput } from './command-input'

const INITIAL_CHAT = { 
  id: '1', 
  title: 'New Chat', 
  messages: [{ id: 'init', role: 'hexical', text: 'SYSTEM ONLINE. READY FOR INPUT.', ts: '00:00', steps: [], valid: true }] 
}

// --- NEW: Time-based greeting logic ---
function getGreeting() {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 17) return 'Good afternoon'
  if (hour >= 17 && hour < 22) return 'Good evening'
  return 'Working late' // Fits the terminal vibe for midnight/early AM
}

export function HexicalConsole() {
  const [chats, setChats] = useState<any[]>([INITIAL_CHAT])
  const [activeId, setActiveId] = useState('1')
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [userName, setUserName] = useState('Guest')
  const [isMounted, setIsMounted] = useState(false)
  
  const { checkLimit } = useGuestLimit()
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chats, activeId])

  useEffect(() => {
    setIsMounted(true)
    const saved = localStorage.getItem('hexical_chats')
    if (saved) setChats(JSON.parse(saved))

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

  const activeChat = chats.find(c => c.id === activeId) || chats[0]

  async function handleGuestLogin() {
    const { error } = await supabase.auth.signInAnonymously()
    if (error) console.error("Guest login failed:", error.message)
    else window.location.reload()
  }

  async function handleSubmit(logic: string) {
    const isAuthenticated = (await supabase.auth.getSession()).data.session !== null
    if (!isAuthenticated && !checkLimit()) {
      localStorage.setItem('pending_draft', logic)
      window.location.href = '/login'
      return
    }

    if (busy) return
    const tsNow = () => new Date().toLocaleTimeString('en-GB', { hour12: false })
    const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36)
    
    const userMsg: StreamMessage = { id: uid(), role: 'user', text: logic, ts: tsNow() }
    
    setBusy(true)
    try {
      const res = await fetch('https://axiom-backend-b4ay.onrender.com/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logic, context: 'general' }),
      })
      const data: VerifyResponse = await res.json()
      
      const hexMsg: StreamMessage = { 
        id: uid(), role: 'hexical', text: data.analysis ?? '', steps: data.steps ?? [], 
        valid: Boolean(data.valid), route: inferRoute(data.steps ?? []), ts: tsNow() 
      }

      setChats(prev => prev.map(chat => {
        if (chat.id === activeId) {
          const newTitle = chat.messages.length === 1 ? logic.slice(0, 20) : chat.title
          return { ...chat, title: newTitle, messages: [...chat.messages, userMsg, hexMsg] }
        }
        return chat
      }))
    } catch {
      setChats(prev => prev.map(c => c.id === activeId ? { ...c, messages: [...c.messages, userMsg, { id: uid(), role: 'error', text: 'BACKEND ERROR', ts: tsNow(), steps: [], valid: false }] } : c))
    } finally {
      setBusy(false)
    }
  }

  if (!isMounted) return (
    <div className="flex h-screen w-full bg-background items-center justify-center">
      <div className="flex flex-col items-center gap-4 animate-pulse">
        <Hexagon className="size-10 text-primary/50" />
        <span className="font-mono text-xs text-muted-foreground uppercase tracking-widest">Initializing Environment...</span>
      </div>
    </div>
  )

  return (
    <div className="flex h-screen w-full bg-background text-foreground overflow-hidden selection:bg-primary/30">
      
      {isSidebarOpen && (
        <div className="z-50 transition-all duration-300 w-64 border-r border-border bg-card/30 backdrop-blur-sm">
           <ChatSidebar 
            chats={chats} 
            activeId={activeId} 
            onSelect={setActiveId}
            onNewChat={() => {
                const newId = Date.now().toString()
                const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36)
                const ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false })
                setChats([{ id: newId, title: 'New Chat', messages: [{ id: uid(), role: 'hexical', text: 'SYSTEM ONLINE.', ts: ts(), steps: [], valid: true }] }, ...chats])
                setActiveId(newId)
            }}
            onClose={() => setIsSidebarOpen(false)}
          />
        </div>
      )}

      <main className="flex-1 flex flex-col relative transition-all duration-300 bg-gradient-to-b from-background to-background/80">
        
        <div className="p-4 flex items-center gap-4 border-b border-border/50 bg-background/50 backdrop-blur-md z-10 sticky top-0">
            {!isSidebarOpen && (
                <button onClick={() => setIsSidebarOpen(true)} className="p-2 hover:bg-muted/50 rounded-lg transition-colors group">
                    <Menu className="size-5 text-muted-foreground group-hover:text-foreground" />
                </button>
            )}
            <div className="flex items-center gap-3">
                <div className="bg-primary/10 p-1.5 rounded-md border border-primary/20">
                  <Hexagon className="size-4 text-primary" />
                </div>
                <span className="font-mono text-sm uppercase tracking-widest font-bold text-foreground/90">Hexical</span>
            </div>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center overflow-hidden w-full relative">
           
           <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />

           {activeChat.messages.length <= 1 ? (
             <div className="text-center w-full px-4 animate-in fade-in slide-in-from-bottom-4 duration-1000 z-10">
               <div className="mb-8">
                 {/* --- NEW: Dynamic Greeting rendered here --- */}
                 <h2 className="text-3xl md:text-4xl font-semibold mb-3 text-foreground tracking-tight">
                   {getGreeting()}, {userName}.
                 </h2>
                 <p className="text-muted-foreground font-mono text-sm uppercase tracking-widest">
                   Awaiting logic verification
                 </p>
               </div>

               <div className="w-full max-w-2xl mx-auto">
                 <div className="shadow-2xl shadow-primary/5 rounded-2xl border border-muted/20 bg-background/50 backdrop-blur-sm">
                   <CommandInput onSubmit={handleSubmit} busy={busy} />
                 </div>
                 
                 {userName === 'Guest' && (
                    <button 
                      onClick={handleGuestLogin}
                      className="mt-8 flex items-center justify-center gap-2 mx-auto text-[11px] font-mono uppercase tracking-wider text-muted-foreground hover:text-primary transition-all duration-300 border border-muted/20 hover:border-primary/50 bg-muted/5 hover:bg-primary/10 px-6 py-2.5 rounded-full group"
                    >
                      <UserCircle2 className="size-4 group-hover:scale-110 transition-transform" />
                      Initialize Anonymous Session
                    </button>
                 )}
               </div>
             </div>
           ) : (
             <div className="w-full max-w-3xl flex flex-col h-full overflow-hidden z-10">
               <div className="flex-1 overflow-y-auto py-6 px-4 scroll-smooth">
                  <DataStream messages={activeChat.messages} busy={busy} />
                  <div ref={messagesEndRef} className="h-4 w-full" /> 
               </div>
               
               <div className="pb-6 px-4 pt-2 bg-gradient-to-t from-background via-background/95 to-transparent">
                  <div className="shadow-xl shadow-primary/5 rounded-2xl border border-muted/20 bg-background/80 backdrop-blur-md">
                    <CommandInput onSubmit={handleSubmit} busy={busy} />
                  </div>
               </div>
             </div>
           )}
        </div>
      </main>
    </div>
  )
}