// lib/supabase.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('CRITICAL CONFIGURATION ERROR: Supabase environment variables are missing.');
}

const globalForSupabase = globalThis as unknown as {
  supabase: SupabaseClient | undefined;
};

let currentActiveToken: string | undefined = undefined;

export const createSupabaseClient = (token?: string): SupabaseClient => {
  currentActiveToken = token;

  if (!globalForSupabase.supabase) {
    globalForSupabase.supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        fetch: (url, options = {}) => {
          const headers = new Headers(options?.headers);
          if (currentActiveToken) {
            headers.set('Authorization', `Bearer ${currentActiveToken}`);
          }
          return fetch(url, { ...options, headers });
        },
      },
      auth: {
        // completely disable Supabase's local auth tracking since Clerk handles it
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        // The Beta-Fix: Give Turbopack a disposable random ID in dev mode so it can NEVER collide with itself
        storageKey: process.env.NODE_ENV === 'development' 
          ? `hexical-dev-bypass-${Math.random().toString(36).substring(7)}` 
          : 'hexical-prod-auth',
      },
    });
  }

  return globalForSupabase.supabase;
};