import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveWorkspaceEntitlement,
  type WorkspaceEntitlement,
  type WorkspaceEntitlementProfile,
} from './workspace-entitlement'

type SubscriptionRow = {
  readonly tier?: unknown
  readonly status?: unknown
  readonly current_period_end?: unknown
}

/**
 * Resolves entitlement from the canonical subscriptions ledger. The profiles
 * read is a short-lived rolling-deployment bridge only; it is never preferred
 * over subscriptions and it always fails closed to free.
 */
export async function getCanonicalEntitlement(
  supabase: SupabaseClient,
  userId: string,
  now = new Date(),
): Promise<WorkspaceEntitlement> {
  const bootstrap = await supabase.rpc('hexical_ensure_profile', { p_user_id: userId })
  if (bootstrap.error) {
    console.error('[ENTITLEMENT_PROFILE_BOOTSTRAP_ERROR]', bootstrap.error)

    const fallback = await supabase.from('profiles').upsert(
      {
        user_id: userId,
        tier: 'free',
        status: 'none',
      },
      { onConflict: 'user_id', ignoreDuplicates: true },
    )

    if (fallback.error) console.error('[ENTITLEMENT_PROFILE_FALLBACK_ERROR]', fallback.error)
  }

  const canonical = await supabase
    .from('subscriptions')
    .select('tier, status, current_period_end')
    .eq('user_id', userId)
    .order('current_period_end', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  if (!canonical.error && canonical.data) {
    const row = canonical.data as SubscriptionRow
    return resolveWorkspaceEntitlement(
      {
        tier: row.tier,
        subscription_status: row.status,
        current_period_end: row.current_period_end,
      },
      now,
    )
  }

  const legacy = await supabase
    .from('profiles')
    .select('tier, subscription_status, current_period_end')
    .eq('user_id', userId)
    .maybeSingle()

  return resolveWorkspaceEntitlement(legacy.data as WorkspaceEntitlementProfile | null, now)
}
