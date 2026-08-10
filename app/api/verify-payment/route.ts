import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import Razorpay from 'razorpay'
import crypto from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'

import { PRICING } from '@/lib/pricing.config'

export const runtime = 'nodejs'

const PaymentVerificationSchema = z.object({
  razorpay_payment_id: z.string().trim().min(8).max(128),
  razorpay_order_id: z.string().trim().min(8).max(128),
  razorpay_signature: z.string().trim().regex(/^[a-f0-9]{64}$/i),
  tier: z.enum(['go', 'plus', 'pro']),
})

function signaturesMatch(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'utf8')
  const receivedBuffer = Buffer.from(received, 'utf8')
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const { userId } = await auth()
    if (!userId) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

    const razorpayKeyId = process.env.RAZORPAY_KEY_ID ?? process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID
    const razorpaySecret = process.env.RAZORPAY_KEY_SECRET
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!razorpayKeyId || !razorpaySecret || !supabaseUrl || !supabaseServiceRoleKey) {
      return NextResponse.json({ error: 'Payment service is not configured.' }, { status: 503 })
    }

    const parsed = PaymentVerificationSchema.safeParse(await req.json())
    if (!parsed.success) return NextResponse.json({ error: 'Invalid payment verification payload.' }, { status: 400 })
    const payment = parsed.data
    const expectedSignature = crypto
      .createHmac('sha256', razorpaySecret)
      .update(`${payment.razorpay_order_id}|${payment.razorpay_payment_id}`)
      .digest('hex')
    if (!signaturesMatch(expectedSignature, payment.razorpay_signature)) {
      return NextResponse.json({ error: 'Invalid payment signature.' }, { status: 400 })
    }

    const razorpay = new Razorpay({ key_id: razorpayKeyId, key_secret: razorpaySecret })
    const [order, paymentDetails] = await Promise.all([
      razorpay.orders.fetch(payment.razorpay_order_id),
      razorpay.payments.fetch(payment.razorpay_payment_id),
    ])
    const orderNotes = order.notes as Record<string, unknown> | undefined
    const expectedAmount = PRICING[payment.tier].pricePaise
    const orderBelongsToUser = orderNotes?.clerkUserId === userId || orderNotes?.userId === userId
    const orderTier = String(orderNotes?.requestedTier ?? orderNotes?.tier ?? '').trim().toLowerCase()
    const paymentCaptured = paymentDetails.status === 'captured'
    if (
      !orderBelongsToUser ||
      orderTier !== payment.tier ||
      order.amount !== expectedAmount ||
      order.currency !== 'INR' ||
      paymentDetails.order_id !== payment.razorpay_order_id ||
      !paymentCaptured
    ) {
      return NextResponse.json({ error: 'Payment could not be matched to this account and plan.' }, { status: 400 })
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey)
    const { data, error } = await supabaseAdmin.rpc('process_payment_webhook', {
      p_payment_id: payment.razorpay_payment_id,
      p_user_id: userId,
      p_order_id: payment.razorpay_order_id,
      p_tier: payment.tier,
      p_tokens: PRICING[payment.tier].tokens,
      p_period_days: 30,
    })
    if (error) throw error

    const result = Array.isArray(data) ? data[0] : data
    return NextResponse.json({
      status: result?.already_processed ? 'already_processed' : 'ok',
      tier: payment.tier,
    })
  } catch (error: unknown) {
    console.error('[RAZORPAY_VERIFY_FATAL]', error)
    return NextResponse.json({ error: 'Payment verification failed.' }, { status: 500 })
  }
}
