import { auth, currentUser } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import Razorpay from 'razorpay'
import { getCanonicalEntitlement } from '@/lib/canonical-entitlement'
import { PRICING } from '@/lib/pricing.config'
import { createSupabaseAdminClient } from '@/lib/supabase-admin'

export const runtime = 'nodejs'

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const { userId } = await auth()
    const user = await currentUser()
    if (!userId || !user) {
      return NextResponse.json({ error: 'Unauthorized access.' }, { status: 401 })
    }

    const razorpayKeyId = process.env.RAZORPAY_KEY_ID ?? process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID
    const razorpaySecret = process.env.RAZORPAY_KEY_SECRET
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!razorpayKeyId || !razorpaySecret || !supabaseUrl || !supabaseServiceRoleKey) {
      return NextResponse.json({ error: 'Payment service is not configured.' }, { status: 503 })
    }

    const body: unknown = await req.json()
    const requestedTier =
      typeof body === 'object' && body !== null && 'tier' in body
        ? String((body as { tier?: unknown }).tier)
            .trim()
            .toLowerCase()
        : ''
    if (!Object.prototype.hasOwnProperty.call(PRICING, requestedTier)) {
      return NextResponse.json({ error: 'Invalid tier.' }, { status: 400 })
    }

    const tier = requestedTier as keyof typeof PRICING
    const entitlement = await getCanonicalEntitlement(createSupabaseAdminClient(), userId)
    if (entitlement.active && entitlement.tier === tier) {
      return NextResponse.json(
        { error: `You already have an active ${tier.toUpperCase()} subscription.` },
        { status: 409 },
      )
    }

    const razorpay = new Razorpay({ key_id: razorpayKeyId, key_secret: razorpaySecret })
    const order = await razorpay.orders.create({
      amount: PRICING[tier].pricePaise,
      currency: 'INR',
      receipt: `rcpt_${userId.slice(0, 10)}_${Date.now().toString().slice(-8)}`,
      notes: {
        clerkUserId: userId,
        requestedTier: tier,
      },
    })

    return NextResponse.json({
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      tier,
      keyId: razorpayKeyId,
      userMeta: {
        name: user.fullName || 'Hexical Operative',
        email: user.primaryEmailAddress?.emailAddress || '',
      },
    })
  } catch (error: unknown) {
    console.error('[RAZORPAY_ORDER_FATAL]', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to establish secure payment channel.' },
      { status: 500 },
    )
  }
}
