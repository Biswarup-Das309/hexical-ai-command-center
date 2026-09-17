import { VALID_TIERS, type PlanTier } from './hexical/types'

/**
 * Parse a server entitlement response for display-only client state.
 * Unknown, missing, or malformed values fail closed to Free.
 */
export function parseEntitlementTier(value: unknown): PlanTier {
  return typeof value === 'string' && (VALID_TIERS as readonly string[]).includes(value) ? (value as PlanTier) : 'free'
}
