export const VERIFY_REQUEST_DEADLINE_MS = 75_000

export class RequestDeadlineExceeded extends Error {
  readonly code = 'REQUEST_DEADLINE_EXCEEDED'

  constructor(message = 'The investigation exceeded its server execution deadline.') {
    super(message)
    this.name = 'RequestDeadlineExceeded'
  }
}

export function isRequestDeadlineExceeded(value: unknown): value is RequestDeadlineExceeded {
  return (
    value instanceof RequestDeadlineExceeded || (value instanceof Error && value.name === 'RequestDeadlineExceeded')
  )
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error ? signal.reason : new RequestDeadlineExceeded()
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal)
}

export interface RequestDeadlineHandle {
  readonly signal: AbortSignal
  dispose(): void
}

/**
 * Creates one request-scoped cancellation signal. The parent request signal
 * aborts the same scope, while the bounded timer prevents provider retries,
 * fallback calls, and post-processing from running indefinitely.
 */
export function createRequestDeadline(
  parentSignal: AbortSignal | undefined,
  budgetMs = VERIFY_REQUEST_DEADLINE_MS,
): RequestDeadlineHandle {
  const controller = new AbortController()
  const timeoutMs = Math.max(1, Math.floor(budgetMs))
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort(new RequestDeadlineExceeded())
  }, timeoutMs)

  const onParentAbort = () => controller.abort(abortReason(parentSignal as AbortSignal))
  if (parentSignal?.aborted) onParentAbort()
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true })

  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return
      disposed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      parentSignal?.removeEventListener('abort', onParentAbort)
    },
  }
}

export function sleepWithSignal(ms: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal)
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(
      () => {
        settled = true
        signal?.removeEventListener('abort', onAbort)
        resolve()
      },
      Math.max(0, Math.floor(ms)),
    )
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortReason(signal as AbortSignal))
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}
