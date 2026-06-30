import { createClient } from '@supabase/supabase-js';

// Do NOT export a static 'supabase' object.
// Export a function that creates the client dynamically:
export const getSupabaseClient = async (token: string) => {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        headers: { Authorization: `Bearer ${token}` },
      },
    }
  );
};