import 'server-only'

import { createClient } from '@supabase/supabase-js'
import { getCanonicalEntitlement } from '@/lib/canonical-entitlement'
import type { Tier } from '@/lib/hexical/types'

/**
 * Resolves the same profile record used by /api/entitlement. Clerk supplies
 * the authenticated owner key; optional Clerk metadata must not decide paid
 * access because it can lag the durable subscription profile.
 */
export async function getUserTier(userId: string): Promise<Tier> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceRoleKey) return 'free'

  const supabaseAdmin = createClient(url, serviceRoleKey)
  return (await getCanonicalEntitlement(supabaseAdmin, userId)).tier
}
