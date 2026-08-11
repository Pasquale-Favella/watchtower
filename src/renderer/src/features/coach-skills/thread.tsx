import type { RefObject } from 'react'

import { Badge } from '@/shared/components/ui/badge'

import { DraftCard } from './draft-card'
import { MODE_LABEL } from './lib'
import { useCoachSkillsStore, type ChatMessage } from './store'

/** Tool-call notices on a streaming assistant turn — an elements.ai-sdk.dev
 *  Tool-card-inspired chip row. */
function ToolNotices({ tools }: { tools: string[] }) {
  if (tools.length === 0) return null
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {tools.map((tool, index) => (
        <Badge key={`${tool}-${index}`} variant="secondary" className="font-mono text-[9.5px]">
          {tool}
        </Badge>
      ))}
    </div>
  )
}

/** One thread message (ADR 0017): a user bubble, a streaming assistant turn
 *  with tool notices, or — when a build-skill run completes — a draft card
 *  with the harness markdown and the review actions. */
export function MessageBubble({ message, onSave }: {
  message: ChatMessage
  onSave: (path: string | null) => void
}) {
  const dismiss = useCoachSkillsStore(s => s.dismiss)

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg rounded-br-sm border border-border bg-primary/10 px-3 py-2">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="bg-primary/15 px-1 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-primary">
              {MODE_LABEL[message.mode]}
            </Badge>
            <span className="text-[11.5px] text-foreground">{message.content}</span>
          </div>
        </div>
      </div>
    )
  }

  // The draft card is the FINISHED result of a build-skill run — while the
  // turn streams, show the live text bubble instead (the card's actions make
  // no sense on a half-written draft).
  const hasDraft = !!message.draft && !message.streaming

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-lg rounded-bl-sm border border-border bg-card">
        {hasDraft && message.draft ? (
          <DraftCard message={message} onSave={onSave} dismiss={dismiss} />
        ) : (
          <div className="px-3 py-2">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                {MODE_LABEL[message.mode]}
              </Badge>
              {message.streaming && <span className="text-[10px] text-muted-foreground">running…</span>}
              {message.error && <span className="text-[10px] text-destructive">{message.error}</span>}
            </div>
            <ToolNotices tools={message.tools} />
            {message.content ? (
              <p className="mt-1.5 text-[11.5px] leading-relaxed whitespace-pre-wrap text-foreground">{message.content}</p>
            ) : (
              !message.error && (
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  {message.mode === 'build-skill' ? 'Drafting SKILL.md from the detected evidence…' : 'Waiting for the harness…'}
                </p>
              )
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** The scrollable conversation (elements.ai-sdk.dev Conversation-inspired):
 *  the message list, auto-scroll anchor, and the save-notice line. */
export function Thread({ messages, saveNotice, onSave, threadEndRef }: {
  messages: ChatMessage[]
  saveNotice: string | null
  onSave: (path: string | null) => void
  threadEndRef: RefObject<HTMLDivElement | null>
}) {
  if (messages.length === 0) {
    return null
  }
  return (
    <div className="flex max-h-[50vh] flex-col gap-2.5 overflow-y-auto p-3.5">
      {messages.map(message => (
        <MessageBubble key={message.id} message={message} onSave={onSave} />
      ))}
      {saveNotice && <div className="text-center text-[10px] text-muted-foreground">{saveNotice}</div>}
      <div ref={threadEndRef} />
    </div>
  )
}

