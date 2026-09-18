const RECOVERABLE_TTY_SESSION_CODES = new Set(['SESSION_NOT_FOUND', 'SESSION_NOT_ACTIVE', 'SESSION_TERMINATED'])
const RETRYABLE_TTY_SESSION_OPEN_CODES = new Set(['SESSION_NOT_FOUND', 'SESSION_NOT_ACTIVE'])

/**
 * A newly-created session is durable before the worker has necessarily
 * published its runtime lease. Keep the browser's durable open bounded while
 * that handoff completes instead of immediately replacing the session again.
 */
export const TTY_SESSION_OPEN_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const

export function isRecoverableTTYSessionCode(code: string | null): boolean {
  return code !== null && RECOVERABLE_TTY_SESSION_CODES.has(code)
}

export function isRetryableTTYSessionOpenCode(code: string | null): boolean {
  return code !== null && RETRYABLE_TTY_SESSION_OPEN_CODES.has(code)
}
