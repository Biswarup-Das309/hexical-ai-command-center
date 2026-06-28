'use client'

import { useState, type FormEvent, useEffect } from 'react'
import { ChevronRight, CornerDownLeft, Loader2 } from 'lucide-react'

// 1. Define the array of dynamic prompts outside the component
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
}

export function CommandInput({ onSubmit, busy }: CommandInputProps) {
  const [value, setValue] = useState('')
  const [focused, setFocused] = useState(false)
  
  // 2. Set a static default for the server render to prevent hydration mismatch
  const [dynamicPlaceholder, setDynamicPlaceholder] = useState("Ask Hexical AI...")

  // 3. Pick a random placeholder only after mounting in the browser
  useEffect(() => {
    const randomIndex = Math.floor(Math.random() * PLACEHOLDERS.length)
    setDynamicPlaceholder(PLACEHOLDERS[randomIndex])
  }, [])

  // DRAFT RECOVERY: Check for saved text on component mount
  useEffect(() => {
    const savedDraft = localStorage.getItem('pending_draft')
    if (savedDraft) {
      setValue(savedDraft)
      // Clear the draft so it doesn't reappear if the page refreshes
      localStorage.removeItem('pending_draft')
    }
  }, [])

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed || busy) return
    onSubmit(trimmed)
    setValue('')
  }

  return (
    <form onSubmit={handleSubmit} className="relative">
      <div
        className={`glass relative flex items-center gap-3 rounded-lg px-4 py-3 transition-all duration-300 ${
          focused ? 'border-glow-cyan border-primary/70' : 'border-border'
        }`}
      >
        <ChevronRight
          className={`size-5 shrink-0 transition-colors ${
            focused ? 'text-primary text-glow-cyan' : 'text-muted-foreground'
          }`}
        />
        <span className="hidden font-mono text-[11px] uppercase tracking-[0.2em] text-primary/60 sm:inline">
          hexical:~$
        </span>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          disabled={busy}
          placeholder={dynamicPlaceholder} // 4. Apply the dynamic placeholder state
          aria-label="Command input"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-mono text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.15em] text-primary transition-all hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <CornerDownLeft className="size-3.5" />
          )}
          {busy ? 'Routing' : 'Execute'}
        </button>
      </div>
    </form>
  )
}
