/**
 * Framed command protocol for a persistent POSIX shell.
 *
 * A PTY intentionally multiplexes stdout and stderr into one terminal byte
 * stream.  The random token-boundary frames below give the worker a bounded,
 * unforgeable (for ordinary command output) boundary around an admitted argv
 * command without evaluating browser-controlled shell source.  The printable
 * frame is emitted because some Windows PTY backends consume OSC and C0
 * control sequences before they reach the reader.  The decoder retains
 * legacy OSC support during rolling worker upgrades.  Text outside a frame
 * remains normal terminal transcript data; text between a matching START and
 * END is also attributable to the durable execution stream.
 */

const FRAME_PREFIX = 'HEXICAL_RUNTIME_FRAME;'
const LEGACY_OSC_PREFIX = '\u001b]9;HEXICAL;'
const FRAME_PREFIXES = [FRAME_PREFIX, LEGACY_OSC_PREFIX] as const
const FRAME_TERMINATOR = '\n'
const BEL = '\u0007'
const STRING_TERMINATOR = '\u001b\\'
const MAX_FRAME_BYTES = 512
const TOKEN_PATTERN = /^[a-f0-9]{32}$/

export type TTYPersistentExecutionProtocolEvent =
  | { readonly type: 'output'; readonly text: string }
  | { readonly type: 'started'; readonly token: string; readonly raw: string }
  | { readonly type: 'completed'; readonly token: string; readonly exitCode: number; readonly raw: string }

function shellQuote(value: string): string {
  if (value.includes('\u0000')) throw new Error('Persistent shell argument contains a NUL byte.')
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`
}

function markerCommand(token: string, phase: 'START' | 'END'): string {
  if (phase === 'START') return `printf '%s%s\\n' 'HEXICAL_RUNTIME_FRAME' ';START;${token}'`
  return `printf '%s%s;%s\\n' 'HEXICAL_RUNTIME_FRAME' ';END;${token}' "$__hexical_exit"`
}

function validToken(value: string): boolean {
  return TOKEN_PATTERN.test(value)
}

/** Generates a capability-like marker that is never persisted in browser-visible events. */
export function createTTYPersistentExecutionMarker(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

/**
 * Builds one literal shell line from already-admitted argv.  Each argv item is
 * single-quoted, so redirects, substitutions, pipes, and whitespace remain
 * literal arguments exactly as they were at admission.  The command itself
 * still runs in the long-lived shell, allowing builtins such as `cd` to
 * preserve cwd for subsequent commands.
 */
export function serializeTTYPersistentShellExecution(input: {
  readonly token: string
  readonly argv: readonly [string, ...string[]]
}): string {
  if (!validToken(input.token) || input.argv.length === 0) throw new Error('Invalid persistent shell execution frame.')
  const command = input.argv.map(shellQuote).join(' ')
  return (
    [
      '__hexical_errexit=0',
      'case $- in *e*) __hexical_errexit=1; set +e ;; esac',
      markerCommand(input.token, 'START'),
      command,
      '__hexical_exit=$?',
      markerCommand(input.token, 'END'),
      '[ "$__hexical_errexit" -eq 0 ] || set -e',
    ].join('; ') + '\n'
  )
}

function longestPrefixSuffix(value: string): number {
  for (const prefix of FRAME_PREFIXES) {
    const max = Math.min(value.length, prefix.length - 1)
    for (let length = max; length > 0; length -= 1) {
      if (value.endsWith(prefix.slice(0, length))) return length
    }
  }
  return 0
}

function terminatorIndex(
  value: string,
  prefix: string,
  from: number,
): { readonly index: number; readonly length: number } | null {
  const frameTerminator = prefix === FRAME_PREFIX ? value.indexOf(FRAME_TERMINATOR, from) : -1
  const bell = value.indexOf(BEL, from)
  const st = value.indexOf(STRING_TERMINATOR, from)
  const candidates = [
    frameTerminator >= 0 ? { index: frameTerminator, length: FRAME_TERMINATOR.length } : null,
    bell >= 0 ? { index: bell, length: BEL.length } : null,
    st >= 0 ? { index: st, length: STRING_TERMINATOR.length } : null,
  ].filter((candidate): candidate is { readonly index: number; readonly length: number } => candidate !== null)
  if (candidates.length === 0) return null
  return candidates.reduce((earliest, candidate) => (candidate.index < earliest.index ? candidate : earliest))
}

function framePrefix(value: string): { readonly index: number; readonly prefix: string } | null {
  const matches = FRAME_PREFIXES.map((prefix) => ({ index: value.indexOf(prefix), prefix })).filter(
    (match) => match.index >= 0,
  )
  if (matches.length === 0) return null
  return matches.reduce((earliest, match) => (match.index < earliest.index ? match : earliest))
}

function parseFrame(frame: string, raw: string): TTYPersistentExecutionProtocolEvent | null {
  const normalizedFrame = frame.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replaceAll('\r', '')
  const parts = normalizedFrame.split(';')
  if (parts[0] === 'START' && parts.length === 2 && validToken(parts[1] ?? ''))
    return { type: 'started', token: parts[1] as string, raw }
  if (parts[0] === 'END' && parts.length === 3 && validToken(parts[1] ?? '')) {
    const exitCode = Number(parts[2])
    if (Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255)
      return { type: 'completed', token: parts[1] as string, exitCode, raw }
  }
  return null
}

/** Incremental decoder; marker frames may arrive split across arbitrary PTY chunks. */
export class TTYPersistentExecutionProtocolDecoder {
  private buffered = ''

  /** Bytes that must be replayed again when a durable journal poll ends mid-frame. */
  bufferedInputBytes(): number {
    return Buffer.byteLength(this.buffered, 'utf8')
  }

  /** Discards an incomplete frame before the next poll replays it from its cursor. */
  reset(): void {
    this.buffered = ''
  }

  push(chunk: string): readonly TTYPersistentExecutionProtocolEvent[] {
    if (chunk.length === 0) return []
    this.buffered += chunk
    const events: TTYPersistentExecutionProtocolEvent[] = []
    const emitOutput = (text: string) => {
      if (text.length > 0) events.push({ type: 'output', text })
    }

    while (this.buffered.length > 0) {
      const prefix = framePrefix(this.buffered)
      if (prefix === null) {
        const keep = longestPrefixSuffix(this.buffered)
        emitOutput(this.buffered.slice(0, this.buffered.length - keep))
        this.buffered = this.buffered.slice(this.buffered.length - keep)
        break
      }
      if (prefix.index > 0) {
        emitOutput(this.buffered.slice(0, prefix.index))
        this.buffered = this.buffered.slice(prefix.index)
      }
      const terminator = terminatorIndex(this.buffered, prefix.prefix, prefix.prefix.length)
      if (terminator === null) {
        if (this.buffered.length > MAX_FRAME_BYTES) {
          emitOutput(this.buffered.slice(0, this.buffered.length - prefix.prefix.length))
          this.buffered = this.buffered.slice(this.buffered.length - prefix.prefix.length)
        }
        break
      }
      const rawFrame = this.buffered.slice(0, terminator.index + terminator.length)
      const frame = this.buffered.slice(prefix.prefix.length, terminator.index)
      this.buffered = this.buffered.slice(terminator.index + terminator.length)
      const parsed = parseFrame(frame, rawFrame)
      if (parsed === null) emitOutput(rawFrame)
      else events.push(parsed)
    }
    return Object.freeze(events)
  }

  flush(): readonly TTYPersistentExecutionProtocolEvent[] {
    if (this.buffered.length === 0) return []
    const output = this.buffered
    this.buffered = ''
    return Object.freeze([{ type: 'output', text: output }])
  }
}
