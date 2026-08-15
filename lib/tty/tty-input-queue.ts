/** Serialize browser PTY writes so xterm keystrokes cannot overtake one another. */

export interface TTYInputQueue {
  enqueue(data: string): Promise<void>
  reset(): void
}

const FLUSH_DELAY_MS = 20

export function createTTYInputQueue(send: (data: string) => Promise<void>): TTYInputQueue {
  let tail = Promise.resolve()
  let pendingData = ''
  let pendingWaiters: Array<{ resolve(): void; reject(error: unknown): void }> = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    flushTimer = null
    if (pendingWaiters.length === 0) return
    const data = pendingData
    const waiters = pendingWaiters
    pendingData = ''
    pendingWaiters = []
    const next = tail.then(() => send(data))
    tail = next.catch(() => undefined)
    void next.then(
      () => waiters.forEach(({ resolve }) => resolve()),
      (error) => waiters.forEach(({ reject }) => reject(error)),
    )
  }

  return {
    enqueue(data) {
      if (!data) return Promise.resolve()
      pendingData += data
      const result = new Promise<void>((resolve, reject) => pendingWaiters.push({ resolve, reject }))
      if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_DELAY_MS)
      return result
    },
    reset() {
      if (flushTimer !== null) clearTimeout(flushTimer)
      flushTimer = null
      const error = new Error('PTY input queue reset.')
      pendingWaiters.forEach(({ reject }) => reject(error))
      pendingData = ''
      pendingWaiters = []
      tail = Promise.resolve()
    },
  }
}
