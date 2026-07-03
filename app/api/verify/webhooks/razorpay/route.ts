import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// ============================================================================
// THE IMMUTABLE ASSET MATRICES
// ============================================================================
const TIER_PRICE_MAP: Record<string, number> = {
  go: 299 * 100,     // 299 INR
  plus: 1999 * 100,  // 1,999 INR
  pro: 9599 * 100,   // 9,599 INR
};

const TOKEN_ALLOCATIONS: Record<string, number> = {
  go: 5_000_000,
  plus: 7_000_000,
  pro: 30_000_000,
};

export async function POST(req: Request) {
  try {
    // 1. LAZY INSTANTIATION (CI/CD Shield)
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("FATAL: Missing Supabase infrastructure keys.");
    }
    if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
      throw new Error("FATAL: Missing Razorpay Webhook Secret.");
    }

    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const bodyText = await req.text();
    const signature = req.headers.get('x-razorpay-signature');
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!signature) {
      return NextResponse.json({ error: 'Missing cryptographic signature' }, { status: 401 });
    }

    // ============================================================================
    // 2. CRYPTOGRAPHIC VERIFICATION (Immune to Timing Attacks & Buffer Crashes)
    // ============================================================================
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(bodyText)
      .digest('hex');

    // CRITICAL FIX: Prevent Buffer length mismatch crash (DDoS protection)
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

    const event = JSON.parse(bodyText);

    // ============================================================================
    // 3. SECURE EVENT HANDLING
    // ============================================================================
    if (event.event === 'payment.captured' || event.event === 'order.paid') {
      const paymentEntity = event.payload.payment.entity;
      const paymentId = paymentEntity.id;
      const orderId = paymentEntity.order_id;
      const amountPaid = paymentEntity.amount; 
      
      const notes = paymentEntity.notes || {};
      const { clerkUserId, requestedTier } = notes;

      if (!clerkUserId || !requestedTier) {
         console.error(`[WEBHOOK_ERROR]: Missing vital routing notes for payment ${paymentId}`);
         return NextResponse.json({ status: 'ignored', reason: 'malformed_payload' }, { status: 200 });
      }

      const targetTier = requestedTier.toLowerCase();

      // ============================================================================
      // 4. BUSINESS LOGIC VERIFICATION 
      // ============================================================================
      const expectedAmount = TIER_PRICE_MAP[targetTier];

      if (!expectedAmount || amountPaid < expectedAmount) {
         console.error(`[WEBHOOK_FRAUD]: User ${clerkUserId} paid ${amountPaid} for ${targetTier}`);
         return NextResponse.json({ status: 'ignored', reason: 'price_mismatch' }, { status: 200 });
      }

      // ============================================================================
      // 5. TRUE IDEMPOTENCY (Audit Table Integration)
      // ============================================================================
      const { error: auditError } = await supabaseAdmin.from('transactions').insert({
        id: paymentId,
        user_id: clerkUserId,
        order_id: orderId,
        tier_purchased: targetTier,
        status: 'webhook_verified'
      });

      if (auditError) {
        // Postgres Unique Violation (23505) means this exact payment was already processed
        if (auditError.code === '23505') { 
          console.log(`[WEBHOOK_IDEMPOTENCY]: Payment ${paymentId} already processed.`);
          return NextResponse.json({ status: 'already_processed' }, { status: 200 });
        }
        throw auditError;
      }

      // ============================================================================
      // 6. ASSET INJECTION (Tier + Tokens)
      // ============================================================================
      const tokenBudget = TOKEN_ALLOCATIONS[targetTier] || 0;

      const { data: existingUser } = await supabaseAdmin
        .from('profiles')
        .select('current_period_end')
        .eq('user_id', clerkUserId)
        .maybeSingle();

      const currentExpiry = existingUser?.current_period_end ? new Date(existingUser.current_period_end) : new Date();
      const baseDate = currentExpiry > new Date() ? currentExpiry : new Date();
      
      // Add 30 days to the license
      baseDate.setDate(baseDate.getDate() + 30);

      const { error: updateError } = await supabaseAdmin
        .from('profiles')
        .update({ 
          tier: targetTier, 
          current_period_end: baseDate.toISOString(),
          monthly_tokens_remaining: tokenBudget, // CRITICAL FIX: Injecting the purchased tokens
          tier_updated_at: new Date().toISOString()
        })
        .eq('user_id', clerkUserId);

      if (updateError) {
         console.error(`[SUPABASE_ERROR]: Failed to inject assets for user ${clerkUserId}`, updateError);
         throw updateError;
      }

      console.log(`[WEBHOOK_SUCCESS]: User ${clerkUserId} upgraded to ${targetTier}. ${tokenBudget} tokens injected.`);
    }

    return NextResponse.json({ status: 'ok' });
  } catch (err: any) {
    console.error("[WEBHOOK_CRITICAL_ERROR]:", err);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}
