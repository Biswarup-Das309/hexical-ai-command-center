import { createTTYSessionRuntimeApiForRequest } from '@/lib/tty/tty-session-runtime-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ sessionId: string }> }): Promise<Response> {
  const { sessionId } = await context.params
  return createTTYSessionRuntimeApiForRequest().replay(request, sessionId)
}
