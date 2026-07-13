'use client'

import { memo } from 'react'
import {
  Radar,
  CornerDownRight,
  Cloud,
  Database,
  Sigma,
  Network,
  Hammer,
  HelpCircle,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import type { RoutePath, StreamMessage } from '@/lib/hexical/types'
import { useSettingsStore } from '@/lib/store'

type Tone = 'cyan' | 'emerald' | 'muted'

interface RouteMetaEntry {
  label: string
  icon: typeof Cloud
  tone: Tone
}

// Plain annotation (works on any TS version — no `satisfies` dependency).
// Since RouteMetaEntry.tone is already the exact `Tone` union, this checks
// each entry just as strictly as `satisfies` would have.
// Covers every RoutePath value from hexical-types.ts. `swarm` and
// `forge_api` are grouped with the 'emerald' tone alongside `global` because
// all three represent off-device work (multi-agent consensus, third-party
// bounty-platform calls, remote inference) as opposed to `local`/`math`
// which run on-device. Adjust the tone assignment if that grouping doesn't
// match your intent.
const ROUTE_META: Record<RoutePath, RouteMetaEntry> = {
  local: {
    label: 'Local Brain',
    icon: Database,
    tone: 'cyan',
  },

  math: {
    label: 'Math Engine',
    icon: Sigma,
    tone: 'cyan',
  },

  swarm: {
    label: 'Swarm Consensus',
    icon: Network,
    tone: 'emerald',
  },

  forge_api: {
    label: 'Forge API',
    icon: Hammer,
    tone: 'emerald',
  },

  global: {
    label: 'Global Groq Cloud',
    icon: Cloud,
    tone: 'emerald',
  },

  cluster_edge: {
    label: 'Cluster Edge',
    icon: Network,
    tone: 'emerald',
  },

  unknown: {
    label: 'Unresolved',
    icon: HelpCircle,
    tone: 'muted',
  },
}

// Single source of truth for tone → Tailwind classes. The original component
// re-derived these via 2-3 near-identical ternary chains at every call site;
// centralizing them removes that duplication and the risk of the branches
// drifting out of sync.
const TONE_STYLES: Record<
  Tone,
  { badgeBorder: string; badgeBg: string; icon: string; cellBorder: string; cellBg: string; dot: string }
> = {
  cyan: {
    badgeBorder: 'border-primary/50',
    badgeBg: 'bg-primary/10',
    icon: 'text-primary text-glow-cyan',
    cellBorder: 'border-primary/60 border-glow-cyan',
    cellBg: 'bg-primary/10',
    dot: 'bg-primary animate-node',
  },
  emerald: {
    badgeBorder: 'border-accent/50',
    badgeBg: 'bg-accent/10',
    icon: 'text-accent text-glow-emerald',
    cellBorder: 'border-accent/60',
    cellBg: 'bg-accent/10',
    dot: 'bg-accent animate-node',
  },
  muted: {
    badgeBorder: 'border-border',
    badgeBg: 'bg-card/40',
    icon: 'text-muted-foreground',
    cellBorder: 'border-border',
    cellBg: 'bg-card/30',
    dot: 'bg-muted-foreground/40',
  },
}

// Stagger delay is capped so a very long routing trace doesn't take
// several seconds to finish animating in.
const MAX_STAGGER_STEPS = 12
const STAGGER_MS = 80

interface RouteCellProps {
  label: string
  active: boolean
  tone: Tone
}

const RouteCell = memo(function RouteCell({ label, active, tone }: RouteCellProps) {
  const styles = TONE_STYLES[tone]
  return (
    <div
      className={`relative overflow-hidden rounded-md border px-3 py-3 text-center transition-all duration-300 ${
        active ? `${styles.cellBorder} ${styles.cellBg}` : 'border-border bg-card/30'
      }`}
    >
      {active && (
        <span
          aria-hidden="true"
          className="animate-sweep motion-reduce:animate-none pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-foreground/10 to-transparent"
        />
      )}
      <p
        className={`font-mono text-[11px] uppercase tracking-[0.2em] ${
          active ? styles.icon : 'text-muted-foreground'
        }`}
      >
        {label}
      </p>
      <span
        aria-hidden="true"
        className={`mx-auto mt-2 block size-1.5 rounded-full ${active ? styles.dot : 'bg-muted-foreground/40'}`}
      />
    </div>
  )
})

interface TelemetryPanelProps {
  /** Most recent stream message, or null before the first query. */
  latest: StreamMessage | null
}

function TelemetryPanelImpl({ latest }: TelemetryPanelProps) {
  // Select only the one field this component needs. Destructuring the whole
  // store (`const { showTelemetry } = useSettingsStore()`) subscribes to
  // every field and re-renders this panel on any unrelated settings change.
  const showTelemetry = useSettingsStore((state) => state.showTelemetry)

  const route = latest?.route ?? null
  // Fall back to the "unknown" entry rather than trusting that a runtime
  // value always matches the RoutePath union — the type is a compile-time
  // promise, not a runtime guarantee, and this data is coming off a stream.
  const meta: RouteMetaEntry | null =
  route ? ROUTE_META[route] ?? ROUTE_META.unknown : null;
  // Guard against a malformed/partial payload arriving mid-stream.
  const steps = Array.isArray(latest?.steps) ? latest.steps : []

  if (!showTelemetry) return null

  // Driven by the same tone the badge below renders, so the strip and the
  // badge can never show contradictory routes (e.g. strip says "Local"
  // while the badge glows emerald for a cloud-bound route).
  const routeCells: Array<RouteCellProps & { key: string }> = [
    { key: 'local', label: 'Local', tone: 'cyan', active: meta?.tone === 'cyan' },
    { key: 'global', label: 'Global', tone: 'emerald', active: meta?.tone === 'emerald' },
  ]

  return (
    <aside
      aria-labelledby="telemetry-panel-heading"
      className="glass scanlines relative flex h-full flex-col overflow-hidden rounded-lg"
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Radar aria-hidden="true" className="size-4 text-primary text-glow-cyan" />
        <h2
          id="telemetry-panel-heading"
          className="font-mono text-[11px] uppercase tracking-[0.25em] text-foreground"
        >
          Telemetry · Routing
        </h2>
      </header>

      <div className="border-b border-border p-4">
        <div className="mt-3 grid grid-cols-2 gap-2">
          {routeCells.map(({ key, ...cell }) => (
            <RouteCell key={key} {...cell} />
          ))}
        </div>

        {meta ? (
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={`animate-rise motion-reduce:animate-none mt-3 flex items-center gap-2 rounded-md border px-3 py-2 ${TONE_STYLES[meta.tone].badgeBorder} ${TONE_STYLES[meta.tone].badgeBg}`}
          >
            <meta.icon aria-hidden="true" className={`size-4 ${TONE_STYLES[meta.tone].icon}`} />
            <span className="text-sm font-medium text-foreground">{meta.label}</span>
          </div>
        ) : (
          <p className="mt-3 font-mono text-[11px] text-muted-foreground">
            Awaiting transmission…
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
          Routing Path
        </span>

        <ol aria-live="polite" aria-relevant="additions" className="mt-3 space-y-2">
          {steps.length ? (
            steps.map((step, i) => (
              // Key includes the step content, not just the index. If a new
              // message reuses the same index with different text, React
              // treats it as a new element and replays the enter animation;
              // if the content is unchanged, the DOM node is reused instead
              // of needlessly remounting. Index alone did neither reliably.
              <li
                key={`${i}-${step}`}
                className="animate-rise motion-reduce:animate-none flex items-start gap-2 rounded-md border border-border bg-card/40 px-3 py-2"
                style={{ animationDelay: `${Math.min(i, MAX_STAGGER_STEPS) * STAGGER_MS}ms` }}
              >
                <CornerDownRight aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" />
                <span className="break-words font-mono text-[11px] leading-relaxed text-foreground/90">
                  <span className="text-muted-foreground">{String(i + 1).padStart(2, '0')}</span>{' '}
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

      <div className="border-t border-border p-4">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
            Verification
          </span>
          <span role="status" aria-live="polite" aria-atomic="true">
            {latest && latest.role === 'hexical' ? (
              latest.valid ? (
                <span className="flex items-center gap-1.5 font-mono text-[11px] text-accent">
                  <CheckCircle2 aria-hidden="true" className="size-3.5" /> VALID
                </span>
              ) : (
                <span className="flex items-center gap-1.5 font-mono text-[11px] text-destructive">
                  <XCircle aria-hidden="true" className="size-3.5" /> INVALID
                </span>
              )
            ) : (
              <span className="font-mono text-[11px] text-muted-foreground">—</span>
            )}
          </span>
        </div>
      </div>
    </aside>
  )
}

export const TelemetryPanel = memo(TelemetryPanelImpl)
TelemetryPanel.displayName = 'TelemetryPanel'