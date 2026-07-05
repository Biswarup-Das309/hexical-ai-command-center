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
    // Note: the whole handler is already wrapped in try/catch, so a throw
    // here wouldn't crash the process — it'd just fall through to the
    // generic 500 below. The reason to handle it explicitly isn't crash
    // safety, it's correctness of the response code and clean logs: a
    // malformed body is a 400 (client/gateway problem), not a 500
    // (our server broke), and you don't want it paging on-call as
    // "CRITICAL" next to actual infra failures.
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

    // 4. Tier validation — rejects non-strings, unknown tiers, and
    // prototype-chain keys (toString, constructor, __proto__, ...)
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

    // 6. Atomic idempotency + asset injection.
    //
    // The previous version did `insert transaction` then, in a SEPARATE
    // round trip, `update profiles`. If the process died (or Supabase
    // hiccuped) between those two calls, a Razorpay retry would hit the
    // unique-violation branch, return "already_processed", and the user
    // would never receive their tier/tokens — a silent revenue-collected-
    // but-nothing-delivered bug. It also used `.update()`, which no-ops
    // silently if the profile row doesn't exist yet (e.g. a brand-new
    // user whose profile-sync webhook hasn't landed before they pay).
    //
    // Both writes now happen inside one Postgres function so they commit
    // or roll back together, with a row lock so two concurrent webhooks
    // (e.g. a Razorpay retry racing the original delivery) can't both
    // read the same current_period_end and stomp on each other's
    // extension. See supabase/process_payment_webhook.sql.
    const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc('process_payment_webhook', {
      p_payment_id: paymentId,
      p_user_id: clerkUserId,
      p_order_id: orderId ?? null,
      p_tier: targetTier,
      p_tokens: tokenBudget,
      p_period_days: 30,
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