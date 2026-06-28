import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://cbuusvyeonobpbmusmsa.supabase.co'
const PROXY_URL = 'https://supabase-proxy.biswarup-das-0087.workers.dev'

// Logic: Use Proxy for standard API calls, but the real URL for Auth
export const supabase = createClient(SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
  db: {
    schema: 'public',
  },
  global: {
    headers: {
      'x-supabase-proxy': PROXY_URL // This is just a hint; we handle the routing in the worker
    },
  },
})