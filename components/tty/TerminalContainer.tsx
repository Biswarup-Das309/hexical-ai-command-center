'use client'

import { forwardRef, type ReactNode } from 'react'

export interface TerminalContainerProps {
  readonly title?: string
  readonly status?: ReactNode
  readonly toolbar?: ReactNode
  readonly children?: ReactNode
  readonly className?: string
}

export const TerminalContainer = forwardRef<HTMLDivElement, TerminalContainerProps>(function TerminalContainer(
  { title = 'LIVE EXECUTION', status, toolbar, children, className = '' },
  ref,
) {
  return (
    <section
      className={`hud-frame glass flex min-h-0 flex-col overflow-hidden rounded-lg ${className}`}
      aria-label={title}
    >
      <header className="flex min-h-10 items-center justify-between gap-3 border-b border-white/10 bg-black/20 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="size-2 shrink-0 rounded-full bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.75)]"
            aria-hidden="true"
          />
          <span className="truncate font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-zinc-300">
            {title}
          </span>
          {status}
        </div>
        {toolbar && <div className="flex shrink-0 items-center gap-1">{toolbar}</div>}
      </header>
      <div ref={ref} className="tty-terminal-mount min-h-0 flex-1 overflow-hidden bg-[#050505] p-2" />
      {children}
    </section>
  )
})
