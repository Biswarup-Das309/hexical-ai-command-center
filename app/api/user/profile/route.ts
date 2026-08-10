import { auth } from '@clerk/nextjs/server'
import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

export async function GET() {
  // Grab the authenticated user's ID from Clerk
  const { userId } = await auth()

  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  try {
    // 1. Initialize Supabase Admin client using your Service Role Key
    // This allows you to securely read from the profiles table
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

    // 2. Fetch the real tier from the database
    // Note: In your gateway file, you used 'user_id', so we use that here instead of 'clerk_user_id'
    const { data, error } = await supabase.from('profiles').select('tier').eq('user_id', userId).maybeSingle()

    if (error) {
      console.error('[SUPABASE_DB_ERROR]:', error)
      throw error
    }

    // 3. Fallback to 'free' only if they don't have a record yet
    const tier = data?.tier || 'free'

    return NextResponse.json({ tier })
  } catch (error) {
    console.error('[PROFILE_FETCH_ERROR]:', error)
    return NextResponse.json({ error: 'Failed to load profile' }, { status: 500 })
  }
}
