'use client'

import { useEffect, useState } from 'react'
import { Hexagon, Menu } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useGuestLimit } from '@/hooks/use-guest-limit'
import { inferRoute, type StreamMessage, type VerifyResponse } from '@/lib/hexical-types'
import { ChatSidebar } from './chat-sidebar'
import { DataStream } from './data-stream'
import { CommandInput } from './command-input'

interface Chat {
  id: string
  title: string
  messages: StreamMessage[]
}

function tsNow() { return new Date().toLocaleTimeString('en-GB', { hour12: false }) }
function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36) }

export function HexicalConsole() {
  // 1. Initialize State with Lazy Loading from localStorage
  const [chats, setChats] = useState<Chat[]>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('hexical_chats')
      return saved ? JSON.parse(saved) : [{ id: '1', title: 'New Chat', messages: [{ id: 'init', role: 'hexical', text: 'SYSTEM ONLINE.', ts: tsNow(), steps: [], valid: true }] }]
    }
    return [{ id: '1', title: 'New Chat', messages: [{ id: 'init', role: 'hexical', text: 'SYSTEM ONLINE.', ts: tsNow(), steps: [], valid: true }] }]
  })

  const [activeId, setActiveId] = useState('1')
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [userName, setUserName] = useState('Guest')
  
  const { checkLimit } = useGuestLimit()

  // 2. Sync to localStorage whenever chats change
  useEffect(() => {
    localStorage.setItem('hexical_chats', JSON.stringify(chats))
  }, [chats])

  // Fetch User Name for Greeting
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        const name = data.user.user_metadata.full_name?.split(' ')[0] || 'User'
        setUserName(name)
      }
    })
  }, [])

  const activeChat = chats.find(c => c.id === activeId) || chats[0]

  async function handleSubmit(logic: string) {
    const isAuthenticated = (await supabase.auth.getSession()).data.session !== null
    if (!isAuthenticated && !checkLimit()) {
      localStorage.setItem('pending_draft', logic)
      window.location.href = '/login'
      return
    }

    if (busy) return
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

  return (
    <div className="flex h-screen w-full bg-background text-foreground overflow-hidden">
      
      {/* SIDEBAR */}
      {isSidebarOpen && (
        <div className="z-50 transition-all duration-300">
           <ChatSidebar 
            chats={chats} 
            activeId={activeId} 
            onSelect={setActiveId}
            onNewChat={() => {
                const activeChat = chats.find(c => c.id === activeId)
                if (activeChat && activeChat.messages.length === 1) return
                
                const newId = Date.now().toString()
                setChats([{ id: newId, title: 'New Chat', messages: [{ id: uid(), role: 'hexical', text: 'SYSTEM ONLINE.', ts: tsNow(), steps: [], valid: true }] }, ...chats])
                setActiveId(newId)
            }}
            onClose={() => setIsSidebarOpen(false)}
          />
        </div>
      )}

      {/* MAIN CHAT AREA */}
      <main className="flex-1 flex flex-col relative transition-all duration-300">
        <div className="p-4 flex items-center gap-4">
            {!isSidebarOpen && (
                <button onClick={() => setIsSidebarOpen(true)} className="p-2 hover:bg-muted/30 rounded-lg transition-colors">
                    <Menu className="size-5" />
                </button>
            )}
            <div className="flex items-center gap-2">
                <Hexagon className="size-5 text-primary" />
                <span className="font-mono text-sm uppercase tracking-widest font-bold">Hexical AI</span>
            </div>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center overflow-hidden w-full">
           {activeChat.messages.length <= 1 ? (
             <div className="text-center w-full px-4 animate-in fade-in duration-700">
               <h2 className="text-2xl font-semibold mb-8 text-foreground/90">Good to see you, {userName}.</h2>
               <div className="w-full max-w-2xl mx-auto">
                 <CommandInput onSubmit={handleSubmit} busy={busy} />
               </div>
             </div>
           ) : (
             <div className="w-full max-w-3xl flex flex-col h-full overflow-hidden">
               <div className="flex-1 overflow-y-auto py-4 px-2">
                  <DataStream messages={activeChat.messages} busy={busy} />
               </div>
               <div className="pb-8 px-2 bg-gradient-to-t from-background via-background to-transparent">
                  <CommandInput onSubmit={handleSubmit} busy={busy} />
               </div>
             </div>
           )}
        </div>
      </main>
    </div>
  )
}