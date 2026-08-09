import 'server-only'

import { auth } from '@clerk/nextjs/server'
import { createClient } from '@supabase/supabase-js'
import { Redis } from '@upstash/redis'

import { getUserTier } from '@/lib/get-user-tier'
import { extractTargetCandidates, isTargetGatedExecutionKind } from './tty-policy'
import { verifyAuthorization } from '@/lib/hexical/authorization'
import { TTYExecutionAdmission } from './tty-execution-admission'
import { createTTYSessionStore } from './tty-session-store'
import { createTTYExecutionAdmissionApi } from './tty-execution-admission-api'
import { activateTTYExecution } from './tty-execution-activator-server'

export function createTTYAdmissionApiForRequest(options: { readonly activate?: boolean } = {}) {
  const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! })
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const store = createTTYSessionStore(redis)
  const admission = new TTYExecutionAdmission(redis, {
    authorize: async ({ userId, rawInput, kind }) => {
      if (!isTargetGatedExecutionKind(kind)) return { allowed: true, scopeId: null }
      try {
        const decision = await verifyAuthorization({
          supabase,
          redis,
          userId,
          profile: 'exploit',
          targetScope: undefined,
          extractedTargets: extractTargetCandidates(rawInput),
          authorizationRef: undefined
        })
        return { allowed: decision.allowed, scopeId: decision.scopeId }
      } catch {
        return { allowed: false, scopeId: null }
      }
    }
  })
  return createTTYExecutionAdmissionApi({
    authenticate: async () => (await auth()).userId ?? null,
    resolveTier: getUserTier,
    getSession: (sessionId, ownerUserId) => store.getSession(sessionId, ownerUserId),
    admission,
    ...(options.activate === false ? {} : {
      startExecution: async (executionId: string, sessionId: string, activationOptions?: { readonly correlationId?: string }) => {
        const result = await activateTTYExecution(executionId, sessionId, activationOptions)
        return { accepted: result.accepted, state: result.state?.state ?? null, reason: result.reason }
      }
    })
  })
}
