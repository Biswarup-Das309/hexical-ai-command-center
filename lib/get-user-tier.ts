import 'server-only'
import { clerkClient } from '@clerk/nextjs/server'

type Tier = 'free' | 'go' | 'plus' | 'pro'

/**
 * PLACEHOLDER — wire this to whatever actually determines a user's
 * paid tier. Clerk publicMetadata works but drifts if a Stripe
 * webhook is ever missed; if you sync subscriptions into your own
 * table, query that instead and treat this as the fallback.
 *
 * The one rule that matters: tier is never read from client input,
 * anywhere, under any circumstances. It's always looked up here.
 */
export async function getUserTier(userId: string): Promise<Tier> {
  const client = await clerkClient()
  const user = await client.users.getUser(userId)
  const tier = user.publicMetadata?.tier

  if (tier === 'go' || tier === 'plus' || tier === 'pro') {
    return tier
  }
  return 'free'
}