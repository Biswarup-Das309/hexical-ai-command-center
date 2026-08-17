/**
 * Serialize browser PTY writes so xterm keystrokes cannot overtake one
 * another, while coalescing bursts into small, bounded batches.  This queue is
 * deliberately transport-agnostic: durability and authorization remain in
 * the server control route, but the browser never waits 100ms before handing
 * a printable burst to that route.
 */

export interface TTYInputBatch {
  readonly data: string
  readonly sequence: number
  readonly inputEventId: string
  readonly browserTimestampMs: number
  readonly flushedAtMs: number
  readonly queueWaitMs: number
}

export interface TTYInputQueueOptions {
  readonly now?: () => number
  readonly onBatch?: (batch: TTYInputBatch) => void
}

export interface TTYInputQueue {
  enqueue(data: string): Promise<void>
  reset(): void
}

const MAX_BATCH_DELAY_MS = 4
const MAX_BATCH_BYTES = 32 * 1024

function inputEventId(sequence: number, timestampMs: number): string {
  const randomUuid = globalThis.crypto?.randomUUID
  if (typeof randomUuid === 'function') return randomUuid.call(globalThis.crypto)
  return `tty-input-${timestampMs.toString(36)}-${sequence.toString(36)}`
}

function isImmediateInput(data: string): boolean {
  // Enter, control bytes, and terminal escape sequences must not wait for the
  // printable-key micro-batch window.  This preserves shell control behavior
  // without interpreting or rewriting the bytes.
  return /[\r\n\u0000-\u001f\u007f\u001b]/u.test(data)
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function createTTYInputQueue(
  send: (data: string, batch: TTYInputBatch) => Promise<void>,
  options: TTYInputQueueOptions = {},
): TTYInputQueue {
  const now = options.now ?? (() => Date.now())
  let tail = Promise.resolve()
  let pendingData = ''
  let pendingStartedAtMs = 0
  let sequence = 0
  let pendingWaiters: Array<{ resolve(): void; reject(error: unknown): void }> = []
  let microtaskScheduled = false
  let maxFlushTimer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    if (maxFlushTimer !== null) clearTimeout(maxFlushTimer)
    microtaskScheduled = false
    maxFlushTimer = null
    if (pendingWaiters.length === 0) return
    const data = pendingData
    const enqueuedAtMs = pendingStartedAtMs || now()
    const waiters = pendingWaiters
    pendingData = ''
    pendingStartedAtMs = 0
    pendingWaiters = []
    const flushedAtMs = now()
    const batch: TTYInputBatch = Object.freeze({
      data,
      sequence: (sequence += 1),
      inputEventId: inputEventId(sequence, enqueuedAtMs),
      browserTimestampMs: enqueuedAtMs,
      flushedAtMs,
      queueWaitMs: Math.max(0, flushedAtMs - enqueuedAtMs),
    })
    options.onBatch?.(batch)
    const next = tail.then(() => send(data, batch))
    tail = next.catch(() => undefined)
    void next.then(
      () => waiters.forEach(({ resolve }) => resolve()),
      (error) => waiters.forEach(({ reject }) => reject(error)),
    )
  }

  return {
    enqueue(data) {
      if (!data) return Promise.resolve()
      if (pendingData.length === 0) pendingStartedAtMs = now()
      pendingData += data
      const result = new Promise<void>((resolve, reject) => pendingWaiters.push({ resolve, reject }))
      // A microtask batches synchronous xterm/paste bursts and avoids the
      // 15ms Windows timer floor.  The watchdog bounds a continuously busy
      // event source without imposing a visible debounce on human typing.
      if (!microtaskScheduled) {
        microtaskScheduled = true
        queueMicrotask(flush)
      }
      if (maxFlushTimer === null) maxFlushTimer = setTimeout(flush, MAX_BATCH_DELAY_MS)
      if (isImmediateInput(data) || utf8Bytes(pendingData) >= MAX_BATCH_BYTES) flush()
      return result
    },
    reset() {
      if (maxFlushTimer !== null) clearTimeout(maxFlushTimer)
      microtaskScheduled = false
      maxFlushTimer = null
      const error = new Error('PTY input queue reset.')
      pendingWaiters.forEach(({ reject }) => reject(error))
      pendingData = ''
      pendingWaiters = []
      tail = Promise.resolve()
    },
  }
}
