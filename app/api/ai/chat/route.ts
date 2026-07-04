import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { aiGateway } from '@/lib/ai-gateway'
import { getUserTier } from '@/lib/get-user-tier'

export async function POST(req: Request) {
  // Real identity, from the verified session — never from the body.
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Real tier, from your billing/subscription source of truth —
  // never from the body. See lib/get-user-tier.ts.
  const tier = await getUserTier(userId)

  try {
    const result = await aiGateway(userId, tier, body)

    if (result.blocked) {
      return NextResponse.json(
        { blocked: true, reason: result.reason },
        { status: 429 }
      )
    }
    return NextResponse.json(result)
  } catch (err) {
    // Log the real error server-side; never hand raw error internals
    // back to the client.
    console.error('[api/ai/chat] unhandled error', err)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }
}