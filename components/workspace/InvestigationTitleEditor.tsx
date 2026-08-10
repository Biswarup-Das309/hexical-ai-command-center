'use client'

import type { KeyboardEvent } from 'react'

export interface InvestigationTitleEditorProps {
  readonly title: string
  readonly disabled?: boolean
  readonly onTitleChange: (title: string) => void
  readonly onSave: () => void
}

/**
 * Keeps the investigation title as a local, controlled draft. Validation is
 * deliberately deferred to the parent save action so users can replace an
 * existing title by clearing it first.
 */
export function InvestigationTitleEditor({
  title,
  disabled = false,
  onTitleChange,
  onSave,
}: InvestigationTitleEditorProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    onSave()
  }

  return (
    <input
      data-testid="investigation-title-input"
      value={title}
      disabled={disabled}
      onChange={(event) => onTitleChange(event.target.value)}
      onKeyDown={handleKeyDown}
      aria-label="Investigation title"
      className="w-full rounded border border-transparent bg-transparent px-2 py-1 font-mono text-sm font-semibold text-cyan-200 outline-none transition-colors placeholder:text-zinc-600 hover:border-white/10 focus:border-cyan-400/40 disabled:cursor-wait disabled:opacity-60"
    />
  )
}
