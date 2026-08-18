import { createTTYSessionInputChannelResponse } from '@/lib/tty/tty-session-input-channel-server'

export async function POST(_request: Request, context: { params: Promise<{ sessionId: string }> }): Promise<Response> {
  const { sessionId } = await context.params
  return createTTYSessionInputChannelResponse(sessionId)
}
