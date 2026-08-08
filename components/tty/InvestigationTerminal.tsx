'use client'

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Terminal } from 'xterm'

import { TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE, TERMINAL_SCROLLBACK, TERMINAL_THEME } from '@/lib/tty/TerminalTheme'
import { TTYTerminalRenderer } from '@/lib/tty/tty-terminal-renderer'
import type { TTYStreamEvent } from '@/lib/tty/tty-stream-types'
import { TerminalContainer, type TerminalContainerProps } from './TerminalContainer'

export interface InvestigationTerminalHandle {
  readonly terminal: Terminal | null
  write(data: string): void
  clear(): void
  focus(): void
  fit(): void
  scrollToLine(line: number): void
  getSelection(): string
}

export interface InvestigationTerminalProps extends Omit<TerminalContainerProps, 'children'> {
  readonly initialText?: string
  readonly autoFocus?: boolean
  readonly events?: readonly TTYStreamEvent[]
  readonly onReady?: (terminal: Terminal) => void
  readonly onInput?: (data: string) => void
  readonly onResize?: (geometry: { readonly cols: number; readonly rows: number }) => void
}

export const InvestigationTerminal = forwardRef<InvestigationTerminalHandle, InvestigationTerminalProps>(function InvestigationTerminal({
  initialText,
  autoFocus = true,
  events = [],
  onReady,
  onInput,
  onResize,
  ...containerProps
}, ref) {
  const mountRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const rendererRef = useRef<TTYTerminalRenderer | null>(null)
  const fitAddonRef = useRef<{ fit(): void } | null>(null)
  const [ready, setReady] = useState(false)

  useImperativeHandle(ref, () => ({
    terminal: terminalRef.current,
    write(data) { terminalRef.current?.write(data) },
    clear() { terminalRef.current?.clear() },
    focus() { terminalRef.current?.focus() },
    fit() { fitAddonRef.current?.fit() },
    scrollToLine(line) { terminalRef.current?.scrollToLine(Math.max(0, Math.floor(line))) },
    getSelection() { return terminalRef.current?.getSelection() ?? '' }
  }), [ready])

  useEffect(() => {
    let disposed = false
    let terminal: Terminal | null = null
    let fitAddon: { fit(): void } | null = null
    let resizeObserver: ResizeObserver | null = null

    const mount = mountRef.current
    if (!mount) return

    void Promise.all([import('xterm'), import('@xterm/addon-fit')]).then(([xtermModule, fitModule]) => {
      if (disposed || !mountRef.current) return
      terminal = new xtermModule.Terminal({
        allowProposedApi: false,
        convertEol: false,
        cursorBlink: true,
        cursorStyle: 'block',
        disableStdin: onInput === undefined,
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: TERMINAL_FONT_SIZE,
        lineHeight: 1.25,
        scrollback: TERMINAL_SCROLLBACK,
        scrollOnUserInput: false,
        theme: TERMINAL_THEME
      })
      fitAddon = new fitModule.FitAddon()
      terminal.loadAddon(fitAddon as never)
      terminal.open(mountRef.current)
      terminalRef.current = terminal
      rendererRef.current = new TTYTerminalRenderer({ write: data => terminal?.write(data) })
      fitAddonRef.current = fitAddon
      fitAddon.fit()
      if (initialText) terminal.write(initialText)
      if (autoFocus) terminal.focus()
      const inputDisposable = onInput ? terminal.onData(onInput) : null
      const fit = () => {
        if (disposed || !fitAddon || !terminal) return
        fitAddon.fit()
        onResize?.({ cols: terminal.cols, rows: terminal.rows })
      }
      resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => requestAnimationFrame(fit))
      resizeObserver?.observe(mount)
      window.addEventListener('resize', fit)
      setReady(true)
      onReady?.(terminal)

      ;(terminal as Terminal & { __hexicalCleanup?: () => void }).__hexicalCleanup = () => {
        inputDisposable?.dispose()
        window.removeEventListener('resize', fit)
      }
    }).catch(() => {
      if (!disposed) setReady(false)
    })

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      const cleanupTerminal = terminal as (Terminal & { __hexicalCleanup?: () => void }) | null
      cleanupTerminal?.__hexicalCleanup?.()
      terminal?.dispose()
      terminalRef.current = null
      rendererRef.current = null
      fitAddonRef.current = null
      setReady(false)
    }
  }, [autoFocus, initialText, onInput, onReady, onResize])

  useEffect(() => {
    if (!ready || !rendererRef.current) return
    for (const event of events) rendererRef.current.render(event)
  }, [events, ready])

  return <TerminalContainer ref={mountRef} {...containerProps} status={!ready && <span className="font-mono text-[9px] uppercase tracking-widest text-zinc-600">booting</span>} />
})
