import 'server-only'

import { auth } from '@clerk/nextjs/server'
import { Redis } from '@upstash/redis'
import { publishTTYSessionControl } from './tty-session-control'
import { createTTYSessionRuntimeApi } from './tty-session-runtime-api'
import { createTTYSessionStore } from './tty-session-store'
import { TTYSessionTranscriptManager } from './tty-session-transcript'

function redis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('TTY session runtime Redis configuration is missing.')
  return new Redis({ url, token })
}

export function createTTYSessionRuntimeApiForRequest() {
  const client = redis()
  return createTTYSessionRuntimeApi({
    authenticate: async () => (await auth()).userId ?? null,
    store: createTTYSessionStore(client),
    transcript: new TTYSessionTranscriptManager(client),
    publish: (command) => publishTTYSessionControl(client, command),
  })
}
