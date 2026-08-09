import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { cookies } from 'next/headers'
import { randomUUID } from 'crypto'
import { aiGateway } from '@/lib/ai-gateway'
import { getUserTier } from '@/lib/get-user-tier'
import type { PlanTier } from '@/lib/plans'

const MAX_BODY_BYTES = 100_000

type ApiErrorReason =
  | 'invalid_request'
  | 'unauthorized'
  | 'tier_not_found'
  | 'rate_limited'
  | 'usage_check_failed'
  | 'limits_not_configured'
  | 'daily_budget_exceeded'
  | 'daily_request_limit_exceeded'
  | 'model_call_failed'
  | 'internal_error'

function mapStatus(reason?: string): number {
  switch (reason as ApiErrorReason) {
    case 'invalid_request':
      return 400
    case 'unauthorized':
      return 401
    case 'tier_not_found':
      return 403
    case 'daily_budget_exceeded':
    case 'daily_request_limit_exceeded':
    case 'rate_limited':
      return 429
    case 'model_call_failed':
      return 502
    case 'usage_check_failed':
    case 'limits_not_configured':
    case 'internal_error':
      return 500
    default:
      return 429
  }
}

/**
 * Proper guest identity system (cookie-based, per user)
 */
async function getGuestId() {
  const cookieStore = await cookies()

  let guestId = cookieStore.get('guest_id')?.value

  if (!guestId) {
    guestId = randomUUID()

    cookieStore.set('guest_id', guestId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
      maxAge: 60 * 60 * 24 * 30 // 30 days
    })
  }

  return guestId
}

export async function POST(req: Request) {
  const { userId } = await auth()

  const isGuest = !userId
  const actualUserId = userId ?? await getGuestId()

  // 1. Size check BEFORE parsing
  const contentLength = Number(req.headers.get('content-length') ?? 0)
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      { ok: false, error: 'invalid_request' },
      { status: 413 }
    )
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid_request' },
      { status: 400 }
    )
  }

  // 2. Secondary size guard
  if (JSON.stringify(body).length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { ok: false, error: 'invalid_request' },
      { status: 413 }
    )
  }

  // 3. Tier logic
  let tier: PlanTier = 'go' // default for guests

  if (!isGuest) {
    try {
      const fetchedTier = await getUserTier(userId)
      if (fetchedTier) tier = fetchedTier
      else {
        return NextResponse.json(
          { ok: false, error: 'tier_not_found' },
          { status: 403 }
        )
      }
    } catch (err) {
      console.error('[api/ai/chat] tier lookup failed', err)
      return NextResponse.json(
        { ok: false, error: 'tier_not_found' },
        { status: 403 }
      )
    }
  }

  const clientIp =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

  try {
    const result = await aiGateway(actualUserId, tier, body, clientIp)

    if (result.blocked) {
      return NextResponse.json(
        {
          ok: false,
          blocked: true,
          reason: result.reason ?? 'rate_limited',
          guest: isGuest
        },
        { status: mapStatus(result.reason) }
      )
    }

    return NextResponse.json(
      {
        ok: true,
        blocked: false,
        model: result.model,
        response: result.response,
        guest: isGuest
      },
      { status: 200 }
    )
  } catch (err) {
    console.error('[api/ai/chat] unhandled error', err)
    return NextResponse.json(
      { ok: false, error: 'internal_error' },
      { status: 500 }
    )
  }
}
