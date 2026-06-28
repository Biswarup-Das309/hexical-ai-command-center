'use client'

import { MessageSquare, Trash2 } from 'lucide-react'
import { HexicalLogo } from './hexical-logo'
import { UserIdentity } from './user-identity'
import { supabase } from '@/lib/supabase'
import { useEffect, useState } from 'react'

export function ChatSidebar({ chats, activeId, onSelect, onNewChat, onDeleteChat }: any) {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isMounted, setIsMounted] = useState(false)

  useEffect(() => {
    setIsMounted(true)
    supabase.auth.getSession().then(({ data: { session } }) => setIsAuthenticated(!!session))
  }, [])

  if (!isMounted) {
    return <div className="h-full w-full flex flex-col border-r border-border bg-background shadow-xl" />
  }

  return (
    <div className="h-full w-full flex flex-col border-r border-border bg-background shadow-xl">
      {/* Logo */}
      <div className="flex items-center justify-center p-6 border-b border-border">
        <button onClick={onNewChat} className="hover:opacity-80 transition-transform hover:scale-105 duration-300">
          <HexicalLogo className="size-10" />
        </button>
      </div>

      {/* History */}
      <div className="flex-1 p-4 overflow-y-auto">
        <p className="px-2 mb-2 text-[10px] font-mono uppercase text-muted-foreground/50">Recent Sessions</p>
        <div className="space-y-1">
          {chats.map((chat: any) => (
            <div 
              key={chat.id} 
              className="group flex items-center justify-between w-full"
            >
              <button
                onClick={() => onSelect(chat.id)}
                className={`flex-1 flex items-center gap-2 rounded p-2 text-[11px] font-mono truncate transition-colors ${
                  activeId === chat.id ? 'bg-muted/30 text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <MessageSquare className="size-3" />
                {chat.title}
              </button>
              
              {/* Delete Button - Only visible on hover */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteChat(chat.id);
                }}
                className="opacity-0 group-hover:opacity-100 p-2 text-muted-foreground hover:text-red-500 transition-opacity"
              >
                <Trash2 className="size-3" />
              </button>
            </div>
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