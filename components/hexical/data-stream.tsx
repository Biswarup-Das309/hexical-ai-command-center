'use client'

import { memo, type ComponentPropsWithoutRef, type JSX } from 'react'
import ReactMarkdown from 'react-markdown'

import { type StreamMessage } from '@/lib/hexical-types'

interface DataStreamProps {
  messages: StreamMessage[]
  busy: boolean
}

type MarkdownComponentProps<T extends keyof JSX.IntrinsicElements> = ComponentPropsWithoutRef<T> & {
  node?: unknown
}

const USER_MESSAGE_LIMIT = 4000

function clampText(text: string, limit = USER_MESSAGE_LIMIT) {
  if (text.length <= limit) return text
  return `${text.slice(0, limit).trimEnd()}...`
}

const markdownComponents = {
  h1: ({ node: _node, ...props }: MarkdownComponentProps<'h1'>) => (
    <h1 className="text-2xl font-bold text-foreground mt-6 mb-4 tracking-tight" {...props} />
  ),
  h2: ({ node: _node, ...props }: MarkdownComponentProps<'h2'>) => (
    <h2 className="text-xl font-semibold text-foreground mt-5 mb-3 border-b border-border/50 pb-2" {...props} />
  ),
  h3: ({ node: _node, ...props }: MarkdownComponentProps<'h3'>) => (
    <h3 className="text-lg font-medium text-[var(--accent-text)] mt-4 mb-2" {...props} />
  ),
  p: ({ node: _node, ...props }: MarkdownComponentProps<'p'>) => (
    <p className="mb-4 text-foreground/90 leading-relaxed" {...props} />
  ),
  ul: ({ node: _node, ...props }: MarkdownComponentProps<'ul'>) => (
    <ul className="list-disc list-outside ml-6 mb-4 space-y-2 marker:text-[var(--accent-text)]" {...props} />
  ),
  ol: ({ node: _node, ...props }: MarkdownComponentProps<'ol'>) => (
    <ol className="list-decimal list-outside ml-6 mb-4 space-y-2 marker:text-[var(--accent-text)] font-mono" {...props} />
  ),
  li: ({ node: _node, ...props }: MarkdownComponentProps<'li'>) => <li className="pl-1" {...props} />,
  strong: ({ node: _node, ...props }: MarkdownComponentProps<'strong'>) => (
    <strong className="font-bold text-[var(--accent-text)] drop-shadow-[0_0_8px_var(--accent-border)]" {...props} />
  ),
  blockquote: ({ node: _node, ...props }: MarkdownComponentProps<'blockquote'>) => (
    <blockquote
      className="border-l-2 border-[var(--accent-text)] pl-4 italic text-muted-foreground my-4 bg-muted/10 py-2 rounded-r-lg"
      {...props}
    />
  ),
  code: ({ node: _node, className, children, ...props }: MarkdownComponentProps<'code'>) => {
    const match = /language-(\w+)/.exec(className || '')

    return match ? (
      <pre className="bg-card border border-border rounded-lg p-4 my-4 overflow-x-auto shadow-lg">
        <code className={`font-mono text-[13px] text-[var(--accent-text)] ${className || ''}`} {...props}>
          {children}
        </code>
      </pre>
    ) : (
      <code
        className="bg-muted/50 text-[var(--accent-text)] px-1.5 py-0.5 rounded font-mono text-[13px] border border-[var(--accent-border)]"
        {...props}
      >
        {children}
      </code>
    )
  },
}

function getStepCount(msg: StreamMessage) {
  return msg.steps?.length ?? 0
}

const DataStreamMessage = memo(
  function DataStreamMessage({ msg }: { msg: StreamMessage }) {
    const isUser = msg.role === 'user'
    const text = isUser ? clampText(msg.text) : msg.text
    const stepCount = getStepCount(msg)

    return (
      <div className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
        {isUser && (
          <div className="max-w-[70%] rounded-2xl bg-primary/10 px-4 py-3 text-sm font-medium text-foreground border border-primary/20">
            {text}
          </div>
        )}

        {msg.role === 'hexical' && (
          <div className="max-w-[85%] text-sm leading-relaxed text-foreground" aria-live="polite">
            <ReactMarkdown components={markdownComponents}>{text}</ReactMarkdown>

            {stepCount > 0 && (
              <div className="mt-4 text-[10px] uppercase tracking-widest text-primary/50 border-t border-border/30 pt-2 inline-block">
                Structured analysis complete
              </div>
            )}
          </div>
        )}

        {msg.role === 'error' && (
          <div className="max-w-[80%] rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {msg.text}
          </div>
        )}
      </div>
    )
  },
  (prevProps, nextProps) =>
    prevProps.msg.id === nextProps.msg.id &&
    prevProps.msg.role === nextProps.msg.role &&
    prevProps.msg.text === nextProps.msg.text &&
    getStepCount(prevProps.msg) === getStepCount(nextProps.msg),
)

export function DataStream({ messages, busy }: DataStreamProps) {
  return (
    <div className="flex flex-col gap-6 p-6 h-full overflow-y-auto">
      {messages.map((msg) => (
        <DataStreamMessage key={msg.id} msg={msg} />
      ))}

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