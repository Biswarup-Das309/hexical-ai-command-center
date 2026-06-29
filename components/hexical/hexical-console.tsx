'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Loader2, Terminal, ShieldAlert, Eye, Code, Crosshair, ChevronDown, Check, FolderGit2, Command, Activity, Sparkles, X } from 'lucide-react'
import { HexicalLogo } from '@/components/hexical/hexical-logo'
import { supabase } from '@/lib/supabase'
import { useGuestLimit } from '@/hooks/use-guest-limit'
import { inferRoute, type StreamMessage, type VerifyResponse } from '@/lib/hexical-types'
import { ChatSidebar } from '@/components/hexical/chat-sidebar'
import { DataStream } from '@/components/hexical/data-stream'
import { CommandInput } from '@/components/hexical/command-input'
import { UpgradeModal } from '@/components/hexical/upgrade-modal'

// Clerk hooks for authentication
import { useUser, useClerk } from '@clerk/nextjs'

// -----------------------------------------------------------------------------
// CONFIGURATIONS & CONSTANTS
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
    text: 'SYSTEM ONLINE. AWAITING TARGET ASSIGNMENT.', 
    ts: '00:00', 
    steps: [], 
    valid: true 
  }] 
}

const SECURITY_PROFILES = [
  { id: 'code-reviewer', name: 'Code Reviewer', description: 'Standard practices & optimization', icon: Code, color: 'text-blue-400' },
  { id: 'bug-hunter', name: 'Bug Hunter', description: 'Aggressive High/Critical exploit scanning', icon: Crosshair, color: 'text-rose-400' },
  { id: 'defense-in-depth', name: 'Defense in Depth', description: 'Architectural & logic flaw analysis', icon: ShieldAlert, color: 'text-emerald-400' }
]

const WORKSPACES = [
  { id: 'global', name: 'Global Environment' },
  { id: 'frontend', name: 'Frontend Repository' },
  { id: 'backend', name: 'Backend Services / API' }
]

const PROCESSING_PHASES = [
  "Initializing security sandbox...",
  "Parsing Abstract Syntax Trees (AST)...",
  "Tracing data flow & variable states...",
  "Cross-referencing CVE database...",
  "Simulating execution paths...",
  "Finalizing logic trace..."
]

function getContextualGreeting(): string {
  const h = new Date().getHours()
  if (h >= 5 && h < 12) return 'Good morning'
  if (h >= 12 && h < 17) return 'Good afternoon'
  if (h >= 17 && h < 22) return 'Good evening'
  return 'Working late'
}

function generateTimestamp(): string { return new Date().toLocaleTimeString('en-GB', { hour12: false }) }
function generateUniqueID(): string { return Math.random().toString(36).slice(2) + Date.now().toString(36) }

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------

export function HexicalConsole() {
  // Clerk hooks
  const { user, isLoaded } = useUser()
  const { signOut, openSignIn } = useClerk() 

  // Guest Limit Hook
  const { checkLimit, recordUsage, timeRemaining } = useGuestLimit()

  const [chats, setChats] = useState<any[]>([INITIAL_CHAT_STATE])
  const [activeId, setActiveId] = useState<string>('1')
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true)
  const [busy, setBusy] = useState<boolean>(false)
  const [loadingPhase, setLoadingPhase] = useState<string>(PROCESSING_PHASES[0])

  // Auth State
  const [userName, setUserName] = useState<string>(DEFAULT_GUEST_NAME)
  const [userEmail, setUserEmail] = useState<string>(DEFAULT_GUEST_EMAIL)
  const [userAvatar, setUserAvatar] = useState<string | null>(null)
  const [isAuthLoading, setIsAuthLoading] = useState<boolean>(true)
  const [isMounted, setIsMounted] = useState<boolean>(false)

  // Advanced UI State
  const [activeTraceMessage, setActiveTraceMessage] = useState<StreamMessage | null>(null)
  const [showTracePanel, setShowTracePanel] = useState<boolean>(false)
  const [activeProfileId, setActiveProfileId] = useState<string>(SECURITY_PROFILES[0].id)
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(WORKSPACES[0].id)
  const [showProfileMenu, setShowProfileMenu] = useState<boolean>(false)
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState<boolean>(false)
  const [showUpgradeModal, setShowUpgradeModal] = useState<boolean>(false)

  const abortControllerRef = useRef<AbortController | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const headerMenuRef = useRef<HTMLDivElement | null>(null)

  // ---------------------------------------------------------------------------
  // SIDEBAR HANDLERS (UPDATED FOR CLOUD SYNC)
  // ---------------------------------------------------------------------------

  const handleNewChat = useCallback(async () => {
    const newId = generateUniqueID()
    const newChat = { 
      id: newId, title: 'New Chat', pinned: false, 
      messages: [{ id: generateUniqueID(), role: 'hexical', text: 'SYSTEM ONLINE. AWAITING TARGET ASSIGNMENT.', ts: generateTimestamp(), steps: [], valid: true }] 
    }
    setChats(prev => [newChat, ...prev])
    setActiveId(newId)
    setActiveTraceMessage(null)

    // Cloud Sync
    if (user) {
      await supabase.from('chats').upsert({
        id: newChat.id, user_id: user.id, title: newChat.title, messages: newChat.messages, pinned: newChat.pinned, updated_at: new Date().toISOString()
      });
    }
  }, [user])

  const handleRename = useCallback(async (id: string, newTitle: string) => {
    setChats(prev => prev.map(c => c.id === id ? { ...c, title: newTitle } : c))
    
    // Cloud Sync
    if (user) {
      await supabase.from('chats').update({ title: newTitle, updated_at: new Date().toISOString() }).eq('id', id);
    }
  }, [user])

  const handleTogglePin = useCallback(async (id: string) => {
    let updatedPinState = false;
    setChats(prev => prev.map(c => {
      if (c.id === id) {
        updatedPinState = !c.pinned;
        return { ...c, pinned: updatedPinState };
      }
      return c;
    }))

    // Cloud Sync
    if (user) {
      await supabase.from('chats').update({ pinned: updatedPinState, updated_at: new Date().toISOString() }).eq('id', id);
    }
  }, [user])

  const handleDelete = useCallback(async (id: string) => {
    setChats(prev => {
      const filtered = prev.filter(c => c.id !== id)
      if (filtered.length === 0) {
        const newId = generateUniqueID()
        setActiveId(newId)
        
        const emptyChat = { id: newId, title: 'New Chat', pinned: false, messages: [] };
        if (user) {
          supabase.from('chats').upsert({ id: emptyChat.id, user_id: user.id, title: emptyChat.title, messages: emptyChat.messages, pinned: emptyChat.pinned, updated_at: new Date().toISOString() });
        }
        return [emptyChat]
      }
      if (activeId === id) setActiveId(filtered[0].id)
      return filtered
    })

    // Cloud Sync
    if (user) {
      await supabase.from('chats').delete().eq('id', id);
    }
  }, [activeId, user])

  // ---------------------------------------------------------------------------
  // LIFECYCLE, HOTKEYS & CLOUD SYNC
  // ---------------------------------------------------------------------------

  useEffect(() => {
    setIsMounted(true)
  }, [])

  // The Master Data Loader (Handles LocalStorage for Guests & Supabase for Users)
  useEffect(() => {
    if (!isMounted || !isLoaded) return;

    if (!user) {
      // GUEST MODE: Load from Local Storage
      const savedChats = localStorage.getItem('hexical_chats')
      if (savedChats) {
        try { 
          const parsed = JSON.parse(savedChats); 
          if (Array.isArray(parsed) && parsed.length > 0) {
            setChats(parsed)
            setActiveId(parsed[0].id)
          }
        } 
        catch (err) { console.error("Persistence Load Error:", err) }
      }
      return;
    }

    // AUTHENTICATED MODE: Fetch from Cloud and listen to Realtime updates
    const fetchCloudChats = async () => {
      const { data, error } = await supabase
        .from('chats')
        .select('*')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false });

      if (!error && data && data.length > 0) {
        const formatted = data.map(d => ({
          ...d,
          messages: typeof d.messages === 'string' ? JSON.parse(d.messages) : d.messages
        }));
        setChats(formatted);
        // Set active ID if we are on the default initialized chat to show their loaded history immediately
        setActiveId(prev => prev === '1' ? formatted[0].id : prev);
      }
    };

    fetchCloudChats();

    // Supabase Realtime Listener
    const channel = supabase.channel('realtime-sync')
      .on(
        'postgres_changes', 
        { event: '*', schema: 'public', table: 'chats', filter: `user_id=eq.${user.id}` }, 
        (payload) => {
          fetchCloudChats(); // Refresh local UI when another device updates the DB
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [isMounted, isLoaded, user]);

  // Clerk Authentication Sync
  useEffect(() => {
    if (isLoaded) {
      if (user) {
        const fullName = user.fullName || user.primaryEmailAddress?.emailAddress?.split('@')[0] || 'User'
        setUserName(fullName)
        setUserEmail(user.primaryEmailAddress?.emailAddress || 'no-email@hexical.ai')
        setUserAvatar(user.imageUrl || null)
      } else {
        setUserName(DEFAULT_GUEST_NAME)
        setUserEmail(DEFAULT_GUEST_EMAIL)
        setUserAvatar(null)
      }
      setIsAuthLoading(false)
    }
  }, [isLoaded, user])

  // Retain local storage backup just in case
  useEffect(() => { if (isMounted) localStorage.setItem('hexical_chats', JSON.stringify(chats)) }, [chats, isMounted])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    const hexMessages = activeChat.messages.filter((m: any) => m.role === 'hexical' && m.steps?.length > 0)
    if (hexMessages.length > 0) setActiveTraceMessage(hexMessages[hexMessages.length - 1])
  }, [chats, activeId, busy])

  // Agentic Status Cycling
  useEffect(() => {
    let interval: NodeJS.Timeout
    if (busy) {
      let step = 0;
      setLoadingPhase(PROCESSING_PHASES[0])
      interval = setInterval(() => {
        step = (step + 1) % PROCESSING_PHASES.length
        setLoadingPhase(PROCESSING_PHASES[step])
      }, 1500)
    }
    return () => clearInterval(interval)
  }, [busy])

  // Global Power-User Hotkeys
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault()
        setIsSidebarOpen(prev => !prev)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'i') {
        e.preventDefault()
        if (activeTraceMessage) setShowTracePanel(prev => !prev)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTraceMessage])

  // Close menus on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(event.target as Node)) {
        setShowProfileMenu(false)
        setShowWorkspaceMenu(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  const activeChat = chats.find(c => c.id === activeId) || chats[0]

  // ---------------------------------------------------------------------------
  // HANDLERS (UPDATED FOR CLOUD SYNC)
  // ---------------------------------------------------------------------------

  const handleSubmit = async (logic: string) => {
    if (busy || !logic.trim()) return

    // 1. GATEKEEPER: Check Guest Limit Before Firing API
    if (!checkLimit()) {
      const systemWarning: StreamMessage = { 
        id: generateUniqueID(), 
        role: 'hexical', 
        text: `**SYSTEM LOCKOUT:** Guest access limit reached. Please log in or upgrade to resume execution. Lockout lifts in: ${timeRemaining}`, 
        steps: ['GUEST_LIMIT_REACHED', 'AWAITING_AUTH'], 
        valid: false, 
        route: 'auth_required' as any,
        ts: generateTimestamp() 
      }
      setChats(prev => prev.map(c => c.id === activeId ? { ...c, messages: [...c.messages, { id: generateUniqueID(), role: 'user', text: logic, ts: generateTimestamp() }, systemWarning] } : c))
      openSignIn() 
      return
    }

    const userMsg: StreamMessage = { id: generateUniqueID(), role: 'user', text: logic, ts: generateTimestamp() }
    
    // Cloud Sync Prep
    const currentChatContext = chats.find(c => c.id === activeId) || chats[0];
    const updatedUserMessages = [...currentChatContext.messages, userMsg];

    setChats(prev => prev.map(c => c.id === activeId ? { ...c, messages: updatedUserMessages } : c))
    setBusy(true)

    // Sync User Message immediately
    if (user) {
      await supabase.from('chats').upsert({
        id: activeId, user_id: user.id, title: currentChatContext.title, pinned: currentChatContext.pinned,
        messages: updatedUserMessages, updated_at: new Date().toISOString()
      });
    }
    
    try {
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logic, profile: activeProfileId, workspace: activeWorkspaceId })
      })
      const data = await res.json()
      const hexMsg: StreamMessage = { 
        id: generateUniqueID(), role: 'hexical', text: data.analysis, 
        steps: data.steps, valid: data.valid, route: inferRoute(data.steps), ts: generateTimestamp() 
      }

      const updatedAIMessages = [...updatedUserMessages, hexMsg];
      
      setChats(prev => prev.map(c => c.id === activeId ? { ...c, messages: updatedAIMessages } : c))
      setActiveTraceMessage(hexMsg)
      
      // Sync AI Message instantly
      if (user) {
        await supabase.from('chats').upsert({
          id: activeId, user_id: user.id, title: currentChatContext.title, pinned: currentChatContext.pinned,
          messages: updatedAIMessages, updated_at: new Date().toISOString()
        });
      }
      
      // 2. REGISTRY: Record usage only after successful generation
      recordUsage()

    } catch (err) { console.error("API Error:", err) } 
    finally { setBusy(false) }
  }

  if (!isMounted) return null

  const activeProfile = SECURITY_PROFILES.find(p => p.id === activeProfileId) || SECURITY_PROFILES[0]
  const ProfileIcon = activeProfile.icon
  const activeWorkspace = WORKSPACES.find(w => w.id === activeWorkspaceId) || WORKSPACES[0]

  return (
    <>
      {/* UPGRADE MODAL RENDERING */}
      {showUpgradeModal && <UpgradeModal onClose={() => setShowUpgradeModal(false)} />}

      <div className="flex h-screen w-full bg-[#0a0a0c] text-foreground overflow-hidden font-mono selection:bg-cyan-500/30">
        
        {/* SIDEBAR */}
        {isSidebarOpen && (
          <div className="w-[280px] h-full border-r border-white/5 flex-shrink-0 z-40 bg-[#0a0a0c]">
             <ChatSidebar 
              chats={chats} 
              activeId={activeId} 
              isOpen={isSidebarOpen}
              userName={isAuthLoading ? "Initializing..." : userName}
              userEmail={isAuthLoading ? "Loading account..." : userEmail}
              avatarUrl={userAvatar}
              onToggleOpen={() => setIsSidebarOpen(false)}
              onSelect={setActiveId} 
              onNewChat={handleNewChat} 
              onDeleteChat={handleDelete} 
              onRenameChat={handleRename} 
              onTogglePin={handleTogglePin} 
              onSignOut={() => signOut(() => window.location.reload())}
            />
          </div>
        )}

        {/* MAIN WORKSPACE */}
        <main className="flex-1 flex flex-col relative bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-cyan-950/20 via-[#0a0a0c] to-[#0a0a0c] min-w-0">
          
          {/* PRO-TIER TOP NAVIGATION */}
          <div className="absolute top-4 left-4 z-[50] flex items-center gap-3" ref={headerMenuRef}>
            {!isSidebarOpen && (
              <button onClick={() => setIsSidebarOpen(true)} className="flex items-center gap-3 hover:bg-white/5 p-2 rounded-xl transition-all border border-white/0 hover:border-white/5" title="Toggle Sidebar (Cmd+B)">
                <HexicalLogo className="size-6 text-cyan-400" />
              </button>
            )}
            
            <div className="h-6 w-px bg-white/10 mx-1 hidden md:block"></div>

            {/* Workspace Target Selector */}
            <div className="relative">
              <button onClick={() => { setShowWorkspaceMenu(!showWorkspaceMenu); setShowProfileMenu(false); }} className="flex items-center gap-2 bg-white/[0.02] hover:bg-white/[0.06] border border-white/10 px-3 py-1.5 rounded-lg transition-all text-xs font-sans">
                <FolderGit2 className="size-3.5 text-muted-foreground" />
                <span className="font-medium text-foreground/80">{activeWorkspace.name}</span>
                <ChevronDown className="size-3 text-muted-foreground ml-1" />
              </button>
              {showWorkspaceMenu && (
                <div className="absolute top-full left-0 mt-2 w-56 bg-[#111116] border border-white/10 rounded-xl shadow-2xl overflow-hidden animate-fade-in">
                  <div className="p-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b border-white/5">Target Context</div>
                  <div className="p-1">
                    {WORKSPACES.map(ws => (
                      <button key={ws.id} onClick={() => { setActiveWorkspaceId(ws.id); setShowWorkspaceMenu(false); }} className={`w-full flex items-center gap-2 p-2 rounded-lg text-left text-xs transition-all ${activeWorkspaceId === ws.id ? 'bg-cyan-500/10 text-cyan-400' : 'hover:bg-white/5 text-foreground/70'}`}>
                        {ws.name}
                        {activeWorkspaceId === ws.id && <Check className="size-3 ml-auto" />}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Profile Selector */}
            <div className="relative">
              <button onClick={() => { setShowProfileMenu(!showProfileMenu); setShowWorkspaceMenu(false); }} className="flex items-center gap-2 bg-white/[0.02] hover:bg-white/[0.06] border border-white/10 px-3 py-1.5 rounded-lg transition-all text-xs font-sans">
                <ProfileIcon className={`size-3.5 ${activeProfile.color}`} />
                <span className="font-medium text-foreground/80">{activeProfile.name}</span>
                <ChevronDown className="size-3 text-muted-foreground ml-1" />
              </button>
              {showProfileMenu && (
                <div className="absolute top-full left-0 mt-2 w-64 bg-[#111116] border border-white/10 rounded-xl shadow-2xl overflow-hidden animate-fade-in">
                  <div className="p-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider border-b border-white/5">Agent Persona</div>
                  <div className="p-1">
                    {SECURITY_PROFILES.map(profile => (
                      <button key={profile.id} onClick={() => { setActiveProfileId(profile.id); setShowProfileMenu(false); }} className={`w-full flex items-start gap-3 p-2.5 rounded-lg text-left transition-all ${activeProfileId === profile.id ? 'bg-white/5' : 'hover:bg-white/5'}`}>
                        <profile.icon className={`size-4 mt-0.5 ${profile.color}`} />
                        <div className="flex-1">
                          <div className={`font-sans font-medium text-xs ${activeProfileId === profile.id ? 'text-white' : 'text-foreground/80'}`}>{profile.name}</div>
                          <div className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{profile.description}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* TOP RIGHT: UPGRADE BUTTON & TRACE TOGGLE */}
          <div className="absolute top-4 right-4 z-[50] flex items-center gap-3">
            <button 
              onClick={() => setShowUpgradeModal(true)} 
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-sans font-semibold transition-all shadow-lg bg-white/[0.02] border border-white/10 hover:bg-white/10 text-white backdrop-blur-md"
            >
              <Sparkles className="size-3.5 text-cyan-400" />
              Upgrade
            </button>

            {activeTraceMessage && activeTraceMessage.steps && activeTraceMessage.steps.length > 0 && (
              <button onClick={() => setShowTracePanel(!showTracePanel)} title="Inspect Logic (Cmd+I)" className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-sans border transition-all shadow-lg ${showTracePanel ? 'bg-cyan-500/20 border-cyan-500/50 text-cyan-200' : 'bg-white/5 border-white/10 hover:border-cyan-500/30 text-muted-foreground hover:text-foreground backdrop-blur-md'}`}>
                <Eye className="size-3.5" />
                <span className="hidden sm:inline">{showTracePanel ? 'Close Inspection' : 'Inspect Logic Trace'}</span>
                <kbd className="hidden md:inline-flex items-center gap-1 font-mono text-[9px] opacity-50 ml-2 border border-current rounded px-1"><Command className="size-2.5"/> I</kbd>
              </button>
            )}
          </div>

          {/* MESSAGES & INPUT AREA */}
          <div className="flex-1 flex flex-col items-center justify-center overflow-hidden w-full relative pt-16 pb-4 px-4">
              
              {activeChat.messages.length <= 1 ? (
                <div className="w-full text-center max-w-2xl mx-auto animate-rise">
                  <h2 className="text-2xl md:text-4xl font-sans mb-8 text-foreground tracking-tight">
                    {isAuthLoading ? (
                      <span className="flex items-center justify-center gap-3 text-muted-foreground text-xl"><Loader2 className="animate-spin size-6 text-cyan-500" /> Securing session...</span>
                    ) : (
                      <>{getContextualGreeting()}, <span className="bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent font-semibold drop-shadow-[0_0_15px_rgba(34,211,238,0.2)]">{userName}</span>.</>
                    )}
                  </h2>
                  
                  {/* Input Container */}
                  <div className="w-full rounded-2xl border border-cyan-500/20 p-2 backdrop-blur-2xl bg-black/40 shadow-2xl shadow-cyan-950/20 focus-within:border-cyan-500/50 transition-all duration-300">
                      <CommandInput onSubmit={handleSubmit} busy={busy} onStop={() => abortControllerRef.current?.abort()} />
                  </div>
                  
                  {/* Quick Action Hints */}
                  <div className="mt-6 flex flex-wrap justify-center gap-3 opacity-60">
                    <span className="text-xs text-muted-foreground flex items-center gap-1.5"><kbd className="font-mono bg-white/5 border border-white/10 rounded px-1.5 py-0.5">Cmd</kbd> + <kbd className="font-mono bg-white/5 border border-white/10 rounded px-1.5 py-0.5">B</kbd> Sidebar</span>
                    <span className="text-xs text-muted-foreground flex items-center gap-1.5"><kbd className="font-mono bg-white/5 border border-white/10 rounded px-1.5 py-0.5">Cmd</kbd> + <kbd className="font-mono bg-white/5 border border-white/10 rounded px-1.5 py-0.5">I</kbd> Logic Trace</span>
                  </div>
                </div>
              ) : (
                <div className="w-full max-w-3xl flex flex-col h-full overflow-hidden">
                  <div className="flex-1 overflow-y-auto px-2 md:px-6 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
                    <DataStream messages={activeChat.messages} busy={busy} />
                    <div ref={messagesEndRef} className="h-6" />
                  </div>
                  
                  {/* Agentic Processing Indicator */}
                  <div className={`transition-all duration-300 overflow-hidden flex justify-center ${busy ? 'h-8 opacity-100 mb-2' : 'h-0 opacity-0 mb-0'}`}>
                     <div className="flex items-center gap-2 text-xs font-mono text-cyan-400/80 bg-cyan-950/30 px-4 py-1.5 rounded-full border border-cyan-500/20 backdrop-blur-md">
                       <Activity className="size-3 animate-pulse" />
                       {loadingPhase}
                     </div>
                  </div>

                  <div className="shrink-0 bg-gradient-to-t from-[#0a0a0c] via-[#0a0a0c]/90 to-transparent pt-2">
                      <div className="rounded-3xl border border-white/10 bg-black/40 backdrop-blur-2xl focus-within:border-cyan-500/50 focus-within:bg-black/60 transition-all shadow-lg">
                        <CommandInput onSubmit={handleSubmit} busy={busy} onStop={() => abortControllerRef.current?.abort()} />
                      </div>
                  </div>
                </div>
              )}
          </div>
        </main>

        {/* LOGIC TRACE SPLIT PANE */}
        {showTracePanel && activeTraceMessage && (
          <div className="w-[360px] md:w-[420px] h-full border-l border-white/5 bg-[#0a0a0c]/95 backdrop-blur-3xl flex flex-col overflow-hidden animate-fade-in flex-shrink-0 z-40 shadow-[-20px_0_50px_rgba(0,0,0,0.5)]">
            <div className="p-4 border-b border-white/10 flex items-center justify-between bg-black/40">
              <div className="flex items-center gap-2">
                <Terminal className="size-4 text-cyan-500" />
                <span className="text-xs uppercase font-bold tracking-widest text-foreground">Trace Inspector</span>
              </div>
              
              <button 
                onClick={() => setShowTracePanel(false)} 
                className="p-1 hover:bg-white/10 rounded-md text-muted-foreground hover:text-white transition-colors"
                title="Close Inspector"
              >
                <X size={16} />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs scrollbar-thin scrollbar-thumb-white/10">
              <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/5 shadow-inner">
                <span className="text-muted-foreground block mb-2 font-sans text-[10px] uppercase tracking-wider font-semibold">Inferred Execution Route</span>
                <span className="text-cyan-300 font-mono text-[11px] bg-cyan-950/40 border border-cyan-500/20 px-2 py-1 rounded-md">{activeTraceMessage.route || 'default_eval'}</span>
              </div>

              <div className="space-y-3">
                <span className="text-muted-foreground block font-sans text-[10px] uppercase tracking-wider font-semibold">Execution Pipeline Logs</span>
                {activeTraceMessage.steps && activeTraceMessage.steps.length > 0 ? (
                  <div className="space-y-2 relative before:absolute before:inset-0 before:ml-[11px] before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-white/10 before:to-transparent">
                    {activeTraceMessage.steps.map((step: string, index: number) => (
                      <div key={index} className="relative flex items-start gap-3 p-3 rounded-lg bg-black/50 border border-white/5 font-mono text-[11px] text-muted-foreground leading-relaxed break-words hover:border-cyan-500/30 transition-colors group">
                        <div className="absolute -left-1.5 top-3.5 size-3 bg-[#0a0a0c] border-2 border-cyan-500/50 rounded-full group-hover:border-cyan-400 group-hover:shadow-[0_0_8px_rgba(34,211,238,0.6)] transition-all z-10" />
                        <div className="ml-2 w-full">
                          <span className="text-cyan-500/70 block mb-1 font-sans text-[9px] uppercase font-bold tracking-widest">Step 0{index + 1}</span>
                          <span className="text-foreground/80">{step}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-muted-foreground italic p-3 text-center border border-dashed border-white/10 rounded-xl bg-white/[0.01]">No intermediary diagnostic chains reported.</div>
                )}
              </div>
            </div>
          </div>
        )}

      </div>
    </>
  )
}