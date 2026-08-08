import type { TTYStreamEvent } from './tty-stream-types'

export interface TTYTerminalWriter {
  write(data: string): void
}

export interface TTYRenderResult {
  readonly rendered: boolean
  readonly duplicate: boolean
  readonly gap: boolean
}

function timeLabel(timestamp: string): string {
  const parsed = new Date(timestamp)
  return Number.isNaN(parsed.getTime()) ? '--:--:--' : parsed.toISOString().slice(11, 19)
}

function systemLine(event: TTYStreamEvent): string {
  const time = timeLabel(event.timestamp)
  switch (event.type) {
    case 'state':
      return `\r\n\x1b[38;5;81m[${time}]\x1b[0m \x1b[1mSTATE\x1b[0m ${event.payload.state}\r\n`
    case 'metric':
      return `\r\n\x1b[38;5;81m[${time}]\x1b[0m \x1b[36mMETRIC\x1b[0m ${event.payload.name}=${event.payload.value}\r\n`
    case 'completion':
      return `\r\n\x1b[38;5;112m[${time}]\x1b[0m \x1b[1;32mCOMPLETION\x1b[0m ${event.payload.state}${event.payload.exitCode === null ? '' : ` exit=${event.payload.exitCode}`}\r\n`
    case 'error':
      return `\r\n\x1b[38;5;203m[${time}] ERROR\x1b[0m ${event.payload.message}\r\n`
    case 'heartbeat':
      return ''
    case 'stdout':
    case 'stderr':
      return event.payload.text
  }
}

export function renderTTYStreamEvent(event: TTYStreamEvent, writer: TTYTerminalWriter, lastSequence: number): TTYRenderResult {
  if (event.sequence <= lastSequence) return { rendered: false, duplicate: true, gap: false }
  const gap = lastSequence > 0 && event.sequence > lastSequence + 1
  writer.write(systemLine(event))
  return { rendered: true, duplicate: false, gap }
}

export class TTYTerminalRenderer {
  private lastSequence = 0

  constructor(private readonly writer: TTYTerminalWriter) {}

  render(event: TTYStreamEvent): TTYRenderResult {
    const result = renderTTYStreamEvent(event, this.writer, this.lastSequence)
    if (result.rendered) this.lastSequence = event.sequence
    return result
  }

  reset(): void {
    this.lastSequence = 0
  }

  get sequence(): number {
    return this.lastSequence
  }
}

