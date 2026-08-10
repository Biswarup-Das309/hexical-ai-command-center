import type { TTYStreamEvent } from './tty-stream-types'

export interface TTYTerminalLine {
  readonly lineNumber: number
  readonly text: string
  readonly sequence: number
  readonly timestamp: string
  readonly stream: 'stdout' | 'stderr'
}

export interface TTYSearchMatch {
  readonly lineNumber: number
  readonly start: number
  readonly length: number
  readonly sequence: number
}

export function buildTTYTerminalLines(
  events: readonly TTYStreamEvent[],
  maxLines = 100_000,
): readonly TTYTerminalLine[] {
  const boundedMax = Math.max(100, Math.min(100_000, Math.floor(maxLines)))
  const lines: TTYTerminalLine[] = []
  let pending = ''
  let pendingSequence = 0
  let pendingTimestamp = ''
  let pendingStream: 'stdout' | 'stderr' = 'stdout'
  for (const event of events) {
    if (event.type !== 'stdout' && event.type !== 'stderr') continue
    pending += event.payload.text
    pendingSequence = event.sequence
    pendingTimestamp = event.timestamp
    pendingStream = event.type
    const pieces = pending.split(/\r?\n/)
    pending = pieces.pop() ?? ''
    for (const text of pieces)
      lines.push({
        lineNumber: lines.length + 1,
        text,
        sequence: pendingSequence,
        timestamp: pendingTimestamp,
        stream: pendingStream,
      })
  }
  if (pending.length > 0 || lines.length === 0)
    lines.push({
      lineNumber: lines.length + 1,
      text: pending,
      sequence: pendingSequence,
      timestamp: pendingTimestamp,
      stream: pendingStream,
    })
  const retained = lines.slice(-boundedMax)
  return retained.map((line, index) => ({ ...line, lineNumber: index + 1 }))
}

export function findTTYSearchMatches(
  lines: readonly TTYTerminalLine[],
  query: string,
  caseSensitive = false,
): readonly TTYSearchMatch[] {
  const needle = caseSensitive ? query : query.toLocaleLowerCase()
  if (!needle) return []
  const matches: TTYSearchMatch[] = []
  for (const line of lines) {
    const haystack = caseSensitive ? line.text : line.text.toLocaleLowerCase()
    let start = 0
    while (start <= haystack.length - needle.length) {
      const index = haystack.indexOf(needle, start)
      if (index < 0) break
      matches.push({ lineNumber: line.lineNumber, start: index, length: needle.length, sequence: line.sequence })
      start = index + Math.max(1, needle.length)
    }
  }
  return matches
}
