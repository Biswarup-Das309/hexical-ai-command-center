'use client'

import { useMemo, useState } from 'react'
import { Hexagon, Wifi, Lock, ChevronDown, Settings } from 'lucide-react'
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

function tsNow() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false })
}

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export function HexicalConsole() {
  // Initialize with a system message so the chat isn't blank
  const [messages, setMessages] = useState<StreamMessage[]>([
    { id: 'init', role: 'hexical', text: 'SYSTEM ONLINE. READY FOR INPUT.', ts: tsNow(), steps: [], valid: true }
  ])
  const [busy, setBusy] = useState(false)
  const { showTelemetry, toggleTelemetry } = useSettingsStore()

  const latest = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'user') return messages[i]
    }
    return null
  }, [messages])

  const activeRoute = latest?.role === 'hexical' ? (latest.route ?? null) : null

  async function handleSubmit(logic: string) {
    setMessages((prev) => [
      ...prev,
      { id: uid(), role: 'user', text: logic, ts: tsNow() },
    ])
    setBusy(true)

    try {
      const res = await fetch(HEX_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logic, context: 'general' }),
      })

      if (!res.ok) throw new Error(`status ${res.status}`)

      const data: VerifyResponse = await res.json()
      const steps = Array.isArray(data.steps) ? data.steps : []

      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: 'hexical',
          text: data.analysis ?? '[empty payload]',
          steps,
          valid: Boolean(data.valid),
          route: inferRoute(steps),
          ts: tsNow(),
        },
      ])
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: 'error',
          text: 'CRITICAL FAIL: HEXICAL AI BACKEND UNREACHABLE.',
          ts: tsNow(),
        },
      ])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hud-grid relative flex h-dvh flex-col overflow-hidden bg-background">
      {/* Ambient glow accents */}
      <div className="pointer-events-none absolute -top-40 left-1/4 size-96 rounded-full bg-primary/10 blur-[120px]" />
      <div className="pointer-events-none absolute -bottom-40 right-1/4 size-96 rounded-full bg-accent/10 blur-[120px]" />

      {/* Top command bar */}
      <header className="relative z-10 flex items-center justify-between border-b border-border px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="relative flex size-9 items-center justify-center">
            <Hexagon className="size-9 text-primary text-glow-cyan animate-flicker" />
            <Hexagon className="absolute size-4 text-accent" />
          </div>
          <div className="leading-tight">
            <h1 className="font-mono text-sm font-bold uppercase tracking-[0.3em] text-foreground">
              Hexical<span className="text-primary text-glow-cyan"> AI</span>
            </h1>
            <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              Hybrid Intelligence Engine
            </p>
          </div>
        </div>

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
        </div>
      </header>

      {/* Main layout grid */}
      <div className={`relative z-10 grid min-h-0 flex-1 gap-3 p-3 transition-all duration-300 ${
        showTelemetry ? 'lg:grid-cols-[260px_minmax(0,1fr)_300px]' : 'lg:grid-cols-[260px_minmax(0,1fr)]'
      }`}>
        <div className="hidden min-h-0 lg:block">
          <NodeSidebar activeRoute={activeRoute} />
        </div>

        <main className="glass scanlines relative flex min-h-0 flex-col overflow-hidden rounded-lg">
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.25em] text-foreground">
              Primary Data Stream
            </h2>
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              CH·01 / SECURE
            </span>
          </div>

          <DataStream messages={messages} busy={busy} />

          <div className="border-t border-border p-3 sm:p-4">
            <CommandInput onSubmit={handleSubmit} busy={busy} />
          </div>
        </main>

        {showTelemetry && (
          <div className="hidden min-h-0 lg:block">
            <TelemetryPanel latest={latest} />
          </div>
        )}
      </div>
    </div>
  )
}