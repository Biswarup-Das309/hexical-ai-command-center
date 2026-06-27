'use client'
// 1. Import your store
import { useSettingsStore } from '@/lib/store'; 
import { useMemo, useState } from 'react'
import { Hexagon, Wifi, Lock, ChevronDown, Settings } from 'lucide-react' // Added Settings icon
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

// ... (keep tsNow and uid functions)

export function HexicalConsole() {
  const [messages, setMessages] = useState<StreamMessage[]>([])
  const [busy, setBusy] = useState(false)
  
  // 2. Access state from the store
  const { showTelemetry, toggleTelemetry } = useSettingsStore();

  const latest = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'user') return messages[i]
    }
    return null
  }, [messages])

  const activeRoute = latest?.role === 'hexical' ? (latest.route ?? null) : null

  // ... (keep handleSubmit function)

  return (
    <div className="hud-grid relative flex h-dvh flex-col overflow-hidden bg-background">
      {/* ... (keep ambient glow accents) ... */}

      <header className="relative z-10 flex items-center justify-between border-b border-border px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          {/* ... (keep Hexagon logo) ... */}
        </div>

        {/* 3. Updated Header with Toggle Button */}
        <div className="flex items-center gap-4">
          <button 
            onClick={toggleTelemetry}
            className={`flex items-center gap-2 rounded border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors ${
              showTelemetry ? 'border-primary/30 text-primary' : 'border-border text-muted-foreground'
            }`}
          >
            <Settings className="size-3" />
            Telemetry {showTelemetry ? 'ON' : 'OFF'}
          </button>
          
          <div className="hidden items-center gap-4 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground sm:flex">
             {/* ... (keep existing status items) ... */}
          </div>
        </div>
      </header>

      {/* three-panel grid */}
      {/* 4. Dynamic Grid: Conditionally change grid-cols if showTelemetry is false */}
      <div className={`relative z-10 grid min-h-0 flex-1 gap-3 p-3 transition-all duration-300 ${
        showTelemetry ? 'lg:grid-cols-[260px_minmax(0,1fr)_300px]' : 'lg:grid-cols-[260px_minmax(0,1fr)]'
      }`}>
        {/* left */}
        <div className="hidden min-h-0 lg:block">
          <NodeSidebar activeRoute={activeRoute} />
        </div>

        {/* center */}
        <main className="glass scanlines relative flex min-h-0 flex-col overflow-hidden rounded-lg">
          {/* ... (keep DataStream and CommandInput) ... */}
        </main>

        {/* 5. Right Panel: Only renders if showTelemetry is true */}
        {showTelemetry && (
          <div className="hidden min-h-0 lg:block">
            <TelemetryPanel latest={latest} />
          </div>
        )}
      </div>
    </div>
  )
}