import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// Initialize outside the handler to utilize connection pooling
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  try {
    const body = await req.text();
    const signature = req.headers.get('x-razorpay-signature');
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    // 1. CONFIGURATION & PRESENCE CHECKS
    if (!secret) {
      console.error('[WEBHOOK_CRITICAL]: Missing RAZORPAY_WEBHOOK_SECRET');
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
    }

    if (!signature) {
      return NextResponse.json({ error: 'Missing signature' }, { status: 401 });
    }

    // 2. CRYPTOGRAPHIC VERIFICATION (Immune to Timing Attacks)
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');

    const isSignatureValid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );

    if (!isSignatureValid) {
      console.warn('[WEBHOOK_WARNING]: Signature mismatch detected.');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }

    const event = JSON.parse(body);

    // 3. SECURE EVENT HANDLING
    if (event.event === 'payment.captured') {
      const paymentEntity = event.payload.payment.entity;
      const paymentId = paymentEntity.id;
      const amountPaid = paymentEntity.amount; // Note: Razorpay amounts are in paise (50000 = 500 INR)
      
      // Safely extract notes with a fallback
      const notes = paymentEntity.notes || {};
      const { clerkUserId, requestedTier } = notes;

      // 4. MALFORMED DATA DEFENSE
      if (!clerkUserId || !requestedTier) {
        console.error(`[WEBHOOK_ERROR]: Missing vital notes for payment ${paymentId}`);
        // Return 200 so Razorpay stops retrying a permanently malformed payload
        return NextResponse.json({ status: 'ignored', reason: 'malformed_payload' }, { status: 200 });
      }

      // 5. BUSINESS LOGIC VERIFICATION (The most critical fix)
      // Force the webhook to verify that the amount paid actually buys the requested tier.
      const tierPrices: Record<string, number> = {
        'Basic': 19900, // 199 INR
        'Pro': 49900,   // 499 INR
      };

      const expectedAmount = tierPrices[requestedTier];

      if (!expectedAmount || amountPaid < expectedAmount) {
        console.error(`[WEBHOOK_FRAUD]: User ${clerkUserId} paid ${amountPaid} for ${requestedTier}`);
        // Return 200 to prevent retries of fraudulent payloads
        return NextResponse.json({ status: 'ignored', reason: 'price_mismatch' }, { status: 200 });
      }

      // 6. IDEMPOTENCY & STATE UPDATE
      const { data: existingUser, error: fetchError } = await supabaseAdmin
        .from('profiles')
        .select('current_period_end, last_payment_id')
        .eq('user_id', clerkUserId)
        .single();

      if (fetchError) throw fetchError;

      // Stop processing if we've already handled this exact payment
      if (existingUser.last_payment_id === paymentId) {
         console.log(`[WEBHOOK_IDEMPOTENCY]: Payment ${paymentId} already processed.`);
         return NextResponse.json({ status: 'already_processed' }, { status: 200 });
      }

      // Calculate new expiry (stacks if they renew early, otherwise starts from today)
      const currentExpiry = existingUser.current_period_end ? new Date(existingUser.current_period_end) : new Date();
      const baseDate = currentExpiry > new Date() ? currentExpiry : new Date();
      baseDate.setDate(baseDate.getDate() + 30);

      const { error: updateError } = await supabaseAdmin
        .from('profiles')
        .update({ 
          tier: requestedTier, 
          current_period_end: baseDate.toISOString(),
          last_payment_id: paymentId // Store this to prevent replay attacks
        })
        .eq('user_id', clerkUserId);

      if (updateError) {
         console.error(`[SUPABASE_ERROR]: Failed to update user ${clerkUserId}`, updateError);
         throw updateError;
      }

      console.log(`[WEBHOOK_SUCCESS]: User ${clerkUserId} upgraded to ${requestedTier}`);
    }

    return NextResponse.json({ status: 'ok' });
  } catch (err) {
    console.error("[WEBHOOK_CRITICAL_ERROR]:", err);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}