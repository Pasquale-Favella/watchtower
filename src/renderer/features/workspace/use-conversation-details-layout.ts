import { type CSSProperties, useEffect, useState } from 'react'

export type ConversationDetailsMode = 'inline' | 'popover'

/** Keep in sync with the inline card's width. */
export const CONVERSATION_DETAILS_WIDTH = 280
/** Space between the card and the container edge it is pinned to. */
export const CONVERSATION_DETAILS_GAP = 12
/** Space kept between the card and the conversation content so neither overlaps. */
export const CONVERSATION_DETAILS_CLEARANCE = 32
const MIN_CONVERSATION_WIDTH = 640
const CONVERSATION_PADDING = 32
const MIN_CARD_HEIGHT = 160

/** Width the conversation lane gives up while the inline card is shown. */
export function conversationDetailsReservedWidth(): number {
  return CONVERSATION_DETAILS_WIDTH + CONVERSATION_DETAILS_GAP + CONVERSATION_DETAILS_CLEARANCE
}

/** Preserve the centered chat lane until it would touch the card. */
export const CONVERSATION_DETAILS_LANE_INSET = `clamp(0px, calc(${conversationDetailsReservedWidth() * 2}px + 46rem - 100%), ${conversationDetailsReservedWidth()}px)`

/**
 * Set on the element that holds the timeline, composer and inline card. Scrollers stay full width, so their
 * scrollbar keeps to the edge, and only the chat lane inside them steps aside from the card.
 */
export const CONVERSATION_DETAILS_LANE_STYLE = {
  '--chat-lane-inset-end': CONVERSATION_DETAILS_LANE_INSET,
} as CSSProperties

/**
 * Inline is only used when the card fits beside a still-usable conversation
 * lane; narrow containers fall back to the popover anchored to the header.
 */
export function resolveConversationDetailsLayout(width: number, height: number): ConversationDetailsMode {
  const fitsWidth = width - conversationDetailsReservedWidth() - CONVERSATION_PADDING >= MIN_CONVERSATION_WIDTH
  const fitsHeight = height - CONVERSATION_DETAILS_GAP * 2 >= MIN_CARD_HEIGHT
  return fitsWidth && fitsHeight ? 'inline' : 'popover'
}

export function useConversationDetailsLayout(): {
  readonly measureContainer: (node: HTMLDivElement | null) => void
  readonly mode: ConversationDetailsMode
} {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 })

  useEffect(() => {
    if (!container) return
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [container])

  return {
    measureContainer: setContainer,
    mode: resolveConversationDetailsLayout(size.width, size.height),
  }
}
