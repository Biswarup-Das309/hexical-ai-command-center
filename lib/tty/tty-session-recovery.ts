const RECOVERABLE_TTY_SESSION_CODES = new Set(['SESSION_NOT_FOUND', 'SESSION_NOT_ACTIVE', 'SESSION_TERMINATED'])

export function isRecoverableTTYSessionCode(code: string | null): boolean {
  return code !== null && RECOVERABLE_TTY_SESSION_CODES.has(code)
}
