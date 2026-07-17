import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic'; // never cache this

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ tier: 'guest', active: false });
  }

  const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[ENTITLEMENT_ERROR]: Missing Supabase env vars.');
    return NextResponse.json({ tier: 'free', active: false }, { status: 500 });
  }

  const supabaseAdmin = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('tier, subscription_status, current_period_end')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    console.error('[ENTITLEMENT_ERROR]: Supabase query failed', error);
    // fail safe to 'free', never fail open to a paid tier
    return NextResponse.json({ tier: 'free', active: false }, { status: 500 });
  }

  if (!profile) {
    return NextResponse.json({ tier: 'free', active: false });
  }

  const isExpired = profile.current_period_end
    ? new Date(profile.current_period_end) < new Date()
    : true;

  const effectiveTier = profile.subscription_status === 'active' && !isExpired
    ? profile.tier
    : 'free';

  return NextResponse.json({
    tier: effectiveTier,
    active: effectiveTier !== 'free' && effectiveTier !== 'guest',
    current_period_end: profile.current_period_end,
  });
}