'use client'

import { X, Mail, Lock, LogOut, ChevronUp } from 'lucide-react'
import { useState } from 'react'
import * as supabaseModule from '@/lib/supabase'

const supabase =
  (supabaseModule as { default?: any; supabase?: any; client?: any }).default ??
  (supabaseModule as { default?: any; supabase?: any; client?: any }).supabase ??
  (supabaseModule as { default?: any; supabase?: any; client?: any }).client

interface ProfileModalProps {
  isOpen: boolean
  onClose: () => void
  onSignOut: () => void
  user: {
    name: string
    email: string
    avatar: string | null
    isLoggedIn: boolean
  }
}

// Ensure 'export' is exactly here
export function ProfileModal({ isOpen, onClose, onSignOut, user }: ProfileModalProps) {
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  if (!isOpen) return null

  // GOOGLE SIGN IN
  const handleGoogleSignIn = async () => {
    setIsLoading(true)
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
  }

  // EMAIL AUTH
  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    try {
      if (authMode === 'login') {
        await supabase.auth.signInWithPassword({ email, password })
      } else {
        await supabase.auth.signUp({ email, password })
      }
      window.location.reload()
    } catch (err) {
      console.error('Auth error:', err)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="absolute bottom-20 left-4 w-[320px] bg-[#202124] border border-white/10 rounded-3xl shadow-2xl z-[1000] overflow-hidden animate-in fade-in zoom-in-95 duration-200">
      {/* Top Bar */}
      <div className="flex justify-between items-center p-3">
        <span className="text-xs text-muted-foreground px-2 truncate">
          {user.isLoggedIn ? user.email : 'Hexical Auth'}
        </span>
        <button onClick={onClose} className="p-1 hover:bg-white/10 rounded-full text-foreground">
          <X size={18} />
        </button>
      </div>

      {user.isLoggedIn ? (
        /* --- VIEW: LOGGED IN --- */
        <>
          <div className="flex flex-col items-center pt-2 pb-6">
            <div className="relative mb-4">
              {user.avatar ? (
                <img
                  src={user.avatar}
                  alt={user.name}
                  className="size-20 rounded-full border-2 border-[#202124] ring-2 ring-cyan/50 object-cover"
                />
              ) : (
                <div className="size-20 rounded-full bg-cyan-900/50 flex items-center justify-center text-cyan text-2xl font-bold ring-2 ring-cyan/50">
                  {user.name.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            <h3 className="text-xl font-medium text-foreground">Hi, {user.name}!</h3>
          </div>

          <div className="p-2 border-t border-white/5">
            <button
              onClick={onSignOut}
              className="w-full flex items-center gap-3 px-4 py-3 text-sm hover:bg-white/5 rounded-xl transition-all text-foreground"
            >
              <LogOut size={18} /> Sign out
            </button>
          </div>
        </>
      ) : (
        /* --- VIEW: LOGGED OUT --- */
        <div className="px-6 pb-8 pt-2">
          <h3 className="text-xl font-bold mb-6 text-center">{authMode === 'login' ? 'Sign In' : 'Create Account'}</h3>

          <button
            onClick={handleGoogleSignIn}
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-3 py-2 bg-white text-black rounded-lg font-medium hover:bg-gray-200 transition-colors mb-4"
          >
            Sign in with Google
          </button>

          <div className="text-center text-xs text-muted-foreground mb-4">or use email</div>

          <form onSubmit={handleAuth} className="space-y-4">
            <div className="relative">
              <Mail className="absolute left-3 top-3 text-muted-foreground" size={16} />
              <input
                type="email"
                placeholder="Email"
                required
                className="w-full bg-[#1a1b1e] p-2 pl-10 rounded-lg border border-white/10 focus:border-cyan-500 outline-none"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-3 text-muted-foreground" size={16} />
              <input
                type="password"
                placeholder="Password"
                required
                className="w-full bg-[#1a1b1e] p-2 pl-10 rounded-lg border border-white/10 focus:border-cyan-500 outline-none"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <button
              disabled={isLoading}
              className="w-full bg-cyan-600 py-2 rounded-lg font-medium hover:bg-cyan-500 transition-colors"
            >
              {isLoading ? 'Processing...' : authMode === 'login' ? 'Sign In' : 'Sign Up'}
            </button>
          </form>

          <button
            onClick={() => setAuthMode(authMode === 'login' ? 'signup' : 'login')}
            className="text-xs text-cyan mt-4 w-full text-center underline"
          >
            {authMode === 'login' ? 'Need an account? Sign Up' : 'Already have an account? Sign In'}
          </button>
        </div>
      )}
    </div>
  )
}
