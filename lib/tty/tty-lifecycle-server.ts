import 'server-only'

import { auth } from '@clerk/nextjs/server'
import { getUserTier } from '@/lib/get-user-tier'
import { createSupabaseRuntimeStore } from './supabase-runtime-store'
import { createTTYLifecycleApi, type TTYLifecycleApiDependencies } from './tty-lifecycle-api'
import { resolveTTYResourceLimits } from './tty-resource-limits'
import { publishTTYSessionControl } from './tty-session-control'
import { createTTYSessionStore } from './tty-session-store'

export function createTTYLifecycleApiForRequest() {
  const dependencies: TTYLifecycleApiDependencies = {
    authenticate: async () => (await auth()).userId ?? null,
    resolveTier: getUserTier,
    resolveLimits: resolveTTYResourceLimits,
    getStore: () => createTTYSessionStore(createSupabaseRuntimeStore()),
    publishTerminationControl: async (sessionId, ownerUserId) => {
      const client = createSupabaseRuntimeStore()
      await publishTTYSessionControl(client, { sessionId, ownerUserId, type: 'terminate' })
    },
  }
  return createTTYLifecycleApi(dependencies)
}
