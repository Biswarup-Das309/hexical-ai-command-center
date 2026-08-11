/**
 * Framed command protocol for a persistent POSIX shell.
 *
 * A PTY intentionally multiplexes stdout and stderr into one terminal byte
 * stream.  The random OSC frames below give the worker a bounded, unforgeable
 * (for ordinary command output) boundary around an admitted argv command
 * without evaluating browser-controlled shell source.  Text outside a frame
 * remains normal terminal transcript data; text between a matching START and
 * END is also attributable to the durable execution stream.
 */

const OSC_PREFIX = '\u001b]9;HEXICAL;'
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

function marker(token: string, phase: 'START' | 'END'): string {
  const suffix = phase === 'START' ? `START;${token}` : `END;${token};%s`
  return `\\033]9;HEXICAL;${suffix}\\a`
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
      `printf '${marker(input.token, 'START')}'`,
      command,
      '__hexical_exit=$?',
      `printf '${marker(input.token, 'END')} ' "$__hexical_exit"`,
      '[ "$__hexical_errexit" -eq 0 ] || set -e',
    ].join('; ') + '\n'
  )
}

function longestPrefixSuffix(value: string): number {
  const max = Math.min(value.length, OSC_PREFIX.length - 1)
  for (let length = max; length > 0; length -= 1) {
    if (value.endsWith(OSC_PREFIX.slice(0, length))) return length
  }
  return 0
}

function terminatorIndex(value: string, from: number): { readonly index: number; readonly length: number } | null {
  const bell = value.indexOf(BEL, from)
  const st = value.indexOf(STRING_TERMINATOR, from)
  if (bell < 0 && st < 0) return null
  if (bell >= 0 && (st < 0 || bell < st)) return { index: bell, length: BEL.length }
  return { index: st, length: STRING_TERMINATOR.length }
}

function parseFrame(frame: string, raw: string): TTYPersistentExecutionProtocolEvent | null {
  const parts = frame.split(';')
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
      const prefixIndex = this.buffered.indexOf(OSC_PREFIX)
      if (prefixIndex < 0) {
        const keep = longestPrefixSuffix(this.buffered)
        emitOutput(this.buffered.slice(0, this.buffered.length - keep))
        this.buffered = this.buffered.slice(this.buffered.length - keep)
        break
      }
      if (prefixIndex > 0) {
        emitOutput(this.buffered.slice(0, prefixIndex))
        this.buffered = this.buffered.slice(prefixIndex)
      }
      const terminator = terminatorIndex(this.buffered, OSC_PREFIX.length)
      if (terminator === null) {
        if (this.buffered.length > MAX_FRAME_BYTES) {
          emitOutput(this.buffered.slice(0, this.buffered.length - OSC_PREFIX.length))
          this.buffered = this.buffered.slice(this.buffered.length - OSC_PREFIX.length)
        }
        break
      }
      const rawFrame = this.buffered.slice(0, terminator.index + terminator.length)
      const frame = this.buffered.slice(OSC_PREFIX.length, terminator.index)
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
