/**
 * Vercel/serverless application instances must only admit durable work. A
 * separate worker owns process execution in production; direct activation is
 * retained for local development and explicit single-process smoke tests.
 */
export function usesDirectTTYActivation(): boolean {
  const configured = process.env.TTY_DIRECT_ACTIVATION?.trim().toLowerCase()
  if (configured === 'true') return true
  if (configured === 'false') return false
  return process.env.NODE_ENV !== 'production'
}
