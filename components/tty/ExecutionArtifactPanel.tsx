'use client'

import { Archive, Download, GitCompare, RotateCcw, ShieldCheck } from 'lucide-react'

export interface ExecutionArtifactPanelProps {
  readonly state: string | null
  readonly className?: string
}

export function ExecutionArtifactPanel({ state, className = '' }: ExecutionArtifactPanelProps) {
  const terminal =
    state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'timed_out' || state === 'expired'
  return (
    <section
      className={`rounded-lg border border-white/10 bg-black/20 p-3 ${className}`}
      aria-label="Execution artifacts and checkpoints"
    >
      <div className="mb-3 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-400">
        <Archive className="size-3 text-amber-300" /> Artifacts & checkpoints
      </div>
      <div className="space-y-2 font-mono text-[10px]">
        <div className="flex items-center gap-2 text-zinc-400">
          <ShieldCheck className="size-3 text-emerald-300" /> durable output stream{' '}
          <span className="ml-auto text-emerald-300">on</span>
        </div>
        <div className="flex items-center gap-2 text-zinc-500">
          <GitCompare className="size-3 text-cyan-300" /> execution diff{' '}
          <span className="ml-auto">{terminal ? 'replayable' : 'tracking'}</span>
        </div>
        <div className="flex items-center gap-2 text-zinc-500">
          <Download className="size-3 text-violet-300" /> log artifact{' '}
          <span className="ml-auto">{terminal ? 'downloadable' : 'building'}</span>
        </div>
        <div className="flex items-center gap-2 text-zinc-600">
          <RotateCcw className="size-3" /> rollback <span className="ml-auto">ephemeral cwd</span>
        </div>
      </div>
    </section>
  )
}
