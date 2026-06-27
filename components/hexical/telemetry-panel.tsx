'use client'

import {
  Radar,
  CornerDownRight,
  Cloud,
  Database,
  Sigma,
  HelpCircle,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import type { RoutePath, StreamMessage } from '@/lib/hexical-types'

const ROUTE_META: Record<
  RoutePath,
  { label: string; icon: typeof Cloud; tone: 'cyan' | 'emerald' | 'muted' }
> = {
  local: { label: 'Local Brain', icon: Database, tone: 'cyan' },
  math: { label: 'Math Engine', icon: Sigma, tone: 'cyan' },
  global: { label: 'Global Groq Cloud', icon: Cloud, tone: 'emerald' },
  unknown: { label: 'Unresolved', icon: HelpCircle, tone: 'muted' },
}

export function TelemetryPanel({ latest }: { latest: StreamMessage | null }) {
  const route = latest?.route ?? null
  const meta = route ? ROUTE_META[route] : null
  const isGlobal = route === 'global'

  return (
    <aside className="glass scanlines relative flex h-full flex-col overflow-hidden rounded-lg">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Radar className="size-4 text-primary text-glow-cyan" />
        <h2 className="font-mono text-[11px] uppercase tracking-[0.25em] text-foreground">
          Telemetry · Routing
        </h2>
      </header>

      {/* routing verdict */}
      <div className="border-b border-border p-4">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
          Engine Route
        </span>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <RouteCell
            label="Local"
            active={!!route && !isGlobal && route !== 'unknown'}
            tone="cyan"
          />
          <RouteCell label="Global" active={isGlobal} tone="emerald" />
        </div>

        {meta ? (
          <div
            className={`animate-rise mt-3 flex items-center gap-2 rounded-md border px-3 py-2 ${
              meta.tone === 'emerald'
                ? 'border-accent/50 bg-accent/10'
                : meta.tone === 'cyan'
                  ? 'border-primary/50 bg-primary/10'
                  : 'border-border bg-card/40'
            }`}
          >
            <meta.icon
              className={`size-4 ${
                meta.tone === 'emerald'
                  ? 'text-accent text-glow-emerald'
                  : meta.tone === 'cyan'
                    ? 'text-primary text-glow-cyan'
                    : 'text-muted-foreground'
              }`}
            />
            <span className="text-sm font-medium text-foreground">
              {meta.label}
            </span>
          </div>
        ) : (
          <p className="mt-3 font-mono text-[11px] text-muted-foreground">
            Awaiting transmission…
          </p>
        )}
      </div>

      {/* routing path steps */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
          Routing Path
        </span>

        <ol className="mt-3 space-y-2">
          {latest?.steps?.length ? (
            latest.steps.map((step, i) => (
              <li
                key={i}
                className="animate-rise flex items-start gap-2 rounded-md border border-border bg-card/40 px-3 py-2"
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <CornerDownRight className="mt-0.5 size-3.5 shrink-0 text-primary" />
                <span className="font-mono text-[11px] leading-relaxed text-foreground/90">
                  <span className="text-muted-foreground">
                    {String(i + 1).padStart(2, '0')}
                  </span>{' '}
                  {step}
                </span>
              </li>
            ))
          ) : (
            <li className="font-mono text-[11px] text-muted-foreground">
              No active route. Submit a query to trace the signal.
            </li>
          )}
        </ol>
      </div>

      {/* validity footer */}
      <div className="border-t border-border p-4">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Verification
          </span>
          {latest && latest.role === 'hexical' ? (
            latest.valid ? (
              <span className="flex items-center gap-1.5 font-mono text-[11px] text-accent">
                <CheckCircle2 className="size-3.5" /> VALID
              </span>
            ) : (
              <span className="flex items-center gap-1.5 font-mono text-[11px] text-destructive">
                <XCircle className="size-3.5" /> INVALID
              </span>
            )
          ) : (
            <span className="font-mono text-[11px] text-muted-foreground">—</span>
          )}
        </div>
      </div>
    </aside>
  )
}

function RouteCell({
  label,
  active,
  tone,
}: {
  label: string
  active: boolean
  tone: 'cyan' | 'emerald'
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-md border px-3 py-3 text-center transition-all duration-300 ${
        active
          ? tone === 'emerald'
            ? 'border-accent/60 bg-accent/10'
            : 'border-primary/60 bg-primary/10 border-glow-cyan'
          : 'border-border bg-card/30'
      }`}
    >
      {active && (
        <span className="animate-sweep pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-foreground/10 to-transparent" />
      )}
      <p
        className={`font-mono text-[11px] uppercase tracking-[0.2em] ${
          active
            ? tone === 'emerald'
              ? 'text-accent text-glow-emerald'
              : 'text-primary text-glow-cyan'
            : 'text-muted-foreground'
        }`}
      >
        {label}
      </p>
      <span
        className={`mx-auto mt-2 block size-1.5 rounded-full ${
          active
            ? tone === 'emerald'
              ? 'bg-accent animate-node text-accent'
              : 'bg-primary animate-node text-primary'
            : 'bg-muted-foreground/40'
        }`}
      />
    </div>
  )
}
