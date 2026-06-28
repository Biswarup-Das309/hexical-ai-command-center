'use client'

import { useState, useEffect, type FormEvent, type KeyboardEvent } from 'react'
import { ChevronRight, CornerDownLeft, Loader2, Square } from 'lucide-react'

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const PLACEHOLDERS = [
  "Ask Hexical AI...",
  "Ask Anything...",
  "What's up? How's your day?",
  "Transmit logic to the engine...",
  "Initiate command sequence..."
]

interface CommandInputProps {
  onSubmit: (value: string) => void
  busy: boolean
  onStop?: () => void
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function CommandInput({ onSubmit, busy, onStop }: CommandInputProps) {
  const [value, setValue] = useState('')
  const [focused, setFocused] = useState(false)
  const [dynamicPlaceholder, setDynamicPlaceholder] = useState("Ask Hexical AI...")

  // --- LIFECYCLE ---

  // Set dynamic placeholder only after mount to prevent hydration mismatch
  useEffect(() => {
    const randomIndex = Math.floor(Math.random() * PLACEHOLDERS.length)
    setDynamicPlaceholder(PLACEHOLDERS[randomIndex])
  }, [])

  // Draft recovery from localStorage
  useEffect(() => {
    const savedDraft = localStorage.getItem('pending_draft')
    if (savedDraft) {
      setValue(savedDraft)
      localStorage.removeItem('pending_draft')
    }
  }, [])

  // --- HANDLERS ---

  function handleSubmit(e?: FormEvent) {
    if (e) e.preventDefault()
    
    // Only submit if not busy and input is valid
    if (busy || !value.trim()) return
    
    onSubmit(value.trim())
    setValue('')
  }

  // Keyboard shortcut: Ctrl + Enter to submit
  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      handleSubmit()
    }
  }

  return (
    <form onSubmit={handleSubmit} className="relative">
      <div
        className={`
          glass relative flex items-center gap-3 rounded-lg px-4 py-3 transition-all duration-300
          ${focused ? 'border-primary/70 shadow-[0_0_15px_rgba(var(--primary-rgb),0.15)]' : 'border-border'}
          ${busy ? 'animate-pulse border-primary/50' : ''}
        `}
      >
        <ChevronRight
          className={`size-5 shrink-0 transition-colors ${
            focused ? 'text-primary' : 'text-muted-foreground'
          }`}
        />
        
        <span className="hidden font-mono text-[11px] uppercase tracking-[0.2em] text-primary/60 sm:inline">
          hexical:~$
        </span>
        
        <textarea
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          disabled={busy}
          placeholder={dynamicPlaceholder}
          aria-label="Command input"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-mono text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none disabled:opacity-50 resize-none overflow-hidden"
        />

        <button
          type="button"
          onClick={busy ? onStop : handleSubmit}
          className={`
            flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.15em] transition-all
            ${busy 
              ? 'border-red-500/40 bg-red-500/10 text-red-500 hover:bg-red-500/20' 
              : 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
            }
            disabled:cursor-not-allowed disabled:opacity-40
          `}
        >
          {busy ? (
            <>
              <Square className="size-3.5 fill-current" />
              Stop
            </>
          ) : (
            <>
              <CornerDownLeft className="size-3.5" />
              Execute
            </>
          )}
        </button>
      </div>
    </form>
  )
}