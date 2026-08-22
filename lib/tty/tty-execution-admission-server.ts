import 'server-only'

import { auth } from '@clerk/nextjs/server'
import { getUserTier } from '@/lib/get-user-tier'
import { verifyAuthorization } from '@/lib/hexical/authorization'
import { log } from '@/lib/hexical/telemetry'
import { createSupabaseAdminClient } from '@/lib/supabase-admin'
import { createSupabaseRuntimeStore } from './supabase-runtime-store'
import { activateTTYExecution } from './tty-execution-activator-server'
import { TTYExecutionAdmission } from './tty-execution-admission'
import { createTTYExecutionAdmissionApi } from './tty-execution-admission-api'
import { usesDirectTTYActivation } from './tty-execution-mode'
import { extractTargetCandidates, isTargetGatedExecutionKind } from './tty-policy'
import { createTTYSessionStore } from './tty-session-store'

export function createTTYAdmissionApiForRequest(options: { readonly activate?: boolean } = {}) {
  const redis = createSupabaseRuntimeStore()
  const supabase = createSupabaseAdminClient()
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
          authorizationRef: undefined,
        })
        return { allowed: decision.allowed, scopeId: decision.scopeId }
      } catch {
        return { allowed: false, scopeId: null }
      }
    },
  })
  return createTTYExecutionAdmissionApi({
    authenticate: async () => (await auth()).userId ?? null,
    resolveTier: getUserTier,
    getSession: (sessionId, ownerUserId) => store.getSession(sessionId, ownerUserId),
    admission,
    log: (event, fields) => log.info(event, fields),
    ...(options.activate === false || !usesDirectTTYActivation() ? {} : { startExecution: activateTTYExecution }),
  })
}
