'use client'

import { MessageSquare, Hexagon } from 'lucide-react'
import { UserIdentity } from './user-identity'
import { supabase } from '@/lib/supabase'
import { useEffect, useState } from 'react'

export function ChatSidebar({ chats, activeId, onSelect, onNewChat }: any) {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isMounted, setIsMounted] = useState(false)

  useEffect(() => {
    setIsMounted(true)
    supabase.auth.getSession().then(({ data: { session } }) => setIsAuthenticated(!!session))
  }, [])

  // If the component hasn't mounted in the browser yet, return null 
  // or a skeleton to prevent the Hydration Mismatch error.
  if (!isMounted) {
    return <div className="h-full w-full flex flex-col border-r border-border bg-background shadow-xl" />
  }

  return (
    <div className="h-full w-full flex flex-col border-r border-border bg-background shadow-xl">
      {/* Logo */}
      <div className="flex items-center justify-center p-6 border-b border-border">
        <button onClick={onNewChat} className="hover:opacity-80 transition-opacity">
          <Hexagon className="size-8 text-primary" />
        </button>
      </div>

      {/* History */}
      <div className="flex-1 p-4 overflow-y-auto">
        <p className="px-2 mb-2 text-[10px] font-mono uppercase text-muted-foreground/50">Recent Sessions</p>
        <div className="space-y-1">
          {chats.map((chat: any) => (
            <button
              key={chat.id}
              onClick={() => onSelect(chat.id)}
              className={`flex w-full items-center gap-2 rounded p-2 text-[11px] font-mono truncate transition-colors ${
                activeId === chat.id ? 'bg-muted/30 text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <MessageSquare className="size-3" />
              {chat.title}
            </button>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-border bg-muted/10">
        {isAuthenticated ? <UserIdentity /> : (
          <button 
            onClick={() => window.location.href = '/login'} 
            className="w-full text-left text-[11px] font-mono uppercase text-muted-foreground hover:text-foreground"
          >
            Sign In
          </button>
        )}
      </div>
    </div>
  )
}