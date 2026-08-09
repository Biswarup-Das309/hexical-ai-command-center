import { normalizeTier, type Tier } from '@/lib/hexical/types'

export interface WorkspaceEntitlementProfile {
  readonly tier: unknown
  readonly subscription_status: unknown
  readonly current_period_end: unknown
}

export interface WorkspaceEntitlement {
  readonly tier: Tier
  readonly active: boolean
  readonly currentPeriodEnd: string | null
}

/** Resolves the owner-scoped subscription record shared by browser and TTY flows. */
export function resolveWorkspaceEntitlement(profile: WorkspaceEntitlementProfile | null | undefined, now = new Date()): WorkspaceEntitlement {
  if (!profile) return { tier: 'free', active: false, currentPeriodEnd: null }

  const currentPeriodEnd = typeof profile.current_period_end === 'string' && profile.current_period_end.length > 0
    ? profile.current_period_end
    : null
  const expiresAt = currentPeriodEnd ? new Date(currentPeriodEnd) : null
  const current = expiresAt !== null && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() >= now.getTime()
  const active = profile.subscription_status === 'active' && current
  const tier = active ? normalizeTier(profile.tier) : 'free'
  return { tier, active: tier !== 'free', currentPeriodEnd }
}
