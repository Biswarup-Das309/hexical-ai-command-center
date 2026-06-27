'use client'

import { type StreamMessage } from '@/lib/hexical-types'

interface DataStreamProps {
  messages: StreamMessage[]
  busy: boolean
}

export function DataStream({ messages, busy }: DataStreamProps) {
  return (
    <div className="flex flex-col gap-6 p-6 h-full overflow-y-auto">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`flex w-full ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
        >
          {/* User Bubble (Right) */}
          {msg.role === 'user' && (
            <div className="max-w-[70%] rounded-2xl bg-primary/10 px-4 py-3 text-sm font-medium text-foreground">
              {msg.text}
            </div>
          )}

          {/* Hexical Message (Left - Transparent) */}
          {msg.role === 'hexical' && (
            <div className="max-w-[80%] text-sm leading-relaxed text-foreground">
              {msg.text}
              {msg.steps && msg.steps.length > 0 && (
                <div className="mt-2 text-[10px] uppercase tracking-widest text-primary/50">
                   [ENGINE PROCESSED: {msg.steps.length} STAGES]
                </div>
              )}
            </div>
          )}

          {/* CRITICAL FIX: Error Handling */}
          {msg.role === 'error' && (
            <div className="max-w-[80%] rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              {msg.text}
            </div>
          )}
        </div>
      ))}
      
      {/* Loading State */}
      {busy && (
        <div className="flex justify-start">
           <div className="flex items-center gap-2 text-sm text-primary animate-pulse italic">
             <div className="size-2 rounded-full bg-primary animate-bounce" />
             Hexical is routing...
           </div>
        </div>
      )}
    </div>
  )
}