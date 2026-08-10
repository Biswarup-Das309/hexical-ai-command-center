import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { resolveWorkspaceEntitlement, type WorkspaceEntitlement, type WorkspaceEntitlementProfile } from './workspace-entitlement'

type SubscriptionRow = {
  readonly tier?: unknown
  readonly status?: unknown
  readonly current_period_end?: unknown
}

/**
 * Resolves entitlement from the canonical subscription ledger. The legacy
 * profiles read is retained only as a migration bridge for environments that
 * have not applied the production migration yet; it is never preferred over
 * user_subscriptions and it always fails closed to free.
 */
export async function getCanonicalEntitlement(supabase: SupabaseClient, userId: string, now = new Date()): Promise<WorkspaceEntitlement> {
  const canonical = await supabase
    .from('user_subscriptions')
    .select('tier, status, current_period_end')
    .eq('user_id', userId)
    .maybeSingle()

  if (!canonical.error && canonical.data) {
    const row = canonical.data as SubscriptionRow
    return resolveWorkspaceEntitlement({
      tier: row.tier,
      subscription_status: row.status,
      current_period_end: row.current_period_end
    }, now)
  }

  const legacy = await supabase
    .from('profiles')
    .select('tier, subscription_status, current_period_end')
    .eq('user_id', userId)
    .maybeSingle()

  return resolveWorkspaceEntitlement(legacy.data as WorkspaceEntitlementProfile | null, now)
}
