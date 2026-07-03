import { NextResponse } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import Razorpay from 'razorpay';
import { createClient } from '@supabase/supabase-js';

// ============================================================================
// 1. INITIALIZE INFRASTRUCTURE
// ============================================================================
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  throw new Error("FATAL: Missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET in environment variables.");
}

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Initialize Supabase Admin for system infrastructure verification
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Price configuration in Paisa (1 INR = 100 Paisa)
const TIER_PRICE_MAP: Record<string, number> = {
  go: 299 * 100,     // ₹299
  plus: 1999 * 100,  // ₹1,999
  pro: 9599 * 100,   // ₹9,599
};

export async function POST(req: Request) {
  try {
    // 1. Authenticate the User
    const { userId } = await auth();
    const user = await currentUser();

    if (!userId || !user) {
      return NextResponse.json({ error: "Unauthorized access bounds." }, { status: 401 });
    }

    const { tier } = await req.json();
    const amountInPaisa = TIER_PRICE_MAP[tier];

    if (!amountInPaisa) {
      return NextResponse.json({ error: "Invalid tier pricing matrix configuration." }, { status: 400 });
    }

    // ============================================================================
    // DEVIL'S ADVOCATE CHECK: THE DOUBLE-PAYMENT SHIELD
    // We check Supabase to ensure the user doesn't already have this exact 
    // active tier. If they do, we block the transaction to save their money.
    // ============================================================================
    const { data: profile, error: dbError } = await supabaseAdmin
      .from('profiles')
      .select('tier, current_period_end')
      .eq('user_id', userId)
      .maybeSingle();

    if (profile && profile.tier === tier && profile.current_period_end) {
      const endDate = new Date(profile.current_period_end);
      if (endDate > new Date()) {
        return NextResponse.json(
          { error: `You already have an active ${tier.toUpperCase()} license valid until ${endDate.toLocaleDateString()}.` },
          { status: 400 } // Bad Request (Already Subscribed)
        );
      }
    }

    // ============================================================================
    // THE RAZORPAY ORDER OBJECT
    // ============================================================================
    // Fix: Receipt length must be <= 40 chars. 
    // Format: rpt_ + 15 chars of userId + 8 chars of timestamp = ~28 chars total. Safe.
    const safeReceiptString = `rpt_${userId.substring(0, 15)}_${Date.now().toString().slice(-8)}`;

    const options = {
      amount: amountInPaisa,
      currency: "INR",
      receipt: safeReceiptString,
      // Fix: Razorpay uses 'notes' for custom payload data, NOT 'metadata'.
      // This is crucial. Our webhook will read these 'notes' later.
      notes: {
        clerkUserId: userId,
        requestedTier: tier,
      },
    };

    // Generate the Cryptographic Order ID from Razorpay Servers
    const order = await razorpay.orders.create(options);

    // Return the payload back to the frontend checkout frame
    return NextResponse.json({
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      tier: tier,
      userMeta: {
        name: user.fullName || "Hexical Researcher",
        email: user.primaryEmailAddress?.emailAddress || "",
        contact: "" // Razorpay likes having a contact field available
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