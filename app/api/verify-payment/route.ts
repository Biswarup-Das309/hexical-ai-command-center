import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import Razorpay from 'razorpay';

// Instantiate the Razorpay SDK securely on the backend
const razorpay = new Razorpay({
  key_id: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

// The Immutable Price Matrix (INR)
const TIER_PRICING: Record<string, number> = {
  go: 299,
  plus: 1999,
  pro: 9599,
};

export async function POST(req: Request) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Cryptographic identity missing." }, { status: 401 });

    const body = await req.json();
    const requestedTier = body.tier?.toLowerCase();

    if (!requestedTier || !TIER_PRICING[requestedTier]) {
      return NextResponse.json({ error: "Invalid matrix tier requested." }, { status: 400 });
    }

    // Razorpay expects amounts in the smallest currency unit (paise for INR)
    const amountInPaise = TIER_PRICING[requestedTier] * 100;

    // Generate a secure order ticket
    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `rcpt_${userId.substring(0, 10)}_${Date.now()}`,
      notes: { tier: requestedTier, userId: userId },
    });

    return NextResponse.json({
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      userMeta: { name: "Hexical Operative", email: "operative@hexical.ai" } // Optional: Pull from Clerk
    });

  } catch (err: any) {
    console.error("[CHECKOUT_API_CRASH]:", err);
    return NextResponse.json({ error: "Failed to establish secure payment channel." }, { status: 500 });
  }
}