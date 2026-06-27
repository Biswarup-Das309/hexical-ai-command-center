'use client'

import { useMemo, useState } from 'react'
import { Hexagon, Settings, Menu, X, User, LogIn } from 'lucide-react'
import { useSettingsStore } from '@/lib/store' 
import {
  HEX_ENDPOINT,
  inferRoute,
  type StreamMessage,
  type VerifyResponse,
} from '@/lib/hexical-types'
import { NodeSidebar } from './node-sidebar'
import { TelemetryPanel } from './telemetry-panel'
import { DataStream } from './data-stream'
import { CommandInput } from './command-input'

function tsNow() { return new Date().toLocaleTimeString('en-GB', { hour12: false }) }
function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36) }

export function HexicalConsole() {
  const [messages, setMessages] = useState<StreamMessage[]>([
    { id: 'init', role: 'hexical', text: 'SYSTEM ONLINE. READY FOR INPUT.', ts: tsNow(), steps: [], valid: true }
  ])
  const [busy, setBusy] = useState(false)
  const [isSidebarOpen, setSidebarOpen] = useState(false)
  
  // Replace this with your actual Auth state (e.g., from NextAuth or Clerk)
  const [isAuthenticated] = useState(false) 
  
  const { showTelemetry, toggleTelemetry } = useSettingsStore()

  const latest = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'user') return messages[i]
    }
    return null
  }, [messages])

  const activeRoute = latest?.role === 'hexical' ? (latest.route ?? null) : null

  async function handleSubmit(logic: string) {
    setMessages((prev) => [...prev, { id: uid(), role: 'user', text: logic, ts: tsNow() }])
    setBusy(true)
    // ... (Keep your existing API fetch logic here)
    setBusy(false)
  }

  return (
    <div className="relative flex h-screen w-full flex-col overflow-hidden bg-background">
      {/* HEADER */}
      <header className="relative z-50 flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <button onClick={() => setSidebarOpen(!isSidebarOpen)} className="lg:hidden">
            {isSidebarOpen ? <X className="size-6 text-foreground" /> : <Menu className="size-6 text-foreground" />}
          </button>
          
          <div className="relative flex size-8 items-center justify-center">
            <Hexagon className="size-8 text-primary animate-flicker" />
          </div>
          <h1 className="hidden font-mono text-sm font-bold uppercase tracking-[0.2em] text-foreground sm:block">
            Hexical<span className="text-primary"> AI</span>
          </h1>
        </div>

        <div className="flex items-center gap-3">
          <button onClick={toggleTelemetry} className={`hidden rounded border px-3 py-1 font-mono text-[10px] uppercase sm:block ${showTelemetry ? 'border-primary/30 text-primary' : 'border-border text-muted-foreground'}`}>
            Telemetry {showTelemetry ? 'ON' : 'OFF'}
          </button>
          
          {/* USER LOGIN INTERFACE */}
          <div className="flex items-center gap-2 rounded-full border border-border bg-muted/20 px-3 py-1.5">
            {isAuthenticated ? (
              <User className="size-4 text-primary" />
            ) : (
              <LogIn className="size-4 text-muted-foreground" />
            )}
            <span className="hidden font-mono text-[10px] text-muted-foreground sm:inline">
              {isAuthenticated ? 'OPERATOR' : 'GUEST'}
            </span>
          </div>
        </div>
      </header>

      {/* MAIN CONTENT AREA */}
      <div className="relative flex flex-1 overflow-hidden">
        
        {/* MOBILE SIDEBAR OVERLAY */}
        {isSidebarOpen && (
          <div className="absolute inset-0 z-40 bg-background/80 backdrop-blur-sm lg:hidden" onClick={() => setSidebarOpen(false)} />
        )}

        {/* SIDEBAR (Desktop: Visible | Mobile: Drawer) */}
        <aside className={`${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0 absolute z-50 h-full w-[260px] border-r border-border bg-background transition-transform duration-300 lg:relative`}>
          <NodeSidebar activeRoute={activeRoute} />
        </aside>

        {/* CENTER CONSOLE */}
        <main className="flex flex-1 flex-col overflow-hidden p-3">
          <div className="glass flex h-full flex-col overflow-hidden rounded-lg border border-border">
            <DataStream messages={messages} busy={busy} />
            <div className="border-t border-border p-4">
              <CommandInput onSubmit={handleSubmit} busy={busy} />
            </div>
          </div>
        </main>

        {/* TELEMETRY PANEL (Desktop: Visible | Mobile: Optional/Hidden) */}
        {showTelemetry && (
          <div className="hidden w-[300px] border-l border-border lg:block">
            <TelemetryPanel latest={latest} />
          </div>
        )}
      </div>
    </div>
  )
}