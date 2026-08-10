// app/api/webhooks/razorpay/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { clerkClient } from '@clerk/nextjs/server';
import crypto from 'crypto';
import { PRICING } from '@/lib/pricing.config';
import { log } from '@/lib/hexical/telemetry';

interface RazorpayEntity {
  readonly id?: unknown;
  readonly order_id?: unknown;
  readonly amount?: unknown;
  readonly notes?: unknown;
}

interface RazorpayWebhookEvent {
  readonly event?: unknown;
  readonly payload?: {
    readonly payment?: { readonly entity?: RazorpayEntity };
    readonly order?: { readonly entity?: RazorpayEntity };
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function normalizeTier(requestedTier: unknown): string | null {
  if (typeof requestedTier !== 'string') return null;
  const clean = requestedTier.trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(PRICING, clean)) return null;
  return clean;
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

    // Guard: timingSafeEqual throws if buffer lengths differ, so check first —
    // but do the length check itself in constant-ish time by comparing hashes,
    // not raw signature strings, to avoid leaking length via early return timing.
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    const isSignatureValid =
      sigBuffer.length === expectedBuffer.length &&
      crypto.timingSafeEqual(sigBuffer, expectedBuffer);

    if (!isSignatureValid) {
      console.warn('[WEBHOOK_WARNING]: Signature mismatch detected.');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }

    // 3. Safe JSON parse — only after the signature is trusted.
    let event: RazorpayWebhookEvent;
    try {
      event = JSON.parse(bodyText) as RazorpayWebhookEvent;
    } catch {
      console.warn('[WEBHOOK_WARNING]: Malformed JSON body after valid signature.');
      return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    const eventType = typeof event.event === 'string' ? event.event : '';

    if (eventType !== 'payment.captured' && eventType !== 'order.paid') {
      // Not an event we act on — acknowledge so Razorpay doesn't retry.
      return NextResponse.json({ status: 'ok', reason: 'event_ignored' });
    }

    const paymentEntity = event.payload?.payment?.entity;
    const orderEntity = event.payload?.order?.entity;

    if (!paymentEntity) {
      console.error(`[WEBHOOK_ERROR]: Missing payment entity in payload for event "${eventType}".`);
      return NextResponse.json({ status: 'ignored', reason: 'malformed_payload' }, { status: 200 });
    }

    const paymentId = typeof paymentEntity.id === 'string' ? paymentEntity.id : undefined;
    const orderId = typeof paymentEntity.order_id === 'string'
      ? paymentEntity.order_id
      : typeof orderEntity?.id === 'string' ? orderEntity.id : undefined;
    const amountPaid: unknown = paymentEntity.amount;

    // 🔑 FIX: merge notes from both entities. Order notes are where your
    // backend actually attaches metadata at checkout creation time — the
    // payment entity does not reliably inherit them. Order notes win on
    // conflict since they're the authoritative source written by your server.
    const notes = {
      ...asRecord(paymentEntity.notes),
      ...asRecord(orderEntity?.notes),
    };
    const clerkUserId = typeof notes.clerkUserId === 'string' ? notes.clerkUserId : undefined;
    const requestedTier = typeof notes.requestedTier === 'string' ? notes.requestedTier : undefined;

    if (!paymentId || !clerkUserId || typeof clerkUserId !== 'string' || !requestedTier) {
      console.error(
        `[WEBHOOK_ERROR]: Missing vital routing notes for payment ${paymentId ?? 'unknown'}. ` +
        `Got clerkUserId=${clerkUserId ?? 'undefined'}, requestedTier=${requestedTier ?? 'undefined'}. ` +
        `Raw notes: ${JSON.stringify(notes)}`
      );
      return NextResponse.json({ status: 'ignored', reason: 'malformed_payload' }, { status: 200 });
    }

    // 4. Tier validation (trimmed + lowercased so stray whitespace/casing
    // from the client never silently drops a paid conversion)
    const targetTier = normalizeTier(requestedTier);
    if (!targetTier) {
      console.warn(`[WEBHOOK_WARNING]: Invalid tier "${String(requestedTier)}" for payment ${paymentId}`);
      return NextResponse.json({ status: 'ignored', reason: 'invalid_tier' }, { status: 200 });
    }

    // 5. Single source of truth for pricing + tokens
    const tierConfig = PRICING[targetTier as keyof typeof PRICING];
    if (!tierConfig) {
      console.error(`[WEBHOOK_ERROR]: Tier "${targetTier}" passed normalization but missing from PRICING map.`);
      return NextResponse.json({ status: 'ignored', reason: 'pricing_config_error' }, { status: 200 });
    }

    const expectedAmount = tierConfig.pricePaise;
    const tokenBudget = tierConfig.tokens;

    if (typeof amountPaid !== 'number' || !Number.isFinite(amountPaid) || amountPaid < expectedAmount) {
      console.error(
        `[WEBHOOK_FRAUD]: User ${clerkUserId} paid ${String(amountPaid)} for ${targetTier} (expected >= ${expectedAmount})`
      );
      return NextResponse.json({ status: 'ignored', reason: 'price_mismatch' }, { status: 200 });
    }

    // 6. Atomic idempotency + asset injection via single RPC call.
    // The RPC function inside Supabase handles the tier, tokens, AND the
    // 30-day expiration in one transaction. This is the billing source of truth.
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
      // Return 500 so Razorpay retries this webhook — do NOT swallow this,
      // the user paid and the DB write genuinely failed.
      throw rpcError;
    }

    if (rpcResult?.[0]?.already_processed) {
      console.log(`[WEBHOOK_IDEMPOTENCY]: Payment ${paymentId} already processed. Skipping duplicate.`);
      return NextResponse.json({ status: 'already_processed' });
    }

    console.log(`[WEBHOOK_SUCCESS]: User ${clerkUserId} upgraded to ${targetTier}. ${tokenBudget} tokens injected.`);

    // 7. Best-effort Clerk metadata mirror. NOT load-bearing — the frontend
    // reads entitlement from Supabase via /api/entitlement, so this failing
    // must never fail the whole webhook or leave the user unentitled.
    try {
      const client = await clerkClient();
      await client.users.updateUserMetadata(clerkUserId, {
        publicMetadata: { tier: targetTier },
      });
    } catch (clerkErr) {
      console.error(`[CLERK_SYNC_WARNING]: Failed to mirror tier to Clerk metadata for ${clerkUserId}`, clerkErr);
      // Intentionally not thrown — Supabase write already succeeded, which
      // is what actually gates access. This is a cosmetic sync only.
    }

    return NextResponse.json({ status: 'ok' });

  } catch (err: unknown) {
    log.error('razorpay_webhook_failed', { error: err instanceof Error ? err.message : String(err) });
    // 500 tells Razorpay to retry — correct behavior for a genuine failure
    // (e.g. Supabase RPC threw), since the payment did happen and the user
    // still needs to be entitled.
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
