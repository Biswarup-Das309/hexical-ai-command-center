'use client'

import { useEffect, useRef, useState } from 'react'

const GLYPHS = '01ABCDEF#%&$@/\\<>[]{}=+*'.split('')
const LINE_LENGTH = 36
const BAR_COUNT = 14
const TICK_MS = 70

function scramble(len: number): string {
  let s = ''
  for (let i = 0; i < len; i++) {
    s += GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
  }
  return s
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return reduced
}

/** Pulsing waveform + decrypting glyph stream shown while awaiting a response. */
export function DecryptLoader() {
  // SSR-safe placeholder — real randomization only starts after mount,
  // otherwise Math.random() differs server vs. client and React throws
  // a hydration mismatch.
  const [line, setLine] = useState('•'.repeat(LINE_LENGTH))
  const [heights, setHeights] = useState<number[]>(() => Array(BAR_COUNT).fill(35))
  const reducedMotion = usePrefersReducedMotion()
  const tick = useRef(0)

  useEffect(() => {
    setLine(scramble(LINE_LENGTH))
    if (reducedMotion) return

    let paused = document.hidden
    const onVisibility = () => {
      paused = document.hidden
    }
    document.addEventListener('visibilitychange', onVisibility)

    const id = setInterval(() => {
      if (paused) return
      tick.current += 1
      const t = tick.current

      setLine(scramble(LINE_LENGTH))
      setHeights(
        Array.from({ length: BAR_COUNT }, (_, i) => {
          const wave = Math.sin(t * 0.35 + i * 0.6) * 0.5 + 0.5 // 0..1
          const jitter = Math.random() * 0.25
          return Math.round(20 + (wave * 0.75 + jitter * 0.25) * 80) // 20–100%
        }),
      )
    }, TICK_MS)

    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [reducedMotion])

  return (
    <div className="flex items-center gap-4" role="status">
      <div className="flex h-8 items-end gap-[3px]" aria-hidden="true">
        {heights.map((h, i) => (
          <span
            key={i}
            className="w-[3px] rounded-full bg-primary transition-[height] duration-100 ease-out"
            style={{
              height: `${h}%`,
              opacity: 0.45 + (i % 4) * 0.15,
            }}
          />
        ))}
      </div>

      <div className="min-w-0 flex-1" aria-hidden="true">
        <p className="font-mono text-[11px] tracking-widest text-primary/70 truncate">{line}</p>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">
          Decrypting signal
          <span className="ml-0.5 animate-pulse">_</span>
        </p>
      </div>

      <span className="sr-only">Loading response…</span>
    </div>
  )
}
