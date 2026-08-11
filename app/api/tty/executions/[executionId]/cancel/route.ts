import { auth } from '@clerk/nextjs/server'
import { Redis } from '@upstash/redis'
import { z } from 'zod'
import { cancelTTYExecution } from '@/lib/tty/tty-execution-activator-server'
import { createTTYSessionStore } from '@/lib/tty/tty-session-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BODY_SCHEMA = z.object({ sessionId: z.string().uuid() }).strict()
const HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  'Content-Type': 'application/json',
} as const

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS })
}

export async function POST(request: Request, context: { params: Promise<{ executionId: string }> }): Promise<Response> {
  const userId = (await auth()).userId
  if (!userId) return json({ ok: false, code: 'UNAUTHENTICATED', message: 'Authentication is required.' }, 401)

  const { executionId } = await context.params
  if (!UUID_PATTERN.test(executionId))
    return json({ ok: false, code: 'INVALID_EXECUTION_ID', message: 'The execution identifier is invalid.' }, 400)
  const parsed = BODY_SCHEMA.safeParse(await request.json().catch(() => null))
  if (!parsed.success)
    return json({ ok: false, code: 'INVALID_INPUT', message: 'A valid session id is required.' }, 400)

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token)
    return json({ ok: false, code: 'INTERNAL_ERROR', message: 'Execution cancellation is not configured.' }, 500)

  const session = await createTTYSessionStore(new Redis({ url, token })).getSession(
    parsed.data.sessionId as never,
    userId,
  )
  if (!session)
    return json({ ok: false, code: 'SESSION_NOT_FOUND', message: 'The execution session was not found.' }, 404)
  if (session.status !== 'active' && session.status !== 'idle')
    return json({ ok: false, code: 'SESSION_NOT_ACTIVE', message: 'The execution session is no longer active.' }, 409)

  const result = await cancelTTYExecution(executionId, parsed.data.sessionId)
  if (result.state === null)
    return json({ ok: false, code: 'EXECUTION_NOT_FOUND', message: 'The execution was not found.' }, 404)
  return json(
    {
      ok: true,
      acknowledged: result.acknowledged,
      cancellationPending: !result.acknowledged,
      executionId: result.state.executionId,
      sessionId: result.state.sessionId,
      state: result.state.state,
    },
    result.acknowledged ? 200 : 202,
  )
}
