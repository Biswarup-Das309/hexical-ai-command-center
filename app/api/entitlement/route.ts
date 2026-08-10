import { auth } from '@clerk/nextjs/server'
import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { getCanonicalEntitlement } from '@/lib/canonical-entitlement'

export const dynamic = 'force-dynamic' // never cache this

export async function GET() {
  const { userId } = await auth()

  if (!userId) {
    return NextResponse.json({ tier: 'guest', active: false })
  }

  const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
  if (!NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[ENTITLEMENT_ERROR]: Missing Supabase env vars.')
    return NextResponse.json({ tier: 'free', active: false }, { status: 500 })
  }

  const supabaseAdmin = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  const entitlement = await getCanonicalEntitlement(supabaseAdmin, userId)

  return NextResponse.json({
    tier: entitlement.tier,
    active: entitlement.active,
    current_period_end: entitlement.currentPeriodEnd,
  })
}
