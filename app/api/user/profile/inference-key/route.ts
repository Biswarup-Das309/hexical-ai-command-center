import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
// import { encryptSecret } from '@/lib/crypto'       // your server-only encryption helper
// import { supabaseAdmin } from '@/lib/supabase-admin'

export async function POST(request: Request) {
  const { userId } = auth()

  if (!userId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  let body: { provider?: string; key?: string }

  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { provider, key } = body

  if (provider !== 'groq' || typeof key !== 'string' || key.trim().length < 20) {
    return NextResponse.json({ error: 'Invalid provider or key format' }, { status: 400 })
  }

  try {
    // Never store the raw key, log it, or send it back to the client after
    // this point. Encrypt server-side first, and if you ever need to show
    // the user their saved key again, return a masked form only, e.g.
    // "gsk_****ab12" — never the full value.
    //
    // const encrypted = await encryptSecret(key)
    // await supabaseAdmin
    //   .from('inference_keys')
    //   .upsert({ clerk_user_id: userId, provider, encrypted_key: encrypted })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[SAVE_KEY_ERROR]:', error)
    return NextResponse.json({ error: 'Failed to save key' }, { status: 500 })
  }
}