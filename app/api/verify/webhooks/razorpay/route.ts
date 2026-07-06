// app/api/webhooks/razorpay/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { PRICING } from '@/lib/pricing.config';

function normalizeTier(requestedTier: unknown): string | null {
  if (typeof requestedTier !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(PRICING, requestedTier)) return null;
  return requestedTier;
}

export async function POST(req: Request) {
  try {
    // 1. Lazy env checks — fail fast, before touching any client
    const {
      NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      RAZORPAY_WEBHOOK_SECRET,
    } = process.env;

    if (!NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('FATAL: Missing Supabase infrastructure keys.');
    }
    if (!RAZORPAY_WEBHOOK_SECRET) {
      throw new Error('FATAL: Missing Razorpay Webhook Secret.');
    }

    const supabaseAdmin = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const bodyText = await req.text();
    const signature = req.headers.get('x-razorpay-signature');

    if (!signature) {
      return NextResponse.json({ error: 'Missing cryptographic signature' }, { status: 401 });
    }

    // 2. Signature verification on the RAW body, before any parsing
    const expectedSignature = crypto
      .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
      .update(bodyText)
      .digest('hex');

    if (signature.length !== expectedSignature.length) {
      console.warn('[WEBHOOK_WARNING]: Signature length mismatch rejected.');
      return NextResponse.json({ error: 'Invalid signature length' }, { status: 400 });
    }

    const isSignatureValid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );

    if (!isSignatureValid) {
      console.warn('[WEBHOOK_WARNING]: Signature mismatch detected.');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }

    // 3. Safe JSON parse — only after the signature is trusted.
    let event: any;
    try {
      event = JSON.parse(bodyText);
    } catch {
      console.warn('[WEBHOOK_WARNING]: Malformed JSON body after valid signature.');
      return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    if (event?.event !== 'payment.captured' && event?.event !== 'order.paid') {
      return NextResponse.json({ status: 'ok' });
    }

    const paymentEntity = event?.payload?.payment?.entity;
    if (!paymentEntity) {
      console.error('[WEBHOOK_ERROR]: Missing payment entity in payload.');
      return NextResponse.json({ status: 'ignored', reason: 'malformed_payload' }, { status: 200 });
    }

    const paymentId: string | undefined = paymentEntity.id;
    const orderId: string | undefined = paymentEntity.order_id;
    const amountPaid: unknown = paymentEntity.amount;

    const notes = paymentEntity.notes || {};
    const { clerkUserId, requestedTier } = notes;

    if (!paymentId || !clerkUserId || typeof clerkUserId !== 'string' || !requestedTier) {
      console.error(`[WEBHOOK_ERROR]: Missing vital routing notes for payment ${paymentId ?? 'unknown'}`);
      return NextResponse.json({ status: 'ignored', reason: 'malformed_payload' }, { status: 200 });
    }

    // 4. Tier validation
    const targetTier = normalizeTier(requestedTier);
    if (!targetTier) {
      console.warn(`[WEBHOOK_WARNING]: Invalid tier "${String(requestedTier)}" for payment ${paymentId}`);
      return NextResponse.json({ status: 'ignored', reason: 'invalid_tier' }, { status: 200 });
    }

    // 5. Single source of truth for pricing + tokens
    const expectedAmount = PRICING[targetTier as keyof typeof PRICING].pricePaise;
    const tokenBudget = PRICING[targetTier as keyof typeof PRICING].tokens;

    if (typeof amountPaid !== 'number' || !Number.isFinite(amountPaid) || amountPaid < expectedAmount) {
      console.error(
        `[WEBHOOK_FRAUD]: User ${clerkUserId} paid ${String(amountPaid)} for ${targetTier} (expected >= ${expectedAmount})`
      );
      return NextResponse.json({ status: 'ignored', reason: 'price_mismatch' }, { status: 200 });
    }

    // 6. Atomic idempotency + asset injection via single RPC call.
    // The RPC function inside Supabase will handle the tier, tokens, AND the 30-day expiration.
    const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc('process_payment_webhook', {
      p_payment_id: paymentId,
      p_user_id: clerkUserId,
      p_order_id: orderId ?? null,
      p_tier: targetTier,
      p_tokens: tokenBudget,
      p_period_days: 30, // <--- This tells the database to calculate the expiration!
    });

    if (rpcError) {
      console.error(`[SUPABASE_ERROR]: process_payment_webhook failed for ${clerkUserId}`, rpcError);
      throw rpcError;
    }

    if (rpcResult?.[0]?.already_processed) {
      console.log(`[WEBHOOK_IDEMPOTENCY]: Payment ${paymentId} already processed.`);
      return NextResponse.json({ status: 'already_processed' });
    }

    console.log(`[WEBHOOK_SUCCESS]: User ${clerkUserId} upgraded to ${targetTier}. ${tokenBudget} tokens injected.`);
    return NextResponse.json({ status: 'ok' });
    
  } catch (err: any) {
    console.error('[WEBHOOK_CRITICAL_ERROR]:', err);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}