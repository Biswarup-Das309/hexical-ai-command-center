import { auth } from '@clerk/nextjs/server'
import { z } from 'zod'
import { createSupabaseRuntimeStore } from '@/lib/tty/supabase-runtime-store'
import { repairTTYExecution } from '@/lib/tty/tty-execution-activator-server'
import { createTTYSessionStore } from '@/lib/tty/tty-session-store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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
  const parsed = BODY_SCHEMA.safeParse(await request.json().catch(() => null))
  if (!parsed.success)
    return json({ ok: false, code: 'INVALID_INPUT', message: 'A valid session id is required.' }, 400)
  const params = await context.params
  const session = await createTTYSessionStore(createSupabaseRuntimeStore()).getSession(
    parsed.data.sessionId as never,
    userId,
  )
  if (!session)
    return json({ ok: false, code: 'SESSION_NOT_FOUND', message: 'The execution session was not found.' }, 404)
  if (session.status !== 'active' && session.status !== 'idle')
    return json({ ok: false, code: 'SESSION_NOT_ACTIVE', message: 'The execution session is no longer active.' }, 409)
  const result = await repairTTYExecution(params.executionId, parsed.data.sessionId)
  if (!result.state)
    return json({ ok: false, code: 'EXECUTION_NOT_FOUND', message: 'The execution was not found.' }, 404)
  return json(
    {
      ok: true,
      repaired: result.repaired,
      state: result.state.state,
      executionId: result.state.executionId,
      sessionId: result.state.sessionId,
    },
    200,
  )
}
