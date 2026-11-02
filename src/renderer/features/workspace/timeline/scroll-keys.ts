export type TimelinePageDirection = 'up' | 'down'

/** The scrollable geometry this module reads. An HTMLElement satisfies it; tests supply plain values. */
export interface ScrollGeometry {
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
}

/** The subset of a keyboard event the page-key handler needs. */
export interface TimelinePageKeyEvent {
  readonly key: string
  readonly currentTarget: EventTarget | null
  preventDefault(): void
}

/** Share of the viewport height one page key moves; the remainder keeps the reader's place. */
const PAGE_SCROLL_RATIO = 0.9

/** Lets the timeline's scroll position answer for PageUp/PageDown pressed in the composer. */
let activeViewport: HTMLElement | null = null

export function attachTimelineViewport(element: HTMLElement | null): void {
  activeViewport = element
}

export function pageDirectionForKey(key: string): TimelinePageDirection | null {
  if (key === 'PageUp') return 'up'
  if (key === 'PageDown') return 'down'
  return null
}

/** Whether the geometry can still move in the direction; the 1px slack absorbs fractional scroll offsets. */
export function canScrollToward(geometry: ScrollGeometry, direction: TimelinePageDirection): boolean {
  if (geometry.scrollHeight <= geometry.clientHeight) return false
  if (direction === 'up') return geometry.scrollTop > 0
  return geometry.scrollTop + geometry.clientHeight < geometry.scrollHeight - 1
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/** Scroll the attached timeline by one page. Returns false when no timeline is mounted. */
export function scrollTimelinePage(direction: TimelinePageDirection): boolean {
  const viewport = activeViewport
  if (!viewport || !viewport.isConnected) return false
  const distance = Math.round(viewport.clientHeight * PAGE_SCROLL_RATIO) * (direction === 'up' ? -1 : 1)
  viewport.scrollBy({ top: distance, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  return true
}

/**
 * Handles PageUp/PageDown from the composer textarea. The textarea keeps the key while it can still scroll;
 * once it cannot, the timeline scrolls by a page instead. Returns true when the key was consumed.
 */
export function handleTimelinePageKey(event: TimelinePageKeyEvent): boolean {
  const direction = pageDirectionForKey(event.key)
  if (direction === null) return false
  const target = event.currentTarget as Partial<ScrollGeometry> | null
  if (
    target &&
    typeof target.scrollTop === 'number' &&
    typeof target.scrollHeight === 'number' &&
    typeof target.clientHeight === 'number' &&
    canScrollToward(
      { scrollTop: target.scrollTop, scrollHeight: target.scrollHeight, clientHeight: target.clientHeight },
      direction,
    )
  ) {
    return false
  }
  if (!scrollTimelinePage(direction)) return false
  event.preventDefault()
  return true
}

export interface TimelineScrollKeys {
  /** Call from the composer's keydown handler; returns true when the timeline consumed the key. */
  readonly handlePageKey: (event: TimelinePageKeyEvent) => boolean
}

const timelineScrollKeys: TimelineScrollKeys = { handlePageKey: handleTimelinePageKey }

/** Stable handle for the composer. The timeline registers its viewport, so no provider is needed. */
export function useTimelineScrollKeys(): TimelineScrollKeys {
  return timelineScrollKeys
}
