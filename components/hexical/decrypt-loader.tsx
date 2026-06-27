'use client'

import { useEffect, useState } from 'react'

const GLYPHS = '01ABCDEF#%&$@/\\<>[]{}=+*'.split('')

function scramble(len: number) {
  let s = ''
  for (let i = 0; i < len; i++) {
    s += GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
  }
  return s
}

/** Pulsing waveform + decrypting glyph stream shown while awaiting a response. */
export function DecryptLoader() {
  const [line, setLine] = useState(scramble(36))

  useEffect(() => {
    const id = setInterval(() => setLine(scramble(36)), 70)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="flex items-center gap-4">
      <div className="flex h-8 items-end gap-[3px]" aria-hidden="true">
        {Array.from({ length: 14 }).map((_, i) => (
          <span
            key={i}
            className="animate-wave w-[3px] rounded-full bg-primary"
            style={{
              height: '100%',
              animationDelay: `${i * 70}ms`,
              transformOrigin: 'bottom',
              opacity: 0.45 + (i % 4) * 0.15,
            }}
          />
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[11px] tracking-widest text-primary/70 truncate">
          {line}
        </p>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
          Decrypting signal<span className="animate-caret">_</span>
        </p>
      </div>
    </div>
  )
}
