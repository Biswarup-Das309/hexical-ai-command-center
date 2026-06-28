'use client'

import { type StreamMessage } from '@/lib/hexical-types'
import ReactMarkdown from 'react-markdown'

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
            <div className="max-w-[70%] rounded-2xl bg-primary/10 px-4 py-3 text-sm font-medium text-foreground border border-primary/20">
              {msg.text}
            </div>
          )}

          {/* Hexical Message (Left - Transparent with Markdown Formatting) */}
          {msg.role === 'hexical' && (
            <div className="max-w-[85%] text-sm leading-relaxed text-foreground">
              
              <ReactMarkdown
                components={{
                  // Main Headings (H1)
                  h1: ({ node, ...props }) => (
                    <h1 className="text-2xl font-bold text-foreground mt-6 mb-4 tracking-tight" {...props} />
                  ),
                  // Subheadings (H2) - Adds a subtle bottom border
                  h2: ({ node, ...props }) => (
                    <h2 className="text-xl font-semibold text-foreground mt-5 mb-3 border-b border-border/50 pb-2" {...props} />
                  ),
                  // Minor Headings (H3) - Cyan color for emphasis
                  h3: ({ node, ...props }) => (
                    <h3 className="text-lg font-medium text-cyan mt-4 mb-2" {...props} />
                  ),
                  // Standard Body Text
                  p: ({ node, ...props }) => (
                    <p className="mb-4 text-foreground/90 leading-relaxed" {...props} />
                  ),
                  // Unordered Lists (Bullet Points) - Custom cyan markers
                  ul: ({ node, ...props }) => (
                    <ul className="list-disc list-outside ml-6 mb-4 space-y-2 marker:text-cyan" {...props} />
                  ),
                  // Ordered Lists (Numbers)
                  ol: ({ node, ...props }) => (
                    <ol className="list-decimal list-outside ml-6 mb-4 space-y-2 marker:text-cyan font-mono" {...props} />
                  ),
                  // List Items
                  li: ({ node, ...props }) => (
                    <li className="pl-1" {...props} />
                  ),
                  // Bold Text
                  strong: ({ node, ...props }) => (
                    <strong className="font-bold text-cyan drop-shadow-[0_0_8px_rgba(0,255,255,0.3)]" {...props} />
                  ),
                  // Blockquotes
                  blockquote: ({ node, ...props }) => (
                    <blockquote className="border-l-2 border-cyan pl-4 italic text-muted-foreground my-4 bg-muted/10 py-2 rounded-r-lg" {...props} />
                  ),
                  // Inline Code and Code Blocks
                  code: ({ node, className, children, ...props }: any) => {
                    const match = /language-(\w+)/.exec(className || '')
                    return match ? (
                      <pre className="bg-card border border-border rounded-lg p-4 my-4 overflow-x-auto shadow-lg">
                        <code className={`font-mono text-[13px] text-cyan ${className || ''}`} {...props}>
                          {children}
                        </code>
                      </pre>
                    ) : (
                      <code className="bg-muted/50 text-cyan px-1.5 py-0.5 rounded font-mono text-[13px] border border-cyan/20" {...props}>
                        {children}
                      </code>
                    )
                  }
                }}
              >
                {msg.text}
              </ReactMarkdown>

              {msg.steps && msg.steps.length > 0 && (
                <div className="mt-4 text-[10px] uppercase tracking-widest text-primary/50 border-t border-border/30 pt-2 inline-block">
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