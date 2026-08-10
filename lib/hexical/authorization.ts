/**
 * @file lib/hexical/authorization.ts
 *
 * The `exploit` and `swarm` profiles can produce offensive-security content
 * (exploitation vectors, escape payloads) aimed at a `targetScope`. Previously
 * the only guardrail was a system-prompt instruction telling the model to
 * stay "defensive, authorized testing only" — self-declared by whoever typed
 * the request, unverified by the API.
 *
 * This module makes authorization a real, server-enforced gate:
 *   1. The user (or their org) registers a scope — a target pattern tied to a
 *      bounty program / contract / internal engagement.
 *   2. A privileged reviewer (not the requesting user — enforced by Supabase
 *      RLS, see supabase/migrations/xxxx_hexical_authorization.sql) flips
 *      that scope to `verified` with an expiry.
 *   3. Every exploit/swarm request must name a target that falls under a
 *      verified, unexpired scope belonging to that user, or the request is
 *      rejected before any model is called.
 *
 * This does not (and cannot, on its own) guarantee the underlying model
 * output is used responsibly — that still rests on the model's own
 * judgement and on whoever runs the verification step. What it removes is
 * the gap where "authorized" was just a string the requester typed.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Redis } from '@upstash/redis'
import {
  AUTHORIZATION_EXPIRY_WARNING_HOURS,
  AUTHORIZATION_GATED_PROFILES,
  type AuthorizationDecision,
  type Profile,
} from './types'
import { hostMatchesPattern, normalizeHost, sha256 } from './util'

interface ScopeRow {
  id: string
  target_pattern: string
  status: 'pending' | 'verified' | 'revoked'
  expires_at: string | null
}

const SCOPE_CACHE_TTL_SECS = 60

export function isAuthorizationGated(profile: Profile): boolean {
  return AUTHORIZATION_GATED_PROFILES.includes(profile)
}

async function fetchVerifiedScopes(supabase: SupabaseClient, redis: Redis, userId: string): Promise<ScopeRow[]> {
  const cacheKey = `authz:scopes:${userId}`
  const cached = await redis.get<string>(cacheKey)
  if (cached) {
    try {
      return JSON.parse(cached) as ScopeRow[]
    } catch {
      // fall through to a fresh read
    }
  }

  const { data, error } = await supabase
    .from('hexical_authorization_scopes')
    .select('id, target_pattern, status, expires_at')
    .eq('user_id', userId)
    .eq('status', 'verified')
    .gt('expires_at', new Date().toISOString())

  const rows = (error || !data ? [] : data) as ScopeRow[]
  void redis.set(cacheKey, JSON.stringify(rows), { ex: SCOPE_CACHE_TTL_SECS })
  return rows
}

async function logAuthorizationAudit(
  supabase: SupabaseClient,
  entry: {
    user_id: string
    scope_id: string | null
    target_submitted: string
    profile: Profile
    decision: 'allowed' | 'denied'
    reason: string
  },
): Promise<void> {
  const { error } = await supabase.from('hexical_authorization_audit').insert(entry)
  if (error) {
    console.warn('[AUTHZ_AUDIT_LOG_SKIPPED]', error.message)
  }
}

/**
 * Verifies that every target named in the request (targetScope plus any
 * extractedTargets) falls under a verified, unexpired scope owned by the
 * requesting user. Denies closed (fails safe) on any ambiguity: missing
 * target, unmatched target, expired scope, or a lookup error.
 */
export async function verifyAuthorization(args: {
  supabase: SupabaseClient
  redis: Redis
  userId: string
  profile: Profile
  targetScope: string | undefined
  extractedTargets: readonly string[] | undefined
  authorizationRef: string | undefined
}): Promise<AuthorizationDecision> {
  const { supabase, redis, userId, profile, targetScope, extractedTargets, authorizationRef } = args

  if (!isAuthorizationGated(profile)) {
    return { allowed: true, scopeId: null, reason: 'not-gated', expiresInHours: null }
  }

  const targetsRaw = [targetScope, ...(extractedTargets ?? [])].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )

  if (targetsRaw.length === 0) {
    await logAuthorizationAudit(supabase, {
      user_id: userId,
      scope_id: null,
      target_submitted: '',
      profile,
      decision: 'denied',
      reason: 'missing-target-scope',
    })
    return {
      allowed: false,
      scopeId: null,
      reason: 'targetScope is required for exploit/swarm profiles and must fall under a verified authorization scope.',
      expiresInHours: null,
    }
  }

  const hosts = targetsRaw.map((t) => ({ raw: t, host: normalizeHost(t) }))
  if (hosts.some((h) => h.host === null)) {
    await logAuthorizationAudit(supabase, {
      user_id: userId,
      scope_id: null,
      target_submitted: targetsRaw.join(', '),
      profile,
      decision: 'denied',
      reason: 'unparseable-target',
    })
    return {
      allowed: false,
      scopeId: null,
      reason: 'Could not parse one or more submitted targets.',
      expiresInHours: null,
    }
  }

  let scopes = await fetchVerifiedScopes(supabase, redis, userId)
  if (authorizationRef) {
    scopes = scopes.filter((scope) => scope.id === authorizationRef)
  }

  if (scopes.length === 0) {
    await logAuthorizationAudit(supabase, {
      user_id: userId,
      scope_id: authorizationRef ?? null,
      target_submitted: targetsRaw.join(', '),
      profile,
      decision: 'denied',
      reason: 'no-verified-scope',
    })
    return {
      allowed: false,
      scopeId: null,
      reason:
        'No verified authorization scope found for this account. Submit a scope for review before requesting exploit/swarm analysis.',
      expiresInHours: null,
    }
  }

  let matchedScope: ScopeRow | null = null
  for (const { host } of hosts) {
    const match = scopes.find((scope) => hostMatchesPattern(host as string, scope.target_pattern))
    if (!match) {
      matchedScope = null
      break
    }
    matchedScope = match
  }

  const allTargetsCovered = hosts.every(({ host }) =>
    scopes.some((scope) => hostMatchesPattern(host as string, scope.target_pattern)),
  )

  if (!allTargetsCovered) {
    await logAuthorizationAudit(supabase, {
      user_id: userId,
      scope_id: null,
      target_submitted: targetsRaw.join(', '),
      profile,
      decision: 'denied',
      reason: 'target-out-of-scope',
    })
    return {
      allowed: false,
      scopeId: null,
      reason: 'One or more submitted targets fall outside your verified authorization scope(s).',
      expiresInHours: null,
    }
  }

  const soonestExpiring = scopes
    .filter((s) => s.expires_at)
    .sort((a, b) => new Date(a.expires_at as string).getTime() - new Date(b.expires_at as string).getTime())[0]

  const expiresInHours = soonestExpiring?.expires_at
    ? Math.max(0, Math.round((new Date(soonestExpiring.expires_at).getTime() - Date.now()) / 3_600_000))
    : null

  await logAuthorizationAudit(supabase, {
    user_id: userId,
    scope_id: matchedScope?.id ?? soonestExpiring?.id ?? null,
    target_submitted: targetsRaw.join(', '),
    profile,
    decision: 'allowed',
    reason: 'matched-verified-scope',
  })

  return {
    allowed: true,
    scopeId: matchedScope?.id ?? soonestExpiring?.id ?? null,
    reason: 'matched-verified-scope',
    expiresInHours,
  }
}

export function authorizationExpiryIsUrgent(expiresInHours: number | null): boolean {
  return expiresInHours !== null && expiresInHours <= AUTHORIZATION_EXPIRY_WARNING_HOURS
}

/** Self-serve request path: a user can create a `pending` scope request, but
 *  cannot verify it themselves — see the RLS policy in the migration, which
 *  only allows the service role (i.e. an internal review action) to move a
 *  row to `verified`. Wire this up to whatever intake form / support flow
 *  your review process uses. */
export async function requestAuthorizationScope(
  supabase: SupabaseClient,
  args: { userId: string; platform: string; targetPattern: string; programRef?: string; proofUrl?: string },
): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from('hexical_authorization_scopes')
    .insert({
      user_id: args.userId,
      platform: args.platform,
      target_pattern: args.targetPattern,
      program_ref: args.programRef ?? null,
      proof_url: args.proofUrl ?? null,
      status: 'pending',
    })
    .select('id')
    .maybeSingle()

  if (error || !data) {
    console.warn('[AUTHZ_SCOPE_REQUEST_FAILED]', error?.message)
    return null
  }
  return data as { id: string }
}
