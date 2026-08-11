import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveWorkspaceEntitlement, type WorkspaceEntitlement } from './workspace-entitlement'

type SubscriptionRow = {
  readonly tier?: unknown
  readonly status?: unknown
  readonly current_period_end?: unknown
  readonly enterprise_unlimited?: unknown
}

/**
 * Resolves entitlement exclusively from the database canonical entitlement
 * function. Profiles are provisioning metadata and must never elevate access.
 */
export async function getCanonicalEntitlement(
  supabase: SupabaseClient,
  userId: string,
  now = new Date(),
): Promise<WorkspaceEntitlement> {
  const bootstrap = await supabase.rpc('hexical_ensure_profile', { p_user_id: userId })
  // Provisioning can fail independently during a rolling migration. It must
  // never fall back to the legacy profile mirror, because that mirror is not
  // an entitlement authority and a write to it could mask migration drift.
  if (bootstrap.error) console.error('[ENTITLEMENT_BOOTSTRAP_ERROR]', bootstrap.error)

  const canonical = await supabase.rpc('canonical_entitlement', { p_user_id: userId }).maybeSingle()

  if (!canonical.error && canonical.data) {
    const row = canonical.data as SubscriptionRow
    return resolveWorkspaceEntitlement(
      {
        tier: row.tier,
        subscription_status: row.status,
        current_period_end: row.current_period_end,
        enterprise_unlimited: row.enterprise_unlimited,
      },
      now,
    )
  }

  if (canonical.error) console.error('[CANONICAL_ENTITLEMENT_ERROR]', canonical.error)
  return resolveWorkspaceEntitlement(null, now)
}
