import { useRef } from 'react'

import { useChatRowIn } from '@/shared/lib/motion'
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

import { MODE_LABEL } from './lib'
import { CopyButton, RetryButton, StreamingDots, ThinkingBlock, ToolCard } from './blocks'
import { useCoachSkillsStore, type ChatMessage } from './store'

/** One thread message (ADR 0017): a user bubble, a streaming assistant turn
 *  with its run-context header, a live Thinking panel (when the harness
 *  reasons), Tool cards (per tool call, with lifecycle + payload previews),
 *  and the streamed markdown — a harness-authored SKILL.md renders right in
 *  the bubble, copyable like any answer. Rows rise gently into place via GSAP
 *  (transform + opacity only, so the scroller's positioning is never fought —
 *  see the MessageScroller docs on animating rows). */
export function MessageBubble({ message, canRetry, onRetry }: {
  message: ChatMessage
  /** Whether this assistant turn is the LAST one — the only one a retry can
   *  regenerate in place (a mid-thread answer has turns after it). */
  canRetry: boolean
  onRetry: () => void
}) {
  const running = useCoachSkillsStore(s => s.running)
  // The row root differs per role; the same ref lands on either branch so the
  // entrance animation targets whichever root actually renders.
  const rowRef = useRef<HTMLDivElement>(null)
  useChatRowIn(rowRef)

  if (message.role === 'user') {
    return (
      <div ref={rowRef} className="flex justify-end">
        <div className="max-w-[80%] rounded-lg rounded-br-sm border border-border bg-primary/10 px-3 py-2">
          <span className="text-[11.5px] leading-relaxed text-foreground">{message.content}</span>
        </div>
      </div>
    )
  }

  return (
    <div ref={rowRef} className="flex justify-start">
      {/* group so the row's actions can hover-reveal on the bubble. */}
      <div className="group max-w-[85%] rounded-lg rounded-bl-sm border border-border bg-card">
        <div className="px-3 py-2">
          {/* Turn header: mode tag, the run's harness/model/mode context
              (captured at spawn), the live streaming / error state, and the
              hover-reveal copy action. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge variant="secondary" className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              {MODE_LABEL[message.mode]}
            </Badge>
            {message.meta?.harness && (
              <span className="text-[9.5px] text-muted-foreground">{message.meta.harness}</span>
            )}
            {message.meta?.model && (
              <span className="hidden items-center gap-0.5 text-[9.5px] text-muted-foreground sm:inline-flex">
                <span aria-hidden>·</span>{message.meta.model}
              </span>
            )}
            {message.meta?.mode && (
              <span className="hidden items-center gap-0.5 text-[9.5px] text-muted-foreground sm:inline-flex">
                <span aria-hidden>·</span>{message.meta.mode}
              </span>
            )}
            {message.streaming && !message.content && <StreamingDots label={message.thinking ? 'Thinking' : 'Working'} />}
            {message.error && <span className="text-[10px] text-destructive">{message.error}</span>}
            <span className="ml-auto flex items-center gap-0.5">
              <CopyButton text={message.content} />
              {canRetry && (
                <RetryButton onRetry={onRetry} disabled={running || message.streaming} />
              )}
            </span>
          </div>

          {/* The thinking/reasoning panel — starts collapsed; the header's
              pulsing dot + elapsed timer show it is live. */}
          {message.thinking && (
            <ThinkingBlock thinking={message.thinking} streaming={message.streaming} />
          )}

          {/* Tool-call activity — one collapsible card per call, starts
              collapsed (the status badge in each header shows the state). */}
          {message.tools.length > 0 && (
            <div className="mt-2 flex flex-col gap-1.5">
              {message.tools.map((notice, index) => (
                <ToolCard key={notice.id ?? `${notice.tool}-${index}`} notice={notice} streaming={message.streaming} />
              ))}
            </div>
          )}

          {message.content ? (
            <div className="typeset typeset-chat mt-1.5 max-w-[37em]">
              <Markdown>{message.content}</Markdown>
            </div>
          ) : (
            !message.error && !message.streaming && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">Waiting for the harness…</p>
            )
          )}
        </div>
      </div>
    </div>
  )
}

/** The scrollable conversation (shadcn MessageScroller): a chat scroll
 *  container that anchors turns, follows streamed responses, and keeps the
 *  reader's place — without stealing their position. The transcript is a
 *  centered readable column (the page IS the surface; there is no card
 *  chrome), rows are wrapped in MessageScrollerItem (anchored on user turns),
 *  the viewport preserves the visible row when history is prepended, and the
 *  Button is the "jump to latest" control. */
export function Thread({ messages }: {
  messages: ChatMessage[]
}) {
  if (messages.length === 0) {
    return null
  }
  const streaming = messages.some(message => message.streaming)
  const retryAssistant = useCoachSkillsStore(s => s.retryAssistant)
  // The last assistant turn is the one a retry can regenerate in place.
  const lastAssistantId = [...messages].reverse().find(m => m.role === 'assistant')?.id ?? null
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor" scrollPreviousItemPeek={64}>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent aria-busy={streaming} className="mx-auto w-full max-w-[760px] gap-2.5 p-3.5">
            {messages.map(message => (
              <MessageScrollerItem
                key={message.id}
                messageId={message.id}
                scrollAnchor={message.role === 'user'}
              >
                <MessageBubble
                  message={message}
                  canRetry={message.role === 'assistant' && message.id === lastAssistantId}
                  onRetry={() => { void retryAssistant(message.id) }}
                />
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
