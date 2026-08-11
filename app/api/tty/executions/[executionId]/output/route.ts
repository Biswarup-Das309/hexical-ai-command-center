import { auth } from '@clerk/nextjs/server'
import { createTTYExecutionBrowserApiForRequest } from '@/lib/tty/tty-execution-browser-server'
import type { TTYExecutionId } from '@/lib/tty/tty-types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
  })
}

export async function GET(_request: Request, context: { params: Promise<{ executionId: string }> }): Promise<Response> {
  const { userId } = await auth()
  if (!userId) return json({ ok: false, code: 'UNAUTHENTICATED', message: 'Authentication is required.' }, 401)

  const { executionId: rawExecutionId } = await context.params
  if (!UUID_PATTERN.test(rawExecutionId))
    return json({ ok: false, code: 'INVALID_EXECUTION_ID', message: 'The execution identifier is invalid.' }, 400)

  try {
    const executionId = rawExecutionId as TTYExecutionId
    const api = createTTYExecutionBrowserApiForRequest()
    const execution = await api.getExecution(executionId, userId)
    if (!execution)
      return json({ ok: false, code: 'EXECUTION_NOT_FOUND', message: 'The execution was not found.' }, 404)
    const events = await api.getOutput(executionId, userId, { count: 20_000 })
    return json({ ok: true, execution, events: events ?? [] })
  } catch {
    return json(
      { ok: false, code: 'OUTPUT_UNAVAILABLE', message: 'Saved execution output is temporarily unavailable.' },
      503,
    )
  }
}
