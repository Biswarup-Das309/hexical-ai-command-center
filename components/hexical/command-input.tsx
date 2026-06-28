'use client'

import { useState, useRef, useEffect, type FormEvent, type KeyboardEvent } from 'react'
import { ChevronRight, CornerDownLeft, Square } from 'lucide-react'

// -----------------------------------------------------------------------------
// TYPE DEFINITIONS
// -----------------------------------------------------------------------------

interface CommandInputProps {
  onSubmit: (value: string) => void
  busy: boolean
  onStop?: () => void
}

/**
 * CommandInput Component
 * A robust, auto-expanding input field designed for an AI command-line aesthetic.
 */
export function CommandInput({ onSubmit, busy, onStop }: CommandInputProps) {
  // State management for input value and focus status
  const [value, setValue] = useState('')
  const [focused, setFocused] = useState(false)
  
  // Ref for the DOM node to handle manual height calculation
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // ---------------------------------------------------------------------------
  // HEIGHT CALCULATION LOGIC
  // ---------------------------------------------------------------------------

  /**
   * Adjusts the height of the textarea based on content.
   * This ensures the input grows vertically ("down and down") rather than scrolling.
   */
  const adjustHeight = () => {
    const textarea = textareaRef.current
    if (textarea) {
      // Reset height temporarily to correctly calculate the scroll height
      textarea.style.height = 'auto'
      // Set to scroll height to expand the box
      textarea.style.height = `${textarea.scrollHeight}px`
    }
  }

  // Monitor value changes to trigger auto-resize
  useEffect(() => {
    adjustHeight()
  }, [value])

  // ---------------------------------------------------------------------------
  // EVENT HANDLERS
  // ---------------------------------------------------------------------------

  /**
   * Processes the form submission logic.
   * Includes validation checks to prevent empty submissions.
   */
  function handleSubmit(e?: FormEvent) {
    if (e) e.preventDefault()
    
    // Safety check: prevent submission if busy or input is effectively empty
    if (busy || !value.trim()) return
    
    // Bubble the submission up to the HexicalConsole parent
    onSubmit(value.trim())
    
    // Reset internal state
    setValue('')
    
    // Reset height back to single line after submission
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  /**
   * Keyboard shortcut management:
   * - Enter: Submit
   * - Shift+Enter: Newline (standard for chat)
   */
  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  // ---------------------------------------------------------------------------
  // RENDER: Main Input UI
  // ---------------------------------------------------------------------------

  return (
    <form onSubmit={handleSubmit} className="relative w-full">
      {/* Container: Uses 'items-center' to ensure the Chevron and Textarea are vertically aligned.
      */}
      <div 
        className={`
          glass relative flex items-center gap-3 rounded-2xl px-4 py-3 transition-all duration-300
          ${focused 
            ? 'border-primary/70 shadow-[0_0_15px_rgba(var(--primary-rgb),0.15)] bg-background/60' 
            : 'border-border bg-background/40'}
          ${busy ? 'animate-pulse border-primary/50' : ''}
        `}
      >
        {/* Visual Indicator: Chevron icon */}
        <ChevronRight 
          className={`size-5 shrink-0 transition-colors ${focused ? 'text-primary' : 'text-muted-foreground'}`} 
        />
        
        {/* Textarea: 
          - leading-[1.5rem] matches prompt text for alignment.
          - self-center ensures the textarea content itself is vertically balanced.
          - padding is standardized to match the container's logic.
        */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          disabled={busy}
          placeholder="Ask Hexical AI..."
          aria-label="Command input"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-mono text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none disabled:opacity-50 resize-none overflow-hidden leading-[1.5rem] py-0 self-center"
          style={{ minHeight: '1.5rem', maxHeight: '200px' }}
        />

        {/* Action Button: Execute/Stop */}
        <button
          type="button"
          onClick={busy ? onStop : handleSubmit}
          className={`
            flex shrink-0 items-center gap-1.5 rounded-lg border px-4 py-2 font-mono text-[11px] uppercase tracking-[0.15em] transition-all self-center
            ${busy 
              ? 'border-red-500/40 bg-red-500/10 text-red-500 hover:bg-red-500/20' 
              : 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
            }
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