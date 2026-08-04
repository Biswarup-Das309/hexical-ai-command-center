import { createTTYLifecycleApiForRequest } from '@/lib/tty/tty-lifecycle-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface SessionRouteContext {
  readonly params: Promise<{ readonly sessionId: string }>
}

export async function POST(request: Request, context: SessionRouteContext): Promise<Response> {
  const { sessionId } = await context.params
  return createTTYLifecycleApiForRequest().touch(request, sessionId)
}
