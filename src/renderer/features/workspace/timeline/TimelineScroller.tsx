import { ArrowDownIcon } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from '@/renderer/components/ui/message-scroller'

import { readScrollAnchor, type TimelineScrollAnchor, writeScrollAnchor } from './conversation-memory.js'
import { initialTimelineFollow, reduceTimelineFollow, SCROLL_PILL_SHOW_DELAY_MS } from './follow-state.js'
import { attachTimelineViewport, prefersReducedMotion } from './scroll-keys.js'

/** Distance from the bottom that still counts as the end, absorbing sub-pixel rounding. */
const AT_END_SLACK_PX = 8

/**
 * The chat timeline on the shared MessageScroller primitives. The primitive keeps the viewport following
 * the end, holds the reading anchor when older rows are prepended, and provides programmatic scrolling.
 * Reader release, the remembered reading position and the "Scroll to end" pill are coordinated here.
 * Rows are passed as children.
 */
export function TimelineScroller({
  conversationId,
  restoreKey,
  children,
}: {
  readonly conversationId: string
  /** Changes whenever rows change, so a remembered anchor can be retried once its row is rendered. */
  readonly restoreKey: number
  readonly children: React.ReactNode
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  // Read once per mount: the Conversation view remounts when the Conversation changes.
  const [remembered] = useState(() => readScrollAnchor(conversationId))
  const setViewport = useCallback((element: HTMLDivElement | null) => {
    viewportRef.current = element
    attachTimelineViewport(element)
  }, [])
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end" scrollPreviousItemPeek={64}>
      <MessageScroller className="flex-1">
        <MessageScrollerViewport ref={setViewport}>
          <MessageScrollerContent aria-live="polite" className="gap-5 p-4">
            {children}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <TimelineFollowControls
          conversationId={conversationId}
          restoreKey={restoreKey}
          remembered={remembered}
          viewportRef={viewportRef}
        />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}

function findRow(viewport: HTMLElement, messageId: string): HTMLElement | null {
  for (const row of viewport.querySelectorAll<HTMLElement>('[data-message-id]')) {
    if (row.dataset.messageId === messageId) return row
  }
  return null
}

/** The first row whose bottom edge is inside the viewport, measured from the viewport top. */
function anchorAt(viewport: HTMLElement): TimelineScrollAnchor | null {
  const top = viewport.getBoundingClientRect().top
  for (const row of viewport.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const rect = row.getBoundingClientRect()
    if (rect.bottom > top && row.dataset.messageId) return { messageId: row.dataset.messageId, offset: rect.top - top }
  }
  return null
}

function isAtEnd(viewport: HTMLElement): boolean {
  return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= AT_END_SLACK_PX
}

function TimelineFollowControls({
  conversationId,
  restoreKey,
  remembered,
  viewportRef,
}: {
  readonly conversationId: string
  readonly restoreKey: number
  readonly remembered: TimelineScrollAnchor | null
  readonly viewportRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element | null {
  const { scrollToEnd, scrollToMessage } = useMessageScroller()
  const [follow, dispatch] = useReducer(reduceTimelineFollow, remembered !== null, initialTimelineFollow)
  const followRef = useRef(follow)
  useEffect(() => {
    followRef.current = follow
  }, [follow])

  useEffect(() => {
    if (follow.pill !== 'pending') return
    const id = window.setTimeout(() => {
      dispatch({ type: 'pillDelayElapsed' })
    }, SCROLL_PILL_SHOW_DELAY_MS)
    return () => {
      window.clearTimeout(id)
    }
  }, [follow.pill])

  // Set once the remembered row has been restored; until then, reporting must not replace the memory.
  const restoredRef = useRef(false)

  // The viewport geometry is the source of truth. The primitive's own end snapshot is stale until its
  // first scroll commit, which would otherwise release a position that has just been restored.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    let lastTop = viewport.scrollTop
    let frame = 0
    let movedUp = false
    let reportedAtEnd: boolean | null = null
    const measure = () => {
      frame = 0
      const atEnd = isAtEnd(viewport)
      if (atEnd !== reportedAtEnd) {
        reportedAtEnd = atEnd
        dispatch({ type: 'atEndChanged', atEnd })
      }
      const released = movedUp || followRef.current.released
      movedUp = false
      // A remembered row that has not loaded yet still owns the memory; never overwrite it with a guess.
      if (!released || (remembered !== null && !restoredRef.current)) return
      if (atEnd) {
        if (followRef.current.released) writeScrollAnchor(conversationId, null)
        return
      }
      const anchor = anchorAt(viewport)
      if (anchor) writeScrollAnchor(conversationId, anchor)
    }
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure)
    }
    const onScroll = () => {
      const top = viewport.scrollTop
      if (top < lastTop - 1) {
        movedUp = true
        dispatch({ type: 'scrolledUp' })
      }
      lastTop = top
      schedule()
    }
    // Streamed output and older pages change the height without a scroll event.
    const content = viewport.firstElementChild
    const resizeObserver = content && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
    if (content) resizeObserver?.observe(content)
    viewport.addEventListener('scroll', onScroll, { passive: true })
    schedule()
    return () => {
      viewport.removeEventListener('scroll', onScroll)
      resizeObserver?.disconnect()
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [conversationId, remembered, viewportRef])

  // Restore the remembered reader position once its row is rendered. Scrolling to a row also marks
  // the primitive's default end position as applied, so that default does not override the restore.
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!remembered || restoredRef.current || !viewport) return
    if (!findRow(viewport, remembered.messageId)) return
    restoredRef.current = true
    scrollToMessage(remembered.messageId, { align: 'start', behavior: 'auto' })
  }, [remembered, restoreKey, scrollToMessage, viewportRef])

  if (follow.pill !== 'visible') return null
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-sm"
      onClick={() => {
        dispatch({ type: 'resume' })
        scrollToEnd({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
      }}
    >
      <ArrowDownIcon aria-hidden />
      Scroll to end
    </Button>
  )
}
