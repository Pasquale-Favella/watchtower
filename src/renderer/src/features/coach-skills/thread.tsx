import { Markdown } from '@/shared/components/Markdown'
import { Badge } from '@/shared/components/ui/badge'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/shared/components/ui/message-scroller'

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
              <div className="typeset typeset-chat mt-1.5 max-w-[37em]">
                <Markdown>{message.content}</Markdown>
              </div>
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

/** The scrollable conversation (shadcn MessageScroller): a chat scroll
 *  container that anchors turns, follows streamed responses, and keeps the
 *  reader's place — without stealing their position. The transcript rows are
 *  wrapped in MessageScrollerItem (anchored on user turns), the viewport
 *  preserves the visible row when history is prepended, and the Button is the
 *  "jump to latest" control. */
export function Thread({ messages, saveNotice, onSave }: {
  messages: ChatMessage[]
  saveNotice: string | null
  onSave: (path: string | null) => void
}) {
  if (messages.length === 0) {
    return null
  }
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor" scrollPreviousItemPeek={64}>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="gap-2.5 p-3.5">
            {messages.map(message => (
              <MessageScrollerItem
                key={message.id}
                messageId={message.id}
                scrollAnchor={message.role === 'user'}
              >
                <MessageBubble message={message} onSave={onSave} />
              </MessageScrollerItem>
            ))}
            {saveNotice && (
              <MessageScrollerItem messageId="save-notice">
                <div className="text-center text-[10px] text-muted-foreground">{saveNotice}</div>
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}

