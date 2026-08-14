/** Serialize browser PTY writes so xterm keystrokes cannot overtake one another. */

export interface TTYInputQueue {
  enqueue(data: string): Promise<void>
  reset(): void
}

export function createTTYInputQueue(send: (data: string) => Promise<void>): TTYInputQueue {
  let tail = Promise.resolve()

  return {
    enqueue(data) {
      const next = tail.then(() => send(data))
      // A failed request must not strand every later keystroke behind it.
      tail = next.catch(() => undefined)
      return next
    },
    reset() {
      tail = Promise.resolve()
    },
  }
}
