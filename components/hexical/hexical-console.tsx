'use client'

import { useState, useEffect, useRef } from 'react'
import { PanelLeftClose, PanelLeftOpen, UserCircle2, MoreVertical, Settings, Trash2, Download, Moon, Sun, Square } from 'lucide-react'
import { HexicalLogo } from './hexical-logo'
import { supabase } from '@/lib/supabase'
import { useGuestLimit } from '@/hooks/use-guest-limit'
import { inferRoute, type StreamMessage, type VerifyResponse } from '@/lib/hexical-types'
import { ChatSidebar } from './chat-sidebar'
import { DataStream } from './data-stream'
import { CommandInput } from './command-input'

// -----------------------------------------------------------------------------
// Constants & Configuration
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

// -----------------------------------------------------------------------------
// Main Console Component
// -----------------------------------------------------------------------------

export function HexicalConsole() {
  
  // --- STATE MANAGEMENT ---
  const [chats, setChats] = useState<any[]>([INITIAL_CHAT])
  const [activeId, setActiveId] = useState('1')
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [userName, setUserName] = useState('Guest')
  const [isMounted, setIsMounted] = useState(false)
  const [theme, setTheme] = useState('dark')
  
  // --- REFS ---
  const menuRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null) // Used for stopping generations
  const { checkLimit } = useGuestLimit()

  // ---------------------------------------------------------------------------
  // EFFECT: Initialization & User Auth
  // ---------------------------------------------------------------------------

  useEffect(() => {
    setIsMounted(true)
    
    // Load persisted chat state
    const savedChats = localStorage.getItem('hexical_chats')
    if (savedChats) {
      try {
        setChats(JSON.parse(savedChats))
      } catch (err) {
        console.error("Failed to restore chats:", err)
      }
    }
    
    // Load theme preference
    const savedTheme = localStorage.getItem('hexical_theme')
    if (savedTheme === 'light') {
      setTheme('light')
      document.documentElement.classList.remove('dark')
    } else {
      setTheme('dark')
      document.documentElement.classList.add('dark')
    }
    
    // Resolve user identity
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) {
        const name = data.user.user_metadata.full_name?.split(' ')[0] || 'User'
        setUserName(name)
      }
    })
  }, [])

  // ---------------------------------------------------------------------------
  // EFFECT: State Persistence & Auto-Scroll
  // ---------------------------------------------------------------------------

  // Sync Chats to LocalStorage
  useEffect(() => {
    if (isMounted) {
      localStorage.setItem('hexical_chats', JSON.stringify(chats))
    }
  }, [chats, isMounted])

  // Scroll to bottom on updates
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chats, activeId])

  // Click-outside handler for global menu
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // ---------------------------------------------------------------------------
  // LOGIC: Global Actions
  // ---------------------------------------------------------------------------

  const toggleTheme = () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(newTheme)
    document.documentElement.classList.toggle('dark')
    localStorage.setItem('hexical_theme', newTheme)
    setIsMenuOpen(false)
  }

  const exportChat = () => {
    const chatToExport = chats.find(c => c.id === activeId) || chats[0]
    const chatData = JSON.stringify(chatToExport, null, 2)
    const blob = new Blob([chatData], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    
    const a = document.createElement('a')
    a.href = url
    a.download = `hexical-chat-${activeId}.json`
    a.click()
    
    URL.revokeObjectURL(url)
    setIsMenuOpen(false)
  }

  // --- STOP GENERATION ---
  const handleStopGeneration = () => {
    if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        setBusy(false);
    }
  }

  const handleNewChat = () => {
      const existingEmptyChat = chats.find(c => c.messages.length === 1 && c.title === 'New Chat');
      
      if (existingEmptyChat) {
          setActiveId(existingEmptyChat.id);
          if (window.innerWidth < 768) setIsSidebarOpen(false);
          return;
      }

      const newId = Date.now().toString();
      const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
      const ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
      
      const newChat = { 
          id: newId, 
          title: 'New Chat', 
          messages: [{ id: uid(), role: 'hexical', text: 'SYSTEM ONLINE.', ts: ts(), steps: [], valid: true }] 
      };

      setChats([newChat, ...chats]);
      setActiveId(newId);
      if (window.innerWidth < 768) setIsSidebarOpen(false);
  }

  const handleDeleteChat = (id: string) => {
    if (chats.length <= 1) {
       setChats([INITIAL_CHAT]);
       setActiveId('1');
    } else {
       const filtered = chats.filter(c => c.id !== id);
       setChats(filtered);
       if (activeId === id) setActiveId(filtered[0].id);
    }
  };

  // ---------------------------------------------------------------------------
  // LOGIC: Engine Transmission
  // ---------------------------------------------------------------------------

  async function handleSubmit(logic: string) {
    // Auth Check
    const isAuthenticated = (await supabase.auth.getSession()).data.session !== null
    if (!isAuthenticated && !checkLimit()) {
      localStorage.setItem('pending_draft', logic)
      window.location.href = '/login'
      return
    }
    
    // Validate Input
    if (busy || !logic.trim()) return
    
    const tsNow = () => new Date().toLocaleTimeString('en-GB', { hour12: false })
    const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36)
    const userMsg: StreamMessage = { id: uid(), role: 'user', text: logic, ts: tsNow() }
    
    // Create new abort controller for this specific request
    abortControllerRef.current = new AbortController();
    setBusy(true)
    
    try {
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logic }),
        signal: abortControllerRef.current.signal // Attach signal to fetch
      })
      
      const data: VerifyResponse = await res.json()
      
      const hexMsg: StreamMessage = { 
        id: uid(), 
        role: 'hexical', 
        text: data.analysis ?? '', 
        steps: data.steps ?? [], 
        valid: Boolean(data.valid), 
        route: inferRoute(data.steps ?? []), 
        ts: tsNow() 
      }
      
      setChats(prev => prev.map(chat => {
        if (chat.id === activeId) {
          const newTitle = chat.messages.length === 1 
            ? (logic.length > 22 ? logic.slice(0, 22) + '...' : logic) 
            : chat.title;
            
          return { ...chat, title: newTitle, messages: [...chat.messages, userMsg, hexMsg] }
        }
        return chat
      }))
    } catch (err: any) {
      if (err.name === 'AbortError') {
          console.log("Generation interrupted by user.");
      } else {
          setChats(prev => prev.map(c => 
            c.id === activeId 
              ? { ...c, messages: [...c.messages, userMsg, { id: uid(), role: 'error', text: 'MACHINE ERROR: Connection lost.', ts: tsNow(), steps: [], valid: false }] } 
              : c
          ))
      }
    } finally {
      setBusy(false)
      abortControllerRef.current = null;
    }
  }

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------

  if (!isMounted) return null
  const activeChat = chats.find(c => c.id === activeId) || chats[0]

  return (
    <div className="flex h-screen w-full bg-background text-foreground overflow-hidden">
      
      {/* Mobile Backdrop */}
      {isSidebarOpen && (
        <div 
          className="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm md:hidden" 
          onClick={() => setIsSidebarOpen(false)} 
        />
      )}
      
      {/* Sidebar Container */}
      <div className={`
        z-50 bg-card transition-all duration-300 ease-in-out flex flex-col h-full
        ${isSidebarOpen ? 'w-64 border-r border-border' : 'w-0 border-none'}
      `}>
         <div className="w-64 h-full">
            {isSidebarOpen && (
                <ChatSidebar 
                    chats={chats} 
                    activeId={activeId} 
                    onSelect={(id: string) => { setActiveId(id); if (window.innerWidth < 768) setIsSidebarOpen(false); }} 
                    onNewChat={handleNewChat} 
                    onDeleteChat={handleDeleteChat} 
                    onClose={() => setIsSidebarOpen(false)} 
                />
            )}
         </div>
      </div>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col relative transition-all duration-300 bg-gradient-to-b from-background to-background/80 min-w-0">
        
        {/* Header */}
        <div className="p-4 flex items-center justify-between z-10 sticky top-0">
            <div className="flex items-center gap-4">
                <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="p-2 hover:bg-muted/50 rounded-lg transition-colors group">
                    {isSidebarOpen ? <PanelLeftClose className="size-5 text-muted-foreground" /> : <PanelLeftOpen className="size-5 text-muted-foreground" />}
                </button>
                {!isSidebarOpen && <span className="font-mono text-sm uppercase tracking-widest font-bold text-foreground/90">Hexical</span>}
            </div>
            
            {/* Global Menu */}
            <div className="relative" ref={menuRef}>
                <button onClick={() => setIsMenuOpen(!isMenuOpen)} className="p-2 hover:bg-muted/50 rounded-lg transition-colors">
                    <MoreVertical className="size-5 text-muted-foreground" />
                </button>
                
                {isMenuOpen && (
                    <div className="absolute right-0 top-12 w-48 bg-card border border-border rounded-xl shadow-2xl p-2 z-[100] animate-in fade-in zoom-in-95 duration-100">
                        <button onClick={exportChat} className="flex w-full items-center gap-2 px-3 py-2 text-[11px] font-mono hover:bg-muted rounded">
                            <Download className="size-3" /> Export Chat
                        </button>
                        <button onClick={toggleTheme} className="flex w-full items-center gap-2 px-3 py-2 text-[11px] font-mono hover:bg-muted rounded">
                            {theme === 'dark' ? <Sun className="size-3" /> : <Moon className="size-3" />} Toggle Theme
                        </button>
                        <button onClick={() => alert('Settings menu coming soon')} className="flex w-full items-center gap-2 px-3 py-2 text-[11px] font-mono hover:bg-muted rounded">
                            <Settings className="size-3" /> Settings
                        </button>
                        <div className="h-px bg-border my-1" />
                        <button 
                            onClick={() => { setChats([INITIAL_CHAT]); setActiveId('1'); setIsMenuOpen(false); localStorage.removeItem('hexical_chats'); }} 
                            className="flex w-full items-center gap-2 px-3 py-2 text-[11px] font-mono text-red-500 hover:bg-red-500/10 rounded"
                        >
                            <Trash2 className="size-3" /> Clear All Sessions
                        </button>
                    </div>
                )}
            </div>
        </div>

        {/* Chat Interface */}
        <div className="flex-1 flex flex-col items-center justify-center overflow-hidden w-full relative p-4">
           {activeChat.messages.length <= 1 ? (
             <div className="w-full text-center max-w-lg mx-auto">
               <h2 className="text-2xl md:text-4xl font-semibold mb-3 text-foreground tracking-tight">
                   {getGreeting()}, {userName}.
               </h2>
               <div className="w-full shadow-2xl rounded-2xl border border-muted/20 bg-background/50">
                   {/* Pass onStop prop */}
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