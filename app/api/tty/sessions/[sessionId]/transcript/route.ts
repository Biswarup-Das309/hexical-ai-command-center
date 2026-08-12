import { log, requestCorrelationId } from '@/lib/hexical/telemetry'
import { createTTYSessionRuntimeApiForRequest } from '@/lib/tty/tty-session-runtime-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ sessionId: string }> }): Promise<Response> {
  const { sessionId } = await context.params
  const correlationId = requestCorrelationId(request)
  const startedAt = Date.now()
  const response = await createTTYSessionRuntimeApiForRequest().replay(request, sessionId)
  const search = new URL(request.url).searchParams
  log.info('tty.transcript.replay', {
    sessionId,
    status: response.status,
    durationMs: Math.max(0, Date.now() - startedAt),
    hasCursor: search.has('after'),
    requestedLimit: search.get('limit'),
    correlationId,
  })
  return response
}
