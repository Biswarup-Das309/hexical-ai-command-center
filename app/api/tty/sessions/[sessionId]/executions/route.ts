import { createTTYAdmissionApiForRequest } from '@/lib/tty/tty-execution-admission-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }): Promise<Response> {
  const { sessionId } = await context.params
  return createTTYAdmissionApiForRequest().admit(request, sessionId)
}
