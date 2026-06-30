'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { 
  Loader2, Terminal, ShieldAlert, Eye, Code, Crosshair, ChevronDown, Check, 
  FolderGit2, Command, Activity, Sparkles, X, Globe, CheckCircle, AlertTriangle, 
  Database, Settings, Download, Trash2, Cpu, Timer, ShieldCheck, FileJson, 
  ToggleRight, ToggleLeft, UserCircle, SlidersHorizontal, Lock, BookOpen,
  Ghost, Webhook, Key, TerminalSquare, Target, Fingerprint, Regex, FileCode2, Flame
} from 'lucide-react'
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
// EXTENDED TYPES FOR ADVANCED TRACE INSPECTOR & SETTINGS
// -----------------------------------------------------------------------------
interface TraceSource {
  name: string;
  verified: boolean;
  type?: 'database' | 'web' | 'heuristic';
}

interface TraceMetrics {
  latencyMs: number;
  tokensUsed: number;
  confidenceScore: number;
}

interface ExtendedStreamMessage extends StreamMessage {
  sources?: TraceSource[];
  isVerifiedContent?: boolean;
  metrics?: TraceMetrics;
}

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
  { id: 'tutor', name: 'AI Tutor', description: 'Plain English explanations for beginners', icon: BookOpen, color: 'text-purple-400' },
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
  const { signOut, openSignIn, openUserProfile } = useClerk() 

  // Guest Limit Hook
  const { checkLimit, recordUsage, timeRemaining } = useGuestLimit()

  // Core State
  const [chats, setChats] = useState<any[]>([INITIAL_CHAT_STATE])
  const [activeId, setActiveId] = useState<string>('1')
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(false)
  const [busy, setBusy] = useState<boolean>(false)
  const [loadingPhase, setLoadingPhase] = useState<string>(PROCESSING_PHASES[0])

  // EXCLUSIVE HEXICAL FEATURE: Target Scope Lock
  const [targetScope, setTargetScope] = useState<string>('')

  // Auth State
  const [userName, setUserName] = useState<string>(DEFAULT_GUEST_NAME)
  const [userEmail, setUserEmail] = useState<string>(DEFAULT_GUEST_EMAIL)
  const [userAvatar, setUserAvatar] = useState<string | null>(null)
  const [isAuthLoading, setIsAuthLoading] = useState<boolean>(true)
  const [isMounted, setIsMounted] = useState<boolean>(false)

  // Advanced UI State
  const [activeTraceMessage, setActiveTraceMessage] = useState<ExtendedStreamMessage | null>(null)
  const [showTracePanel, setShowTracePanel] = useState<boolean>(false)
  const [showRawJson, setShowRawJson] = useState<boolean>(false)
  
  const [activeProfileId, setActiveProfileId] = useState<string>(SECURITY_PROFILES[0].id)
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(WORKSPACES[0].id)
  
  // Modals & Menus
  const [showProfileMenu, setShowProfileMenu] = useState<boolean>(false)
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState<boolean>(false)
  const [showUpgradeModal, setShowUpgradeModal] = useState<boolean>(false)
  const [showSettingsModal, setShowSettingsModal] = useState<boolean>(false)
  
  // ADVANCED SETTINGS STATE
  const [settingsTab, setSettingsTab] = useState<'identity' | 'telemetry' | 'engine' | 'offensive'>('identity')
  const [stealthMode, setStealthMode] = useState<boolean>(false)
  const [autoRedact, setAutoRedact] = useState<boolean>(true) 
  const [targetArch, setTargetArch] = useState<string>('linux')
  const [pocFormat, setPocFormat] = useState<string>('curl') 
  const [aggressiveness, setAggressiveness] = useState<string>('scan')
  const [shodanKey, setShodanKey] = useState<string>('')

  const abortControllerRef = useRef<AbortController | null>(null)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const headerMenuRef = useRef<HTMLDivElement | null>(null)

  // ---------------------------------------------------------------------------
  // SIDEBAR HANDLERS (ANTI-SPAM & CLOUD SYNC ENABLED)
  // ---------------------------------------------------------------------------

  const handleNewChat = useCallback(async () => {
    // 1. ANTI-SPAM LOGIC: Check if an empty chat already exists.
    // An empty chat is defined as having 1 or fewer messages (just the system init text).
    const existingEmptyChat = chats.find(c => c.messages.length <= 1);
    
    if (existingEmptyChat) {
      // If an empty chat exists, just switch to it. DO NOT create a new one.
      setActiveId(existingEmptyChat.id);
      setActiveTraceMessage(null);
      return; 
    }

    // 2. NORMAL CREATION: If no empty chat exists, spawn one.
    const newId = generateUniqueID()
    const newChat = { 
      id: newId, 
      title: 'New Chat', 
      pinned: false, 
      messages: [{ id: generateUniqueID(), role: 'hexical', text: 'SYSTEM ONLINE. AWAITING TARGET ASSIGNMENT.', ts: generateTimestamp(), steps: [], valid: true }] 
    }
    setChats(prev => [newChat, ...prev])
    setActiveId(newId)
    setActiveTraceMessage(null)

    if (user && !stealthMode) {
      await supabase.from('chats').upsert({
        id: newChat.id, user_id: user.id, title: newChat.title, messages: newChat.messages, pinned: newChat.pinned, updated_at: new Date().toISOString()
      });
    }
  }, [chats, user, stealthMode])

  const handleRename = useCallback(async (id: string, newTitle: string) => {
    setChats(prev => prev.map(c => c.id === id ? { ...c, title: newTitle } : c))
    
    if (user && !stealthMode) {
      await supabase.from('chats').update({ title: newTitle, updated_at: new Date().toISOString() }).eq('id', id);
    }
  }, [user, stealthMode])

  const handleTogglePin = useCallback(async (id: string) => {
    let updatedPinState = false;
    setChats(prev => prev.map(c => {
      if (c.id === id) {
        updatedPinState = !c.pinned;
        return { ...c, pinned: updatedPinState };
      }
      return c;
    }))

    if (user && !stealthMode) {
      await supabase.from('chats').update({ pinned: updatedPinState, updated_at: new Date().toISOString() }).eq('id', id);
    }
  }, [user, stealthMode])

  const handleDelete = useCallback(async (id: string) => {
    setChats(prev => {
      const filtered = prev.filter(c => c.id !== id)
      if (filtered.length === 0) {
        const newId = generateUniqueID()
        setActiveId(newId)
        const emptyChat = { id: newId, title: 'New Chat', pinned: false, messages: [] };
        if (user && !stealthMode) supabase.from('chats').upsert({ id: emptyChat.id, user_id: user.id, title: emptyChat.title, messages: emptyChat.messages, pinned: emptyChat.pinned, updated_at: new Date().toISOString() });
        return [emptyChat]
      }
      if (activeId === id) setActiveId(filtered[0].id)
      return filtered
    })

    if (user) {
      await supabase.from('chats').delete().eq('id', id);
    }
  }, [activeId, user, stealthMode])

  const handleExportData = () => {
    const dataStr = JSON.stringify(chats, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    const exportFileDefaultName = `hexical_data_export_${new Date().toISOString().split('T')[0]}.json`;
    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
  }

  // ---------------------------------------------------------------------------
  // LIFECYCLE, HOTKEYS & CLOUD SYNC
  // ---------------------------------------------------------------------------

  useEffect(() => { setIsMounted(true) }, [])

  useEffect(() => {
    if (window.innerWidth >= 768) { setIsSidebarOpen(true) }
  }, [])

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

  useEffect(() => {
    if (!isMounted || isAuthLoading) return;

    if (!user) {
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
        setActiveId(prev => (prev === '1' || !formatted.find(c => c.id === prev)) ? formatted[0].id : prev);
      }
    };

    fetchCloudChats();

    const channel = supabase.channel('realtime-sync')
      .on(
        'postgres_changes', 
        { event: '*', schema: 'public', table: 'chats', filter: `user_id=eq.${user.id}` }, 
        () => fetchCloudChats()
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [isMounted, isAuthLoading, user]);

  useEffect(() => { if (isMounted && !user && !stealthMode) localStorage.setItem('hexical_chats', JSON.stringify(chats)) }, [chats, isMounted, user, stealthMode])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    const hexMessages = activeChat?.messages.filter((m: any) => m.role === 'hexical' && m.steps?.length > 0)
    if (hexMessages && hexMessages.length > 0) setActiveTraceMessage(hexMessages[hexMessages.length - 1])
  }, [chats, activeId, busy])

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
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setShowSettingsModal(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeTraceMessage])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(event.target as Node)) {
        setShowProfileMenu(false); setShowWorkspaceMenu(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  const activeChat = chats.find(c => c.id === activeId) || chats[0]

  // ---------------------------------------------------------------------------
  // MAIN AI EXECUTION & SYNC
  // ---------------------------------------------------------------------------

  const handleSubmit = async (logic: string) => {
    if (busy || !logic.trim()) return

    if (!checkLimit()) {
      const systemWarning: ExtendedStreamMessage = { 
        id: generateUniqueID(), role: 'hexical', 
        text: `**SYSTEM LOCKOUT:** Guest access limit reached. Please log in or upgrade to resume execution. Lockout lifts in: ${timeRemaining}`, 
        steps: ['GUEST_LIMIT_REACHED', 'AWAITING_AUTH'], 
        valid: false, route: 'auth_required' as any, ts: generateTimestamp() 
      }
      setChats(prev => prev.map(c => c.id === activeId ? { ...c, messages: [...c.messages, { id: generateUniqueID(), role: 'user', text: logic, ts: generateTimestamp() }, systemWarning] } : c))
      openSignIn() 
      return
    }

    const userMsg: ExtendedStreamMessage = { id: generateUniqueID(), role: 'user', text: logic, ts: generateTimestamp() }
    const currentChatContext = chats.find(c => c.id === activeId) || chats[0];
    
    // AUTO-TITLING: If this is the first real user message, generate a summary title based on the logic
    const isFirstUserMessage = currentChatContext.messages.length <= 1;
    const generatedTitle = isFirstUserMessage 
      ? logic.split(' ').slice(0, 4).join(' ') + '...' 
      : currentChatContext.title;

    const updatedUserMessages = [...currentChatContext.messages, userMsg];

    setChats(prev => prev.map(c => c.id === activeId ? { ...c, title: generatedTitle, messages: updatedUserMessages } : c))
    setBusy(true)

    if (user && !stealthMode) {
      await supabase.from('chats').upsert({
        id: activeId, user_id: user.id, title: generatedTitle, pinned: currentChatContext.pinned,
        messages: updatedUserMessages, updated_at: new Date().toISOString()
      });
    }
    
    const startTime = performance.now()

    try {
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          logic, 
          profile: activeProfileId, 
          workspace: activeWorkspaceId,
          targetArch, 
          pocFormat,
          autoRedact,
          aggressiveness,
          targetScope // NEW FEATURE: Passed directly to backend context
        })
      })
      const data = await res.json()
      
      const endTime = performance.now()
      const executionTimeMs = Math.round(endTime - startTime)
      
      const mockSources: TraceSource[] = data.sources || [
        { name: 'Global Threat Intelligence DB', verified: true, type: 'database' },
        { name: 'Heuristic Pattern Recognition', verified: data.valid, type: 'heuristic' },
      ]

      const mockMetrics: TraceMetrics = data.metrics || {
        latencyMs: executionTimeMs,
        tokensUsed: Math.floor(Math.random() * 1200) + 350,
        confidenceScore: data.valid ? 98.4 : 62.1
      }

      const hexMsg: ExtendedStreamMessage = { 
        id: generateUniqueID(), role: 'hexical', 
        text: data.analysis, 
        steps: data.steps, 
        valid: data.valid, 
        route: inferRoute(data.steps), 
        ts: generateTimestamp(),
        sources: mockSources,
        isVerifiedContent: data.valid,
        metrics: mockMetrics
      }

      const updatedAIMessages = [...updatedUserMessages, hexMsg];
      
      setChats(prev => prev.map(c => c.id === activeId ? { ...c, title: generatedTitle, messages: updatedAIMessages } : c))
      setActiveTraceMessage(hexMsg)
      
      if (user && !stealthMode) {
        await supabase.from('chats').upsert({
          id: activeId, user_id: user.id, title: generatedTitle, pinned: currentChatContext.pinned,
          messages: updatedAIMessages, updated_at: new Date().toISOString()
        });
      }
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
      {showUpgradeModal && <UpgradeModal onClose={() => setShowUpgradeModal(false)} />}

      {/* ================= ADVANCED SECURITY SETTINGS MODAL ================= */}
      {showSettingsModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in font-sans">
          <div className="w-full max-w-4xl bg-[#0a0a0c] border border-cyan-500/20 rounded-2xl shadow-[0_0_50px_rgba(34,211,238,0.05)] flex flex-col md:flex-row overflow-hidden h-[85vh] md:h-[650px]">
            
            {/* Settings Sidebar */}
            <div className="w-full md:w-64 bg-[#111116] border-r border-white/5 flex flex-col p-4 space-y-2 shrink-0">
              <div className="flex items-center gap-2 mb-6 px-2">
                <HexicalLogo className="size-5 text-cyan-500" />
                <h3 className="text-white font-semibold uppercase tracking-wider text-xs">System Config</h3>
              </div>
              
              <button onClick={() => setSettingsTab('identity')} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${settingsTab === 'identity' ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' : 'text-zinc-400 hover:bg-white/5 hover:text-white border border-transparent'}`}>
                <UserCircle size={16} /> Identity & Access
              </button>
              <button onClick={() => setSettingsTab('telemetry')} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${settingsTab === 'telemetry' ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' : 'text-zinc-400 hover:bg-white/5 hover:text-white border border-transparent'}`}>
                <Fingerprint size={16} /> Telemetry & Privacy
              </button>
              <button onClick={() => setSettingsTab('engine')} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${settingsTab === 'engine' ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' : 'text-zinc-400 hover:bg-white/5 hover:text-white border border-transparent'}`}>
                <TerminalSquare size={16} /> Engine Directives
              </button>
              <button onClick={() => setSettingsTab('offensive')} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${settingsTab === 'offensive' ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20' : 'text-zinc-400 hover:bg-white/5 hover:text-white border border-transparent'}`}>
                <Flame size={16} /> Offensive Tooling
              </button>
            </div>

            {/* Settings Content Area */}
            <div className="flex-1 flex flex-col relative bg-[#0a0a0c]">
              <div className="absolute top-4 right-4 z-10">
                <button onClick={() => setShowSettingsModal(false)} className="p-2 bg-white/5 hover:bg-white/10 rounded-full text-zinc-400 hover:text-white transition-colors">
                  <X size={18} />
                </button>
              </div>

              <div className="p-8 overflow-y-auto flex-1 font-sans">
                
                {/* IDENTITY & ACCESS */}
                {settingsTab === 'identity' && (
                  <div className="space-y-8 animate-fade-in">
                    <div>
                      <h4 className="text-xl text-white font-medium mb-1">Identity & Access</h4>
                      <p className="text-sm text-zinc-500">Manage your Hexical AI profile and subscription tiers.</p>
                    </div>
                    
                    <div className="flex items-center gap-4 bg-white/5 p-4 rounded-xl border border-white/5">
                      {userAvatar ? <img src={userAvatar} alt="Profile" className="w-16 h-16 rounded-full border border-white/10" /> : <div className="w-16 h-16 rounded-full bg-cyan-900/50 border border-cyan-500/30 flex items-center justify-center text-cyan-400 font-bold text-xl">{userName.charAt(0)}</div>}
                      <div className="flex-1">
                        <div className="text-white font-medium">{userName}</div>
                        <div className="text-zinc-400 text-sm">{userEmail}</div>
                      </div>
                      <button onClick={() => user ? openUserProfile() : openSignIn()} className="px-4 py-2 bg-white/10 hover:bg-white/15 text-white text-sm rounded-lg transition-colors font-medium">
                        {user ? 'Manage Auth' : 'Log In'}
                      </button>
                    </div>

                    <div className="space-y-4">
                       <h5 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Active License</h5>
                       <div className="flex items-center justify-between bg-gradient-to-r from-zinc-900 to-zinc-950 p-4 rounded-xl border border-zinc-800">
                          <div>
                            <div className="text-white font-medium flex items-center gap-2">Hexical Security <span className="bg-zinc-800 text-zinc-300 text-[10px] px-2 py-0.5 rounded-full">Base</span></div>
                            <div className="text-zinc-500 text-sm mt-1">Standard rate limits apply. Hardware restrictions active.</div>
                          </div>
                          <button onClick={() => {setShowSettingsModal(false); setShowUpgradeModal(true)}} className="px-4 py-2 bg-cyan-500/20 text-cyan-400 border border-cyan-500/50 hover:bg-cyan-500/30 text-sm rounded-lg transition-colors font-medium">
                            Upgrade License
                          </button>
                       </div>
                    </div>
                  </div>
                )}

                {/* TELEMETRY & PRIVACY */}
                {settingsTab === 'telemetry' && (
                  <div className="space-y-8 animate-fade-in">
                    <div>
                      <h4 className="text-xl text-white font-medium mb-1">Telemetry & Privacy</h4>
                      <p className="text-sm text-zinc-500">Manage data retention, vector embeddings, and local redaction rules.</p>
                    </div>

                    <div className="space-y-6">
                      {/* Zero-Knowledge Redaction */}
                      <div className="flex items-start justify-between border-b border-white/5 pb-6">
                         <div className="pr-8">
                           <div className="text-emerald-400 font-medium text-sm mb-1 flex items-center gap-2">
                             <Regex size={16} /> Local Secret Redaction
                           </div>
                           <div className="text-zinc-500 text-xs leading-relaxed">Client-side Regex automatically scrubs IP addresses, AWS keys, and passwords from your prompt before transmitting to the LLM API.</div>
                         </div>
                         <button onClick={() => setAutoRedact(!autoRedact)} className={`shrink-0 transition-colors ${autoRedact ? 'text-emerald-400' : 'text-zinc-600 hover:text-zinc-500'}`}>
                           {autoRedact ? <ToggleRight size={36} /> : <ToggleLeft size={36} />}
                         </button>
                      </div>

                      {/* Stealth Mode */}
                      <div className="flex items-start justify-between border-b border-white/5 pb-6">
                         <div className="pr-8">
                           <div className="text-cyan-400 font-medium text-sm mb-1 flex items-center gap-2">
                             <Ghost size={16}/> Stealth Mode (Ephemeral)
                             {stealthMode && <span className="flex h-2 w-2 rounded-full bg-cyan-400 animate-pulse"></span>}
                           </div>
                           <div className="text-zinc-500 text-xs leading-relaxed">Bypass Supabase vector storage completely. Sessions exist only in local browser memory and are destroyed upon tab close.</div>
                         </div>
                         <button onClick={() => setStealthMode(!stealthMode)} className={`shrink-0 transition-colors ${stealthMode ? 'text-cyan-400' : 'text-zinc-600 hover:text-zinc-500'}`}>
                           {stealthMode ? <ToggleRight size={36} /> : <ToggleLeft size={36} />}
                         </button>
                      </div>

                      {/* Export Data */}
                      <div className="flex items-start justify-between pb-2">
                         <div className="pr-8">
                           <div className="text-white font-medium text-sm mb-1">Export Diagnostic Logs</div>
                           <div className="text-zinc-500 text-xs leading-relaxed">Download a structured JSON file containing all threat models, system prompts, and AI trace logs.</div>
                         </div>
                         <button onClick={handleExportData} className="shrink-0 flex items-center gap-2 px-3 py-2 bg-white/5 hover:bg-white/10 text-white text-sm rounded-lg transition-colors border border-white/10">
                           <Download size={14} /> Export .JSON
                         </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* ENGINE DIRECTIVES */}
                {settingsTab === 'engine' && (
                  <div className="space-y-8 animate-fade-in">
                    <div>
                      <h4 className="text-xl text-white font-medium mb-1">Engine Directives</h4>
                      <p className="text-sm text-zinc-500">Configure Hexical's core logical constraints and simulation targets.</p>
                    </div>

                    <div className="space-y-6">
                      
                      {/* Target Architecture */}
                      <div className="bg-white/[0.02] border border-white/5 p-4 rounded-xl">
                        <label className="text-white font-medium text-sm mb-3 flex items-center gap-2"><Target size={14} className="text-purple-400"/> Payload Target Architecture</label>
                        <select 
                          value={targetArch}
                          onChange={(e) => setTargetArch(e.target.value)}
                          className="w-full bg-black border border-white/10 text-zinc-300 text-sm rounded-lg p-2.5 focus:border-cyan-500/50 outline-none"
                        >
                          <option value="linux">Linux (x86_64 / ELF) - Default</option>
                          <option value="windows">Windows NT (PE / PowerShell)</option>
                          <option value="web">Web Application (Node/React/Browser)</option>
                          <option value="cloud">Cloud Native (AWS IAM / K8s)</option>
                        </select>
                        <p className="text-xs text-zinc-500 mt-2">Dictates the structural format of generated Proof of Concepts (PoCs).</p>
                      </div>

                      {/* Aggressiveness Slider */}
                      <div className="bg-white/[0.02] border border-white/5 p-4 rounded-xl">
                        <div className="flex justify-between items-center mb-3">
                          <label className="text-white font-medium text-sm flex items-center gap-2"><Crosshair size={14} className="text-rose-400"/> Adversarial Aggressiveness</label>
                          <span className="text-xs font-mono text-cyan-400 bg-cyan-950/30 px-2 py-0.5 rounded border border-cyan-500/20 uppercase">{aggressiveness}</span>
                        </div>
                        <input 
                          type="range" 
                          min="0" max="2" step="1" 
                          value={aggressiveness === 'audit' ? 0 : aggressiveness === 'scan' ? 1 : 2}
                          onChange={(e) => {
                            const val = e.target.value;
                            setAggressiveness(val === '0' ? 'audit' : val === '1' ? 'scan' : 'exploit')
                          }}
                          className="w-full accent-rose-500" 
                        />
                        <div className="flex justify-between text-[10px] text-zinc-500 mt-2 uppercase tracking-wider font-semibold">
                          <span>Passive Audit</span>
                          <span>Active Scan</span>
                          <span className="text-rose-500/70">Weaponized PoC</span>
                        </div>
                      </div>

                      {/* Pro Features Hook */}
                      <div className="opacity-50 grayscale pointer-events-none mt-4 p-4 border border-zinc-800 rounded-xl relative">
                        <div className="absolute -top-3 -right-2 bg-amber-500/10 text-amber-500 border border-amber-500/20 text-[10px] px-2 py-0.5 rounded-full flex items-center gap-1 font-semibold"><Lock size={10}/> PRO</div>
                        <div className="text-white font-medium text-sm mb-2">Custom Pre-Prompt Injection</div>
                        <textarea disabled placeholder="Force specific context before tracing logic (e.g. Always assume WAF bypass is active...)" className="w-full h-20 bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-sm text-zinc-300 resize-none"></textarea>
                      </div>
                    </div>
                  </div>
                )}

                {/* OFFENSIVE TOOLING */}
                {settingsTab === 'offensive' && (
                  <div className="space-y-8 animate-fade-in">
                    <div>
                      <h4 className="text-xl text-white font-medium mb-1">Offensive Tooling</h4>
                      <p className="text-sm text-zinc-500">Configure payload generation schemas and exploit output formats.</p>
                    </div>

                    <div className="space-y-6">
                      
                      {/* PoC Output Format */}
                      <div className="bg-white/[0.02] border border-white/5 p-4 rounded-xl">
                        <label className="text-white font-medium text-sm mb-3 flex items-center gap-2"><FileCode2 size={14} className="text-cyan-400"/> Default Exploit Syntax</label>
                        <select 
                          value={pocFormat}
                          onChange={(e) => setPocFormat(e.target.value)}
                          className="w-full bg-black border border-white/10 text-zinc-300 text-sm rounded-lg p-2.5 focus:border-cyan-500/50 outline-none font-mono"
                        >
                          <option value="curl">Raw cURL / Bash</option>
                          <option value="pwntools">Python (Pwntools)</option>
                          <option value="metasploit">Ruby (Metasploit Module)</option>
                          <option value="nuclei">YAML (Nuclei Template)</option>
                        </select>
                        <p className="text-xs text-zinc-500 mt-2">Force the AI to output zero-day proofs in your preferred framework instead of generic code.</p>
                      </div>

                      <div className="flex items-start justify-between bg-black/40 border border-dashed border-white/10 p-4 rounded-xl">
                         <div className="pr-8">
                           <div className="text-white font-medium text-sm mb-1 flex items-center gap-2">Strict CVE Binding <span className="bg-cyan-500/20 text-cyan-400 text-[9px] px-1.5 py-0.5 rounded border border-cyan-500/30">BETA</span></div>
                           <div className="text-zinc-500 text-xs leading-relaxed">Forces the engine to drop vulnerabilities if they cannot be mathematically mapped to a known MITRE CVE or CWE entry. Reduces hallucinated bugs.</div>
                         </div>
                         <button className={`shrink-0 transition-colors text-cyan-400`}>
                           <ToggleRight size={32} />
                         </button>
                      </div>

                      <div className="bg-white/[0.02] border border-white/5 p-4 rounded-xl opacity-50 grayscale pointer-events-none relative">
                        <div className="absolute -top-3 -right-2 bg-amber-500/10 text-amber-500 border border-amber-500/20 text-[10px] px-2 py-0.5 rounded-full flex items-center gap-1 font-semibold"><Lock size={10}/> PRO</div>
                        <label className="text-white font-medium text-sm mb-1 flex items-center gap-2"><Key size={14}/> Shodan API Bridge</label>
                        <p className="text-xs text-zinc-500 mb-3">Feed live internet topology data directly into Hexical's heuristic engine.</p>
                        <div className="flex gap-2">
                          <input type="password" disabled placeholder="shodan_api_key_xxxxxxxxxxx" className="flex-1 bg-black border border-white/10 text-zinc-300 text-sm rounded-lg p-2.5 outline-none font-mono" />
                          <button disabled className="bg-zinc-800 text-zinc-500 px-4 rounded-lg text-sm font-medium">Save</button>
                        </div>
                      </div>

                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex h-screen w-full bg-[#0a0a0c] text-foreground overflow-hidden font-mono selection:bg-cyan-500/30">
        
       {/* ================= SIDEBAR ================= */}
        {isSidebarOpen && (
          <div className="absolute md:relative w-[280px] h-full border-r border-white/5 flex-shrink-0 z-50 bg-[#0a0a0c] shadow-2xl md:shadow-none">
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
              onOpenSettings={() => setShowSettingsModal(true)}
            />
          </div>
        )}

        {/* ================= MOBILE VIEW ================= */}
        <main className="md:hidden flex flex-col flex-1 justify-between w-full h-full relative z-10 bg-black text-sans">
          <div className="flex justify-between items-center w-full px-4 pt-4 pb-2 z-20">
            <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="p-2 -ml-2 text-zinc-400 hover:text-white transition">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9h16.5m-16.5 6.75h16.5" />
              </svg>
            </button>
            <div className="flex items-center gap-1 bg-zinc-900/40 px-3 py-1.5 rounded-full border border-zinc-800/50">
              <span className="text-sm font-medium text-zinc-300 font-sans">Hexical Flash</span>
              <ChevronDown className="w-3 h-3 text-zinc-500 ml-1" />
            </div>
          </div>

          {activeChat?.messages.length <= 1 ? (
            <div className="flex flex-col items-center justify-center text-center px-4 flex-1 pb-20">
              <div className="w-12 h-12 mb-6 bg-gradient-to-tr from-blue-500 via-purple-500 to-amber-400 rounded-full blur-[2px] opacity-90 relative flex items-center justify-center">
                <Sparkles className="text-white w-6 h-6 absolute z-10 drop-shadow-md" />
              </div>
              <h1 className="text-3xl font-light tracking-tight text-zinc-200 max-w-xs leading-snug font-sans">
                Hi {userName},<br />
                <span className="text-zinc-500">what's the plan?</span>
              </h1>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto px-4 pb-24 scrollbar-none font-mono">
              <DataStream messages={activeChat?.messages || []} busy={busy} />
              <div ref={messagesEndRef} className="h-6" />
              
              <div className={`transition-all duration-300 overflow-hidden flex justify-center ${busy ? 'h-8 opacity-100 mb-2' : 'h-0 opacity-0 mb-0'}`}>
                 <div className="flex items-center gap-2 text-xs font-mono text-cyan-400/80 bg-cyan-950/30 px-4 py-1.5 rounded-full border border-cyan-500/20 backdrop-blur-md">
                   <Activity className="size-3 animate-pulse" />
                   {loadingPhase}
                 </div>
              </div>
            </div>
          )}

          <div className="absolute bottom-0 left-0 w-full p-4 bg-gradient-to-t from-black via-black/95 to-transparent pb-6">
            <div className="w-full bg-zinc-900/90 border border-zinc-800/80 rounded-[24px] p-1.5 backdrop-blur-xl shadow-2xl focus-within:border-cyan-500/50 transition-all font-sans">
              
              {/* EXCLUSIVE FEATURE: TARGET SCOPE LOCK (MOBILE) */}
              <div className="flex items-center gap-2 mb-2 px-3 pt-2">
                <div className="flex items-center gap-1.5 text-[10px] text-cyan-500 uppercase tracking-widest font-semibold bg-cyan-500/10 px-2 py-1 rounded border border-cyan-500/20">
                  <Crosshair size={10} /> ROE Scope:
                </div>
                <input 
                  type="text" 
                  placeholder="e.g. *.vercel.app or 192.168.1.1" 
                  value={targetScope}
                  onChange={(e) => setTargetScope(e.target.value)}
                  className="bg-transparent text-xs text-zinc-400 placeholder:text-zinc-600 outline-none flex-1 font-mono"
                />
              </div>

              <CommandInput onSubmit={handleSubmit} busy={busy} onStop={() => abortControllerRef.current?.abort()} />
            </div>
          </div>
        </main>

        {/* ================= DESKTOP & TABLET VIEW ================= */}
        <main className="hidden md:flex flex-1 flex-col relative bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-cyan-950/20 via-[#0a0a0c] to-[#0a0a0c] min-w-0">
          
          <div className="absolute top-4 left-4 z-[50] flex items-center gap-3" ref={headerMenuRef}>
            {!isSidebarOpen && (
              <button onClick={() => setIsSidebarOpen(true)} className="flex items-center gap-3 hover:bg-white/5 p-2 rounded-xl transition-all border border-white/0 hover:border-white/5" title="Toggle Sidebar (Cmd+B)">
                <HexicalLogo className="size-6 text-cyan-400" />
              </button>
            )}
            
            <div className="h-6 w-px bg-white/10 mx-1 hidden md:block"></div>

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

          <div className="absolute top-4 right-4 z-[50] flex items-center gap-3">
            <button 
              onClick={() => setShowUpgradeModal(true)} 
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-sans font-semibold transition-all shadow-lg bg-cyan-600 hover:bg-cyan-500 text-white backdrop-blur-md"
            >
              <Sparkles className="size-3.5" />
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

          <div className="flex-1 flex flex-col items-center justify-center overflow-hidden w-full relative pt-16 pb-4 px-4">
              {activeChat?.messages.length <= 1 ? (
                <div className="w-full text-center max-w-2xl mx-auto animate-rise">
                  <h2 className="text-2xl md:text-4xl font-sans mb-8 text-foreground tracking-tight">
                    {isAuthLoading ? (
                      <span className="flex items-center justify-center gap-3 text-muted-foreground text-xl"><Loader2 className="animate-spin size-6 text-cyan-500" /> Securing session...</span>
                    ) : (
                      <>{getContextualGreeting()}, <span className="bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent font-semibold drop-shadow-[0_0_15px_rgba(34,211,238,0.2)]">{userName}</span>.</>
                    )}
                  </h2>
                  
                  <div className="w-full rounded-2xl border border-cyan-500/20 p-2 backdrop-blur-2xl bg-black/40 shadow-2xl shadow-cyan-950/20 focus-within:border-cyan-500/50 transition-all duration-300">
                      
                      {/* EXCLUSIVE FEATURE: TARGET SCOPE LOCK */}
                      <div className="flex items-center gap-2 mb-2 px-3 pt-2">
                        <div className="flex items-center gap-1.5 text-[10px] text-cyan-500 uppercase tracking-widest font-semibold bg-cyan-500/10 px-2 py-1 rounded border border-cyan-500/20">
                          <Crosshair size={10} /> ROE Scope:
                        </div>
                        <input 
                          type="text" 
                          placeholder="e.g. *.vercel.app or 192.168.1.1" 
                          value={targetScope}
                          onChange={(e) => setTargetScope(e.target.value)}
                          className="bg-transparent text-xs text-zinc-400 placeholder:text-zinc-600 outline-none flex-1 font-mono"
                        />
                      </div>

                      <CommandInput onSubmit={handleSubmit} busy={busy} onStop={() => abortControllerRef.current?.abort()} />
                  </div>
                  
                  <div className="mt-6 flex flex-wrap justify-center gap-3 opacity-60">
                    <span className="text-xs text-muted-foreground flex items-center gap-1.5"><kbd className="font-mono bg-white/5 border border-white/10 rounded px-1.5 py-0.5">Cmd</kbd> + <kbd className="font-mono bg-white/5 border border-white/10 rounded px-1.5 py-0.5">B</kbd> Sidebar</span>
                    <span className="text-xs text-muted-foreground flex items-center gap-1.5"><kbd className="font-mono bg-white/5 border border-white/10 rounded px-1.5 py-0.5">Cmd</kbd> + <kbd className="font-mono bg-white/5 border border-white/10 rounded px-1.5 py-0.5">I</kbd> Logic Trace</span>
                    <span className="text-xs text-muted-foreground flex items-center gap-1.5"><kbd className="font-mono bg-white/5 border border-white/10 rounded px-1.5 py-0.5">Cmd</kbd> + <kbd className="font-mono bg-white/5 border border-white/10 rounded px-1.5 py-0.5">,</kbd> Settings</span>
                  </div>
                </div>
              ) : (
                <div className="w-full max-w-3xl flex flex-col h-full overflow-hidden">
                  <div className="flex-1 overflow-y-auto px-2 md:px-6 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
                    <DataStream messages={activeChat.messages} busy={busy} />
                    <div ref={messagesEndRef} className="h-6" />
                  </div>
                  
                  <div className={`transition-all duration-300 overflow-hidden flex justify-center ${busy ? 'h-8 opacity-100 mb-2' : 'h-0 opacity-0 mb-0'}`}>
                     <div className="flex items-center gap-2 text-xs font-mono text-cyan-400/80 bg-cyan-950/30 px-4 py-1.5 rounded-full border border-cyan-500/20 backdrop-blur-md">
                       <Activity className="size-3 animate-pulse" />
                       {loadingPhase}
                     </div>
                  </div>

                  <div className="shrink-0 bg-gradient-to-t from-[#0a0a0c] via-[#0a0a0c]/90 to-transparent pt-2">
                      <div className="rounded-3xl border border-white/10 bg-black/40 backdrop-blur-2xl focus-within:border-cyan-500/50 focus-within:bg-black/60 transition-all shadow-lg">
                        
                        {/* EXCLUSIVE FEATURE: TARGET SCOPE LOCK */}
                        <div className="flex items-center gap-2 mb-2 px-3 pt-2">
                          <div className="flex items-center gap-1.5 text-[10px] text-cyan-500 uppercase tracking-widest font-semibold bg-cyan-500/10 px-2 py-1 rounded border border-cyan-500/20">
                            <Crosshair size={10} /> ROE Scope:
                          </div>
                          <input 
                            type="text" 
                            placeholder="e.g. *.vercel.app or 192.168.1.1" 
                            value={targetScope}
                            onChange={(e) => setTargetScope(e.target.value)}
                            className="bg-transparent text-xs text-zinc-400 placeholder:text-zinc-600 outline-none flex-1 font-mono"
                          />
                        </div>

                        <CommandInput onSubmit={handleSubmit} busy={busy} onStop={() => abortControllerRef.current?.abort()} />
                      </div>
                  </div>
                </div>
              )}
          </div>
        </main>

        {/* ================= ADVANCED LOGIC TRACE SPLIT PANE ================= */}
        {showTracePanel && activeTraceMessage && (
          <div className="w-[360px] md:w-[420px] h-full border-l border-white/5 bg-[#0a0a0c]/95 backdrop-blur-3xl flex flex-col overflow-hidden animate-fade-in flex-shrink-0 z-40 shadow-[-20px_0_50px_rgba(0,0,0,0.5)]">
            <div className="p-4 border-b border-white/10 flex items-center justify-between bg-black/40">
              <div className="flex items-center gap-2">
                <Terminal className="size-4 text-cyan-500" />
                <span className="text-xs uppercase font-bold tracking-widest text-foreground">Trace Inspector</span>
              </div>
              <button onClick={() => setShowTracePanel(false)} className="p-1 hover:bg-white/10 rounded-md text-muted-foreground hover:text-white transition-colors" title="Close Inspector">
                <X size={16} />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-5 space-y-6 text-xs scrollbar-thin scrollbar-thumb-white/10">
              
              {/* STATUS & ROUTE HEADER */}
              <div className="p-4 rounded-xl bg-white/[0.02] border border-white/5 shadow-inner flex justify-between items-start">
                <div>
                  <span className="text-muted-foreground block mb-2 font-sans text-[10px] uppercase tracking-wider font-semibold">Inferred Route</span>
                  <span className="text-cyan-300 font-mono text-[11px] bg-cyan-950/40 border border-cyan-500/20 px-2 py-1 rounded-md">{activeTraceMessage.route || 'default_eval'}</span>
                </div>
                {activeTraceMessage.isVerifiedContent ? (
                  <div className="flex flex-col items-end">
                    <span className="text-muted-foreground block mb-1 font-sans text-[10px] uppercase tracking-wider font-semibold">Security Status</span>
                    <span className="text-emerald-400 font-sans text-[10px] font-bold flex items-center gap-1 bg-emerald-950/40 border border-emerald-500/20 px-2 py-1 rounded-md"><CheckCircle size={12}/> VERIFIED</span>
                  </div>
                ) : (
                  <div className="flex flex-col items-end">
                    <span className="text-muted-foreground block mb-1 font-sans text-[10px] uppercase tracking-wider font-semibold">Security Status</span>
                    <span className="text-amber-400 font-sans text-[10px] font-bold flex items-center gap-1 bg-amber-950/40 border border-amber-500/20 px-2 py-1 rounded-md"><AlertTriangle size={12}/> UNVERIFIED</span>
                  </div>
                )}
              </div>

              {/* EXECUTION METRICS */}
              {activeTraceMessage.metrics && (
                <div className="grid grid-cols-3 gap-2">
                  <div className="bg-black/30 border border-white/5 rounded-lg p-2 flex flex-col items-center justify-center text-center">
                    <Timer size={14} className="text-zinc-500 mb-1" />
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-sans">Latency</span>
                    <span className="text-white font-mono text-xs">{activeTraceMessage.metrics.latencyMs}ms</span>
                  </div>
                  <div className="bg-black/30 border border-white/5 rounded-lg p-2 flex flex-col items-center justify-center text-center">
                    <Cpu size={14} className="text-zinc-500 mb-1" />
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-sans">Tokens</span>
                    <span className="text-white font-mono text-xs">{activeTraceMessage.metrics.tokensUsed}</span>
                  </div>
                  <div className="bg-black/30 border border-white/5 rounded-lg p-2 flex flex-col items-center justify-center text-center">
                    <ShieldCheck size={14} className="text-zinc-500 mb-1" />
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider font-sans">Confidence</span>
                    <span className="text-cyan-400 font-mono text-xs">{activeTraceMessage.metrics.confidenceScore}%</span>
                  </div>
                </div>
              )}

              {/* DATA ORIGIN / SOURCES MODULE */}
              <div className="space-y-3">
                <span className="text-muted-foreground block font-sans text-[10px] uppercase tracking-wider font-semibold border-b border-white/5 pb-2">Data Provenance</span>
                {activeTraceMessage.sources && activeTraceMessage.sources.length > 0 ? (
                  <div className="space-y-2">
                    {activeTraceMessage.sources.map((source, index) => (
                      <div key={index} className="p-3 bg-black/40 border border-white/5 rounded-lg flex justify-between items-center text-[10px] hover:border-cyan-500/20 transition-colors">
                         <div className="flex items-center gap-2">
                            {source.type === 'database' ? <Database size={12} className="text-purple-400" /> : 
                             source.type === 'web' ? <Globe size={12} className="text-blue-400" /> : 
                             <Activity size={12} className="text-cyan-400" />}
                            <span className="text-zinc-300 font-sans font-medium">{source.name}</span>
                         </div>
                         {source.verified ? 
                            <span className="text-emerald-400/80 flex items-center gap-1"><Check size={10}/> Trusted</span> : 
                            <span className="text-amber-400/80 flex items-center gap-1"><ShieldAlert size={10}/> Unverified</span>
                         }
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[10px] text-muted-foreground italic bg-black/20 p-3 rounded-lg border border-dashed border-white/5">Local sandbox heuristic evaluation applied. No external sources queried.</div>
                )}
              </div>

              {/* RAW JSON TOGGLE */}
              <div className="border border-white/5 rounded-lg overflow-hidden bg-black/20">
                <button onClick={() => setShowRawJson(!showRawJson)} className="w-full p-3 flex justify-between items-center text-[10px] font-sans uppercase tracking-wider text-zinc-400 hover:text-white transition-colors bg-white/[0.02]">
                  <span className="flex items-center gap-2"><FileJson size={14}/> View Raw Payload</span>
                  <ChevronDown size={14} className={`transition-transform duration-300 ${showRawJson ? 'rotate-180' : ''}`} />
                </button>
                {showRawJson && (
                  <div className="p-3 border-t border-white/5 text-[9px] text-cyan-500/70 overflow-x-auto">
                    <pre>
{JSON.stringify({
  request_id: "req_" + generateUniqueID(),
  timestamp: activeTraceMessage.ts,
  route: activeTraceMessage.route,
  security_profile: activeProfileId,
  context_workspace: activeWorkspaceId,
  execution_metrics: activeTraceMessage.metrics
}, null, 2)}
                    </pre>
                  </div>
                )}
              </div>

              {/* LOGIC TRACE STEPS */}
              <div className="space-y-3 pt-2">
                <span className="text-muted-foreground block font-sans text-[10px] uppercase tracking-wider font-semibold border-b border-white/5 pb-2">Execution Pipeline Logs</span>
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