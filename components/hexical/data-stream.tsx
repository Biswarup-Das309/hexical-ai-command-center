'use client'

import { useEffect, useRef } from 'react'
import { Terminal, User, AlertTriangle, Hexagon } from 'lucide-react'
import type { StreamMessage } from '@/lib/hexical-types'
import { DecryptLoader } from './decrypt-loader'

interface DataStreamProps {
  messages: StreamMessage[]
  busy: boolean
}

export function DataStream({ messages, busy }: DataStreamProps) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, busy])

  return (
    <div className="hud-grid min-h-0 flex-1 overflow-y-auto">
      <div className="flex flex-col">
        {messages.length === 0 && !busy && <EmptyState />}

        {messages.map((m) => (
          <StreamRow key={m.id} message={m} />
        ))}

        {busy && (
          <div className="animate-rise border-b border-border/60 px-5 py-5 sm:px-8">
            <RowHeader role="hexical" ts={nowLabel()} />
            <div className="mt-3 sm:pl-8">
              <DecryptLoader />
            </div>
          </div>
        )}

        <div ref={endRef} />
      </div>
    </div>
  )
}

function StreamRow({ message }: { message: StreamMessage }) {
  const isUser = message.role === 'user'
  const isError = message.role === 'error'

  return (
    <article
      className={`animate-rise relative border-b border-border/60 px-5 py-5 sm:px-8 ${
        isUser
          ? 'bg-card/20'
          : isError
            ? 'bg-destructive/5'
            : 'bg-transparent'
      }`}
    >
      {isError && (
        <span className="pointer-events-none absolute inset-y-0 left-0 w-[2px] bg-destructive" />
      )}
      {!isUser && !isError && (
        <span className="pointer-events-none absolute inset-y-0 left-0 w-[2px] bg-gradient-to-b from-primary to-accent" />
      )}

      <RowHeader role={message.role} ts={message.ts} />

      <div className="mt-3 sm:pl-8">
        {isError ? (
          <div className="space-y-1">
            <p className="animate-glitch font-mono text-base font-semibold uppercase tracking-wide text-destructive">
              {message.text}
            </p>
            <p className="animate-flicker font-mono text-[11px] uppercase tracking-[0.3em] text-destructive/70">
              {'>> connection terminated · retry transmission'}
            </p>
          </div>
        ) : isUser ? (
          <p className="font-mono text-sm leading-relaxed text-foreground/90">
            {message.text}
          </p>
        ) : (
          <p className="text-[15px] leading-relaxed text-foreground text-pretty">
            {message.text}
          </p>
        )}
      </div>
    </article>
  )
}

function RowHeader({
  role,
  ts,
}: {
  role: StreamMessage['role']
  ts: string
}) {
  const config = {
    user: {
      icon: User,
      label: 'OPERATOR',
      cls: 'text-foreground',
      iconCls: 'text-muted-foreground',
    },
    hexical: {
      icon: Hexagon,
      label: 'HEXICAL AI',
      cls: 'text-primary text-glow-cyan',
      iconCls: 'text-primary',
    },
    error: {
      icon: AlertTriangle,
      label: 'SYSTEM',
      cls: 'text-destructive',
      iconCls: 'text-destructive',
    },
  }[role]

  const Icon = config.icon

  return (
    <div className="flex items-center gap-2">
      <Icon className={`size-4 ${config.iconCls}`} />
      <span
        className={`font-mono text-[11px] font-semibold uppercase tracking-[0.25em] ${config.cls}`}
      >
        {config.label}
      </span>
      <span className="ml-auto font-mono text-[10px] tracking-widest text-muted-foreground">
        {ts}
      </span>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center px-6 text-center">
      <div className="glass border-glow-cyan flex size-16 items-center justify-center rounded-xl">
        <Terminal className="size-7 text-primary text-glow-cyan" />
      </div>
      <h3 className="mt-6 font-mono text-sm uppercase tracking-[0.35em] text-foreground">
        Engine Idle
      </h3>
      <p className="mt-2 max-w-md font-mono text-[12px] leading-relaxed text-muted-foreground">
        {
          'Hexical AI is standing by. Transmit logic through the command prompt below to route a query across local and global compute nodes.'
        }
      </p>
    </div>
  )
}

function nowLabel() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false })
}
