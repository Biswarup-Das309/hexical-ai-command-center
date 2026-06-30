import { createClient } from '@supabase/supabase-js';

// These grab the values from your .env.local file
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// This creates the connection object we will use everywhere
export const supabase = createClient(supabaseUrl, supabaseAnonKey);