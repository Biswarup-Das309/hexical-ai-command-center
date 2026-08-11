import { normalizeTier, type Tier } from '@/lib/hexical/types'

export interface WorkspaceEntitlementProfile {
  readonly tier: unknown
  readonly subscription_status: unknown
  readonly current_period_end: unknown
  readonly enterprise_unlimited?: unknown
}

export interface WorkspaceEntitlement {
  readonly tier: Tier
  readonly active: boolean
  readonly currentPeriodEnd: string | null
}

/** Resolves the owner-scoped subscription record shared by browser and TTY flows. */
export function resolveWorkspaceEntitlement(
  profile: WorkspaceEntitlementProfile | null | undefined,
  now = new Date(),
): WorkspaceEntitlement {
  if (!profile) return { tier: 'free', active: false, currentPeriodEnd: null }

  const currentPeriodEnd =
    typeof profile.current_period_end === 'string' && profile.current_period_end.length > 0
      ? profile.current_period_end
      : null
  const expiresAt = currentPeriodEnd ? new Date(currentPeriodEnd) : null
  const current = expiresAt === null || (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() >= now.getTime())
  const status = typeof profile.subscription_status === 'string' ? profile.subscription_status.trim().toLowerCase() : ''
  const activeStatus = status === 'active' || status === 'trialing' || status === 'grace'
  const enterpriseUnlimited = profile.enterprise_unlimited === true
  const active = activeStatus && (enterpriseUnlimited || current)
  // Enterprise contracts are deliberately mapped to bounded Pro runtime limits
  // until an explicit enterprise policy is configured. This prevents an unknown
  // tier from silently downgrading a paying user or granting unlimited compute.
  const normalizedTier =
    String(profile.tier ?? '')
      .trim()
      .toLowerCase() === 'enterprise'
      ? 'pro'
      : normalizeTier(profile.tier)
  const tier = active ? normalizedTier : 'free'
  return { tier, active: tier !== 'free', currentPeriodEnd }
}
