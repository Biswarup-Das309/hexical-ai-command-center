import { createTTYSessionRuntimeApiForRequest } from '@/lib/tty/tty-session-runtime-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }): Promise<Response> {
  const { sessionId } = await context.params
  return createTTYSessionRuntimeApiForRequest().control(request, sessionId)
}
