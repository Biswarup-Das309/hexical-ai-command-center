'use client'

import { ChevronRight, GitBranch, TerminalSquare } from 'lucide-react'

export interface ExecutionProcessTreeProps {
  readonly executionId: string
  readonly state: string | null
  readonly className?: string
}

export function ExecutionProcessTree({ executionId, state, className = '' }: ExecutionProcessTreeProps) {
  return (
    <section
      className={`rounded-lg border border-white/10 bg-black/20 p-3 ${className}`}
      aria-label="Execution process tree"
    >
      <div className="mb-3 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-400">
        <GitBranch className="size-3 text-cyan-300" /> Process tree
      </div>
      <div className="space-y-1 font-mono text-[10px]">
        <div className="flex items-center gap-1 text-zinc-300">
          <ChevronRight className="size-3 text-cyan-300" />
          hexical-runtime <span className="ml-auto text-emerald-300">{state ?? 'booting'}</span>
        </div>
        <div className="ml-4 flex items-center gap-1 text-zinc-500">
          <ChevronRight className="size-3" />
          worker/{executionId.slice(0, 8)} <span className="ml-auto text-zinc-600">owned</span>
        </div>
        <div className="ml-8 flex items-center gap-1 text-zinc-600">
          <TerminalSquare className="size-3" />
          sandbox process <span className="ml-auto">isolated cwd</span>
        </div>
      </div>
    </section>
  )
}
