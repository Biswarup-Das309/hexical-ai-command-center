import 'server-only'

import { getCanonicalEntitlement } from '@/lib/canonical-entitlement'
import type { Tier } from '@/lib/hexical/types'
import { createSupabaseAdminClient } from '@/lib/supabase-admin'

/**
 * Resolves the same canonical entitlement used by /api/entitlement. Clerk
 * supplies the authenticated owner key; Clerk metadata and profile mirrors
 * must not decide paid access because they can lag the durable ledger.
 */
export async function getUserTier(userId: string): Promise<Tier> {
  try {
    return (await getCanonicalEntitlement(createSupabaseAdminClient(), userId)).tier
  } catch {
    return 'free'
  }
}
