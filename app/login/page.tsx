'use client'
import { useState } from 'react'
import { supabase } from '@/lib/supabase'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const handleGoogleLogin = async () => {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
  }

  const handleEmailLogin = async (isSignUp: boolean) => {
    setLoading(true)
    const { error } = isSignUp 
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password })
    
    if (error) alert(error.message)
    else if (!isSignUp) window.location.href = '/'
    setLoading(false)
  }

  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center bg-black font-mono">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-primary/20 bg-background/50 p-8 backdrop-blur">
        <h2 className="text-center text-sm uppercase tracking-[0.3em] text-primary">Access Terminal</h2>
        
        {/* Email Fields */}
        <div className="space-y-4">
          <input type="email" placeholder="EMAIL" className="w-full bg-black/50 p-3 border border-border text-xs" onChange={(e) => setEmail(e.target.value)} />
          <input type="password" placeholder="PASSWORD" className="w-full bg-black/50 p-3 border border-border text-xs" onChange={(e) => setPassword(e.target.value)} />
          
          <div className="grid grid-cols-2 gap-2">
            <button disabled={loading} onClick={() => handleEmailLogin(false)} className="bg-primary/10 p-3 text-[10px] text-primary hover:bg-primary/20">SIGN IN</button>
            <button disabled={loading} onClick={() => handleEmailLogin(true)} className="border border-primary/20 p-3 text-[10px] text-primary hover:bg-primary/20">SIGN UP</button>
          </div>
        </div>

        <div className="relative border-t border-border" />

        <button onClick={handleGoogleLogin} className="w-full border border-border p-3 text-[10px] uppercase text-muted-foreground hover:text-primary">
          Continue with Google
        </button>
      </div>
    </div>
  )
}