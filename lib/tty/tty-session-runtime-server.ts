import 'server-only'

import { auth } from '@clerk/nextjs/server'
import { createSupabaseRuntimeStore } from './supabase-runtime-store'
import { publishTTYSessionControl } from './tty-session-control'
import { createTTYSessionRuntimeApi } from './tty-session-runtime-api'
import { createTTYSessionStore } from './tty-session-store'
import { TTYSessionTranscriptManager } from './tty-session-transcript'

export function createTTYSessionRuntimeApiForRequest() {
  const client = createSupabaseRuntimeStore()
  return createTTYSessionRuntimeApi({
    authenticate: async () => (await auth()).userId ?? null,
    store: createTTYSessionStore(client),
    transcript: new TTYSessionTranscriptManager(client),
    publish: (command) => publishTTYSessionControl(client, command),
  })
}
