'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { LogOut, User } from 'lucide-react'

export function UserIdentity() {
  const [user, setUser] = useState<any>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) setUser(data.user)
    })
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    window.location.href = '/login' // Force redirect to login
  }

  if (!user) return null

  // Logic: Use Name/Avatar if they exist, otherwise fallback to Email
  const name = user.user_metadata.full_name || user.email?.split('@')[0] || 'OPERATOR'
  const avatar = user.user_metadata.avatar_url || user.user_metadata.picture 

  return (
    <div className="flex items-center gap-3 rounded-full border border-primary/20 bg-primary/5 px-3 py-1.5 transition-all">
      {/* Avatar or Default Icon */}
      {avatar ? (
        <img src={avatar} alt="Profile" className="size-6 rounded-full border border-primary/30" />
      ) : (
        <div className="flex size-6 items-center justify-center rounded-full bg-primary/20">
          <User className="size-3 text-primary" />
        </div>
      )}
      
      <span className="font-mono text-[10px] uppercase tracking-widest text-primary">
        {name}
      </span>
      
      {/* SIGN OUT BUTTON */}
      <button 
        onClick={handleLogout} 
        className="ml-2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        title="Sign Out"
      >
        <LogOut className="size-3" />
      </button>
    </div>
  )
}