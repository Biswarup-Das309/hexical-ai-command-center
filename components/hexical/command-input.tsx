'use client'

import { useState, useRef, useEffect, type FormEvent, type KeyboardEvent } from 'react'
import { ChevronRight, CornerDownLeft, Square, Zap, ShieldAlert } from 'lucide-react'

// -----------------------------------------------------------------------------
// TYPE DEFINITIONS
// -----------------------------------------------------------------------------

interface CommandInputProps {
  onSubmit: (value: string) => void
  busy: boolean
  onStop?: () => void
  activeTier?: string // CRITICAL ADDITION: Inject tier awareness for FOMO
}

/**
 * CommandInput Component
 * Upgraded with dynamic Tier-Aware FOMO aesthetics and routing.
 */
export function CommandInput({ onSubmit, busy, onStop, activeTier = 'free' }: CommandInputProps) {
  const [value, setValue] = useState('')
  const [focused, setFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const normalizedTier = activeTier.toLowerCase()

  // ---------------------------------------------------------------------------
  // TIER-BASED FOMO LOGIC (Dynamic Placeholders & Styles)
  // ---------------------------------------------------------------------------
  
  const getPlaceholderText = () => {
    switch (normalizedTier) {
      case 'pro': return "Describe an engineering goal for the coordinated agent swarm..."
      case 'plus': return "Describe a repository problem, change, or validation request..."
      case 'go': return "Investigate an engineering problem..."
      default: return "Describe what you want to investigate..."
    }
  }

  const getTierTheme = () => {
    if (focused) {
      switch (normalizedTier) {
        case 'pro': return 'border-amber-500/70 shadow-[0_0_20px_rgba(245,158,11,0.15)] bg-amber-500/[0.02]'
        case 'plus': return 'border-cyan-500/70 shadow-[0_0_20px_rgba(34,211,238,0.15)] bg-cyan-500/[0.02]'
        case 'go': return 'border-emerald-500/70 shadow-[0_0_15px_rgba(16,185,129,0.15)] bg-emerald-500/[0.02]'
        default: return 'border-primary/50 shadow-[0_0_15px_rgba(var(--primary-rgb),0.1)] bg-background/60'
      }
    }
    return 'border-border bg-background/40 hover:border-white/10'
  }

  const getButtonTheme = () => {
    if (busy) return 'border-red-500/40 bg-red-500/10 text-red-500 hover:bg-red-500/20'
    
    switch (normalizedTier) {
      case 'pro': return 'border-amber-500/40 bg-amber-500/10 text-amber-500 hover:bg-amber-500/20'
      case 'plus': return 'border-cyan-500/40 bg-cyan-500/10 text-cyan-500 hover:bg-cyan-500/20'
      case 'go': return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20'
      default: return 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
    }
  }

  // ---------------------------------------------------------------------------
  // HEIGHT CALCULATION LOGIC
  // ---------------------------------------------------------------------------
  const adjustHeight = () => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${textarea.scrollHeight}px`
    }
  }

  useEffect(() => {
    adjustHeight()
  }, [value])

  // ---------------------------------------------------------------------------
  // EVENT HANDLERS
  // ---------------------------------------------------------------------------
  function handleSubmit(e?: FormEvent) {
    if (e) e.preventDefault()
    if (busy || !value.trim()) return
    onSubmit(value.trim())
    setValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------
  return (
    <form onSubmit={handleSubmit} className="relative w-full group">
      
      {/* FOMO Upsell Badge for Free Users */}
      {normalizedTier === 'free' && value.length > 50 && (
        <div className="absolute -top-8 right-2 flex items-center gap-1.5 text-[10px] text-amber-500 font-mono animate-fade-in bg-amber-500/10 px-2 py-1 rounded border border-amber-500/20 backdrop-blur-md">
          <ShieldAlert size={12} />
          <span>Large engineering context detected. Upgrade recommended.</span>
        </div>
      )}

      <div className={`glass relative flex items-center gap-3 rounded-2xl px-4 py-3 transition-all duration-500 ${getTierTheme()} ${busy ? 'animate-pulse' : ''}`}>
        
        {/* Visual Indicator */}
        <ChevronRight className={`size-5 shrink-0 transition-colors duration-500 ${focused ? (normalizedTier === 'pro' ? 'text-amber-500' : normalizedTier === 'plus' ? 'text-cyan-400' : 'text-primary') : 'text-muted-foreground'}`} />
        
        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          disabled={busy}
          placeholder={getPlaceholderText()}
          aria-label="Engineering goal"
          autoComplete="off"
          spellCheck={false}
          className={`min-w-0 flex-1 bg-transparent font-mono text-sm placeholder:text-muted-foreground/50 focus:outline-none disabled:opacity-50 resize-none overflow-y-auto leading-[1.5rem] py-0 self-center transition-colors ${
            normalizedTier === 'pro' ? 'text-amber-50' : 'text-foreground'
          }`}
          style={{ minHeight: '1.5rem', maxHeight: '200px' }}
        />

        {/* Action Button */}
        <button
          type="button"
          onClick={busy ? onStop : handleSubmit}
          className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-4 py-2 font-mono text-[11px] uppercase tracking-[0.15em] transition-all self-center shadow-lg ${getButtonTheme()}`}
        >
          {busy ? (
            <><Square className="size-3.5 fill-current" /> Stop</>
          ) : (
            <><CornerDownLeft className="size-3.5" /> Investigate</>
          )}
        </button>
      </div>
    </form>
  )
}
