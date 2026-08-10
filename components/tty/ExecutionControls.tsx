'use client'

import { Check, Clipboard, Download, Play, RefreshCw, RotateCcw, Square, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { TTYExecutionState } from '@/lib/tty/tty-execution-state'

export interface ExecutionControlsProps {
  readonly executionId: string
  readonly state: TTYExecutionState | null
  readonly outputText: string
  readonly onCancel?: () => Promise<void> | void
  readonly onRestart?: () => Promise<void> | void
  readonly onReplay?: () => Promise<void> | void
  readonly onClear: () => void
}

function terminalState(state: TTYExecutionState | null): boolean {
  return (
    state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'timed_out' || state === 'expired'
  )
}

export function ExecutionControls({
  executionId,
  state,
  outputText,
  onCancel,
  onRestart,
  onReplay,
  onClear,
}: ExecutionControlsProps) {
  const [busy, setBusy] = useState<'cancel' | 'restart' | 'replay' | null>(null)
  const [copied, setCopied] = useState(false)
  const isTerminal = terminalState(state)

  const run = async (action: 'cancel' | 'restart' | 'replay', callback?: () => Promise<void> | void) => {
    if (!callback || busy) return
    setBusy(action)
    try {
      await callback()
    } finally {
      setBusy(null)
    }
  }

  const copyOutput = async () => {
    if (!navigator.clipboard) return
    await navigator.clipboard.writeText(outputText)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
  }

  const downloadLog = () => {
    const blob = new Blob([outputText], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `hexical-${executionId}.log`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const buttonClass =
    'inline-flex h-7 items-center gap-1.5 rounded border border-white/10 bg-white/[0.03] px-2 text-[10px] font-mono uppercase tracking-wider text-zinc-400 transition hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-40'
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Execution controls">
      <button
        type="button"
        className={buttonClass}
        onClick={() => void run('cancel', onCancel)}
        disabled={isTerminal || !onCancel || busy !== null}
      >
        <Square className="size-3" /> {busy === 'cancel' ? 'stopping' : 'cancel'}
      </button>
      <button
        type="button"
        className={buttonClass}
        onClick={() => void run('restart', onRestart)}
        disabled={!onRestart || busy !== null}
      >
        {isTerminal ? <RotateCcw className="size-3" /> : <Play className="size-3" />}{' '}
        {busy === 'restart' ? 'starting' : 'restart'}
      </button>
      <button
        type="button"
        className={buttonClass}
        onClick={() => void run('replay', onReplay)}
        disabled={!onReplay || busy !== null}
      >
        <RefreshCw className="size-3" /> {busy === 'replay' ? 'replaying' : 'replay'}
      </button>
      <button type="button" className={buttonClass} onClick={() => void copyOutput()} disabled={!outputText}>
        {copied ? <Check className="size-3 text-emerald-400" /> : <Clipboard className="size-3" />}{' '}
        {copied ? 'copied' : 'copy'}
      </button>
      <button type="button" className={buttonClass} onClick={downloadLog} disabled={!outputText}>
        <Download className="size-3" /> log
      </button>
      <button type="button" className={buttonClass} onClick={onClear} disabled={!outputText}>
        <Trash2 className="size-3" /> clear
      </button>
    </div>
  )
}
