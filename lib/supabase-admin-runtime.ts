import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

const GLOBAL_ADMIN_CLIENT_KEY = '__hexical_supabase_admin_client__'

function requiredEnv(name: 'NEXT_PUBLIC_SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required Supabase environment variable: ${name}`)
  return value
}

/** One sessionless service-role client shared by server routes and the Linux worker. */
export function createSupabaseAdminClient(): SupabaseClient<Database> {
  const global = globalThis as Record<string, unknown>
  const existing = global[GLOBAL_ADMIN_CLIENT_KEY]
  if (existing) return existing as SupabaseClient<Database>

  const client = createClient<Database>(
    requiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: 'hexical-server-admin',
      },
      realtime: { params: { eventsPerSecond: 100 } },
    },
  )
  global[GLOBAL_ADMIN_CLIENT_KEY] = client
  return client
}
