import { auth } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'
import { getCanonicalEntitlement } from '@/lib/canonical-entitlement'
import { createSupabaseAdminClient } from '@/lib/supabase-admin'

export const dynamic = 'force-dynamic' // never cache this

const ENTITLEMENT_HEADERS = { 'Cache-Control': 'private, no-store' }

export async function GET() {
  const { userId } = await auth()

  if (!userId) {
    return NextResponse.json({ tier: 'guest', active: false }, { headers: ENTITLEMENT_HEADERS })
  }

  const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
  if (!NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[ENTITLEMENT_ERROR]: Missing Supabase env vars.')
    return NextResponse.json({ tier: 'free', active: false }, { status: 500, headers: ENTITLEMENT_HEADERS })
  }

  const entitlement = await getCanonicalEntitlement(createSupabaseAdminClient(), userId)

  return NextResponse.json(
    {
      tier: entitlement.tier,
      active: entitlement.active,
      current_period_end: entitlement.currentPeriodEnd,
    },
    { headers: ENTITLEMENT_HEADERS },
  )
}
