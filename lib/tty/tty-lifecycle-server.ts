import 'server-only'

import { auth } from '@clerk/nextjs/server'
import { Redis } from '@upstash/redis'

import { getUserTier } from '@/lib/get-user-tier'
import { createTTYSessionStore } from './tty-session-store'
import { createTTYLifecycleApi, type TTYLifecycleApiDependencies } from './tty-lifecycle-api'
import { resolveTTYResourceLimits } from './tty-resource-limits'

function createRedis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    throw new Error('TTY lifecycle Redis configuration is missing.')
  }
  return new Redis({ url, token })
}

export function createTTYLifecycleApiForRequest() {
  const dependencies: TTYLifecycleApiDependencies = {
    authenticate: async () => (await auth()).userId ?? null,
    resolveTier: getUserTier,
    resolveLimits: resolveTTYResourceLimits,
    getStore: () => createTTYSessionStore(createRedis())
  }
  return createTTYLifecycleApi(dependencies)
}
