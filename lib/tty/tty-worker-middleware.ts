import type { TTYWorkerAuthenticator, TTYWorkerAuthFailureReason } from './tty-worker-auth'
import type { TTYWorkerCapability, TTYWorkerAuthContext } from './tty-worker-types'

const WORKER_AUTH_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'Content-Type': 'application/json',
} as const

export type TTYWorkerMiddlewareResult =
  | { readonly authorized: true; readonly context: TTYWorkerAuthContext }
  | { readonly authorized: false; readonly response: Response }

function authFailure(reason: TTYWorkerAuthFailureReason): Response {
  const status = reason === 'inactive_worker' || reason === 'offline_worker' ? 403 : 401
  return new Response(
    JSON.stringify({ ok: false, code: 'WORKER_AUTHENTICATION_FAILED', message: 'Worker authentication failed.' }),
    {
      status,
      headers: WORKER_AUTH_HEADERS,
    },
  )
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization')
  if (authorization === null) return null
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization.trim())
  return match?.[1] ?? null
}

export function createTTYWorkerMiddleware(authenticator: Pick<TTYWorkerAuthenticator, 'authenticateWorker'>) {
  return {
    async authenticate(request: Request, requiredCapability?: TTYWorkerCapability): Promise<TTYWorkerMiddlewareResult> {
      const token = bearerToken(request)
      if (token === null) return { authorized: false, response: authFailure('invalid_token') }
      const result = await authenticator.authenticateWorker(token, requiredCapability)
      if (!result.authenticated) return { authorized: false, response: authFailure(result.reason) }
      return { authorized: true, context: result.context }
    },
  }
}

export type TTYWorkerMiddleware = ReturnType<typeof createTTYWorkerMiddleware>
