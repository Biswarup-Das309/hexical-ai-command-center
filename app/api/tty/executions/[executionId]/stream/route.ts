import { auth } from '@clerk/nextjs/server'

import { log, requestCorrelationId } from '@/lib/hexical/telemetry'

import { createTTYStreamManagerForRequest } from '@/lib/tty/tty-stream-server'
import type { TTYExecutionId, TTYSessionId } from '@/lib/tty/tty-types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function jsonFailure(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, code, message }), {
    status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }
  })
}

export async function GET(request: Request, context: { params: Promise<{ executionId: string }> }): Promise<Response> {
  const correlationId = requestCorrelationId(request)
  try {
    const { userId } = await auth()
    if (!userId) return jsonFailure(401, 'UNAUTHENTICATED', 'Authentication is required.')

    const { executionId: rawExecutionId } = await context.params
    if (!UUID_PATTERN.test(rawExecutionId)) return jsonFailure(400, 'INVALID_EXECUTION_ID', 'The execution identifier is invalid.')
    const executionId = rawExecutionId as TTYExecutionId
    const requestedSessionIdRaw = new URL(request.url).searchParams.get('sessionId')
    if (requestedSessionIdRaw !== null && !UUID_PATTERN.test(requestedSessionIdRaw)) return jsonFailure(400, 'INVALID_SESSION_ID', 'The session identifier is invalid.')

    const manager = createTTYStreamManagerForRequest()
    const queryLastEventId = new URL(request.url).searchParams.get('lastEventId')
    const result = await manager.open({
      userId,
      executionId,
      requestedSessionId: requestedSessionIdRaw === null ? undefined : requestedSessionIdRaw as TTYSessionId,
      // EventSource cannot set arbitrary headers.  The browser hook uses the
      // bounded query cursor on reconnect; native EventSource clients still
      // use Last-Event-ID when available.
      lastEventId: request.headers.get('Last-Event-ID') ?? queryLastEventId,
      signal: request.signal
    })
    result.response.headers.set('X-Correlation-ID', correlationId)
    log.info('tty.stream.opened', {
      executionId,
      sessionId: requestedSessionIdRaw,
      accepted: result.accepted,
      reason: result.accepted ? null : result.reason,
      status: result.response.status,
      correlationId
    })
    return result.response
  } catch (error) {
    log.error('tty.stream.open_failed', { correlationId, errorCode: error instanceof Error ? error.name : 'unknown_error' })
    return jsonFailure(500, 'STREAM_UNAVAILABLE', 'The execution stream is temporarily unavailable.')
  }
}
