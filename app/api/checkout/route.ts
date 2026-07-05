import { NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import Razorpay from 'razorpay';
import { createClient } from '@supabase/supabase-js';

// Price configuration in Paisa (1 INR = 100 Paisa)
const TIER_PRICE_MAP: Record<string, number> = {
  go: 299 * 100,     // ₹299
  plus: 999 * 100,  // ₹999
  pro: 4999 * 100,   // ₹4,999
};

export async function POST(req: Request) {
  try {
    // ============================================================================
    // 1. LAZY INSTANTIATION: The Vercel Build Shield
    // ============================================================================
    if (!process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      throw new Error("FATAL: Missing Razorpay cryptographic keys in environment variables.");
    }
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("FATAL: Missing Supabase infrastructure keys.");
    }

    const razorpay = new Razorpay({
      key_id: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // ============================================================================
    // 2. CRYPTOGRAPHIC IDENTITY VALIDATION
    // ============================================================================
    const { userId } = await auth();
    const user = await currentUser();

    if (!userId || !user) {
      return NextResponse.json({ error: "Unauthorized access bounds." }, { status: 401 });
    }

    const body = await req.json();
    const tier = body.tier?.toLowerCase();
    const amountInPaisa = TIER_PRICE_MAP[tier];

    if (!amountInPaisa) {
      return NextResponse.json({ error: "Invalid tier pricing matrix configuration." }, { status: 400 });
    }

    // ============================================================================
    // 3. THE DOUBLE-PAYMENT SHIELD
    // ============================================================================
    const { data: profile, error: dbError } = await supabaseAdmin
      .from('profiles')
      .select('tier, current_period_end')
      .eq('user_id', userId)
      .maybeSingle();

    if (dbError) {
      console.warn(`[DB_TRACE]: Failed to verify existing license for ${userId}. Proceeding with caution.`);
    }

    if (profile && profile.tier === tier && profile.current_period_end) {
      const endDate = new Date(profile.current_period_end);
      if (endDate > new Date()) {
        return NextResponse.json(
          { error: `Transaction blocked: You already hold an active ${tier.toUpperCase()} license valid until ${endDate.toLocaleDateString()}.` },
          { status: 400 } 
        );
      }
    }

    // ============================================================================
    // 4. THE RAZORPAY ORDER OBJECT
    // ============================================================================
    const safeReceiptString = `rpt_${userId.substring(0, 15)}_${Date.now().toString().slice(-8)}`;

    const options = {
      amount: amountInPaisa,
      currency: "INR",
      receipt: safeReceiptString,
      notes: {
        clerkUserId: userId,
        requestedTier: tier,
      },
    };

    const order = await razorpay.orders.create(options);

    // ============================================================================
    // 5. SECURE METADATA DISPATCH
    // ============================================================================
    return NextResponse.json({
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      tier: tier,
      userMeta: {
        name: user.fullName || "Hexical Researcher",
        email: user.primaryEmailAddress?.emailAddress || "",
        contact: "" 
      }
    });

  } catch (error: any) {
    console.error("[RAZORPAY_ORDER_FATAL]:", error);
    return NextResponse.json(
      { error: error.message || "Failed to instantiate Razorpay transaction handshake." },
      { status: 500 }
    );
  }
}
