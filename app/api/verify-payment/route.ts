import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import Razorpay from 'razorpay';
import { PRICING } from '@/lib/pricing.config';
import type { PlanTier } from '@/lib/hexical-types';

// Instantiate Razorpay securely (server-side only)
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

export async function POST(req: Request) {
  try {
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json(
        { error: "Cryptographic identity missing." },
        { status: 401 }
      );
    }

    const body = await req.json();

    const tier = body.tier?.toLowerCase();

if (!tier || !(tier in PRICING)) {
  return NextResponse.json(
    { error: "Invalid matrix tier requested." },
    { status: 400 }
  );
}

const requestedTier = tier as keyof typeof PRICING;

    // Validate tier using single source of truth
    if (!requestedTier || !PRICING[requestedTier]) {
      return NextResponse.json(
        { error: "Invalid matrix tier requested." },
        { status: 400 }
      );
    }

    // Get price from central pricing config (NO HARDCODED VALUES)
    const amountInPaise = PRICING[requestedTier].pricePaise;

    // Create Razorpay order
    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `rcpt_${userId.substring(0, 10)}_${Date.now()}`,
      notes: {
        tier: requestedTier,
        userId: userId,
      },
    });

    return NextResponse.json({
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      userMeta: {
        name: "Hexical Operative",
        email: "operative@hexical.ai",
      },
    });

  } catch (err: any) {
    console.error("[CHECKOUT_API_CRASH]:", err);

    return NextResponse.json(
      { error: "Failed to establish secure payment channel." },
      { status: 500 }
    );
  }
}