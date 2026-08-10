'use client'

import { Database, Sigma, Cloud, Cpu, ShieldCheck, Activity } from 'lucide-react'
import type { RoutePath } from '@/lib/hexical-types'

interface NodeDef {
  id: RoutePath
  label: string
  sub: string
  icon: typeof Database
  latency: string
}

const NODES: NodeDef[] = [
  {
    id: 'local',
    label: 'Local K-12 Database',
    sub: 'On-device · encrypted',
    icon: Database,
    latency: '04ms',
  },
  {
    id: 'math',
    label: 'Math Engine',
    sub: 'Symbolic solver core',
    icon: Sigma,
    latency: '11ms',
  },
  {
    id: 'global',
    label: 'Global Groq Cloud',
    sub: 'LPU inference mesh',
    icon: Cloud,
    latency: '180ms',
  },
]

export function NodeSidebar({ activeRoute }: { activeRoute: RoutePath | null }) {
  return (
    <aside className="glass scanlines relative flex h-full flex-col overflow-hidden rounded-lg">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Cpu className="size-4 text-primary text-glow-cyan" />
        <h2 className="font-mono text-[11px] uppercase tracking-[0.25em] text-foreground">Data Sources</h2>
      </header>

      <div className="px-4 pt-4 pb-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">Active Nodes</span>
      </div>

      <ul className="flex flex-col gap-2 px-3">
        {NODES.map((node) => {
          const active = activeRoute === node.id
          const Icon = node.icon
          return (
            <li
              key={node.id}
              className={`group relative overflow-hidden rounded-md border px-3 py-3 transition-all duration-300 ${
                active
                  ? 'border-primary/60 bg-primary/10 border-glow-cyan'
                  : 'border-border bg-card/40 hover:border-primary/30'
              }`}
            >
              {active && (
                <span className="animate-sweep pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-primary/15 to-transparent" />
              )}
              <div className="relative flex items-start gap-3">
                <Icon
                  className={`mt-0.5 size-4 shrink-0 ${
                    active ? 'text-primary text-glow-cyan' : 'text-muted-foreground'
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium text-foreground">{node.label}</p>
                    <span
                      className={`animate-node size-1.5 shrink-0 rounded-full ${
                        node.id === 'global' ? 'bg-accent text-accent' : 'bg-primary text-primary'
                      }`}
                    />
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{node.sub}</p>
                  <div className="mt-2 flex items-center justify-between font-mono text-[10px]">
                    <span className={active ? 'text-primary' : 'text-muted-foreground'}>
                      {active ? 'ENGAGED' : 'STANDBY'}
                    </span>
                    <span className="text-muted-foreground">{node.latency}</span>
                  </div>
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      <div className="mt-auto space-y-3 border-t border-border p-4">
        <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.2em]">
          <span className="flex items-center gap-1.5 text-accent">
            <ShieldCheck className="size-3.5" /> Secure Link
          </span>
          <span className="text-muted-foreground">AES-256</span>
        </div>
        <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.2em]">
          <span className="flex items-center gap-1.5 text-primary">
            <Activity className="size-3.5" /> Mesh Load
          </span>
          <span className="text-muted-foreground">37%</span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
          <div className="h-full w-[37%] rounded-full bg-gradient-to-r from-primary to-accent" />
        </div>
      </div>
    </aside>
  )
}
