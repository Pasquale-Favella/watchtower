import type { LegendListRef } from '@legendapp/list/react'
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { cn } from '@/renderer/shared/lib/utils'

import {
  minimapIndexAt,
  minimapMarkOffset,
  minimapMarkScale,
  minimapStepTargets,
  minimapTurnVisible,
  TIMELINE_MINIMAP_ALWAYS_VISIBLE_GUTTER_PX,
  TIMELINE_MINIMAP_MARK_GAP_PX,
  TIMELINE_MINIMAP_MIN_ITEMS,
  type TimelineMinimapItem,
} from './timeline-minimap.js'

const LINE_HEIGHT_PX = 16

interface Metrics {
  readonly gutter: number
  readonly currentIndex: number
  readonly previousIndex: number
  readonly nextIndex: number
}

/**
 * A rail of one mark per user message on the left edge of the timeline. Marks light up while their turn is on
 * screen, hovering previews the exchange, and clicking or the arrow keys jump to the message.
 */
export function TimelineMinimap({
  items,
  list,
  onSelect,
}: {
  readonly items: readonly TimelineMinimapItem[]
  readonly list: () => LegendListRef | null
  readonly onSelect: (item: TimelineMinimapItem) => void
}): React.JSX.Element | null {
  const marks = useRef(new Map<number, HTMLSpanElement>())
  const rail = useRef<HTMLButtonElement | null>(null)
  const [metrics, setMetrics] = useState<Metrics>({ gutter: 0, currentIndex: -1, previousIndex: -1, nextIndex: -1 })
  const [hovered, setHovered] = useState<number | null>(null)
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const enabled = items.length >= TIMELINE_MINIMAP_MIN_ITEMS

  const refresh = useCallback(() => {
    const ref = list()
    const viewport = ref?.getScrollableNode()
    if (!ref || !viewport) return
    const state = ref.getState()
    // Row positions exclude the list header while scrollTop includes it.
    const headerHeight = viewport.querySelector<HTMLElement>('[data-timeline-header]')?.offsetHeight ?? 0
    const lastRow = state.data.length - 1
    const end = headerHeight + (lastRow >= 0 ? state.positionAtIndex(lastRow) + state.sizeAtIndex(lastRow) : 0)
    const turns = items.map((item, index) => {
      const next = items[index + 1]
      return {
        start: headerHeight + state.positionAtIndex(item.rowIndex),
        end: next ? headerHeight + state.positionAtIndex(next.rowIndex) : end,
      }
    })
    const scroll = viewport.scrollTop
    const length = viewport.clientHeight
    turns.forEach((turn, index) => {
      const mark = marks.current.get(index)
      const inView = String(minimapTurnVisible(turn.start, turn.end, scroll, length))
      if (mark && mark.dataset.inView !== inView) mark.dataset.inView = inView
    })
    const content = viewport.querySelector<HTMLElement>('[data-message-id] > div')
    const contentWidth = content?.getBoundingClientRect().width ?? viewport.clientWidth
    const gutter = Math.max(0, (viewport.clientWidth - contentWidth) / 2)
    const targets = minimapStepTargets(turns, scroll)
    // At the very end nothing lies further down to jump to.
    const nextIndex = viewport.scrollHeight - scroll - length <= 1 ? -1 : targets.next
    setMetrics(previous =>
      Math.abs(previous.gutter - gutter) < 1 &&
      previous.currentIndex === targets.current &&
      previous.previousIndex === targets.previous &&
      previous.nextIndex === nextIndex
        ? previous
        : { gutter, currentIndex: targets.current, previousIndex: targets.previous, nextIndex },
    )
  }, [items, list])

  useLayoutEffect(() => {
    if (!enabled) return
    const viewport = list()?.getScrollableNode()
    if (!viewport) return
    let frame = 0
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        refresh()
      })
    }
    schedule()
    viewport.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(viewport)
    const content = viewport.firstElementChild
    if (content) observer.observe(content)
    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('scroll', schedule)
      observer.disconnect()
    }
  }, [enabled, list, refresh])

  useEffect(() => {
    if (!dragging) return
    const release = () => setDragging(false)
    window.addEventListener('pointerup', release)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('blur', release)
    }
  }, [dragging])

  if (!enabled) return null

  const count = items.length
  const hitWidth = Math.min(40, Math.max(0, Math.floor(metrics.gutter) - 12))
  const alwaysVisible = metrics.gutter >= TIMELINE_MINIMAP_ALWAYS_VISIBLE_GUTTER_PX
  // The rail is interactive only when it fits in the gutter; otherwise it would cover transcript text.
  const interactive = hitWidth >= 24
  const activeIndex = hovered ?? focusedIndex
  const active = activeIndex === null ? null : items[activeIndex]
  const railHeight = `min(${(count - 1) * TIMELINE_MINIMAP_MARK_GAP_PX}px, max(4rem, calc(100% - 14.75rem)))`

  const indexAtPointer = (clientY: number): number => {
    const box = rail.current?.getBoundingClientRect()
    return box ? minimapIndexAt(clientY, box.top, box.height, count) : 0
  }
  const select = (index: number) => {
    const item = items[index]
    if (item) onSelect(item)
  }

  return (
    <div
      data-slot="timeline-minimap"
      className={cn(
        'pointer-events-none absolute inset-y-0 left-0 z-40 w-18',
        alwaysVisible
          ? 'opacity-100'
          : 'hidden opacity-0 transition-opacity duration-150 focus-within:opacity-100 hover:opacity-100 [@media(pointer:fine)]:block',
      )}
      onWheel={event => {
        const viewport = list()?.getScrollableNode()
        if (!viewport) return
        const unit = event.deltaMode === 1 ? LINE_HEIGHT_PX : event.deltaMode === 2 ? viewport.clientHeight : 1
        viewport.scrollBy({ top: event.deltaY * unit })
      }}
    >
      <div className="group/minimap absolute top-1/2 left-3 -translate-y-1/2" style={{ height: railHeight }}>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Previous message"
          title="Previous message"
          disabled={metrics.previousIndex < 0}
          className={cn(
            'absolute -top-1.5 left-0 -translate-y-full opacity-0 group-hover/minimap:opacity-100 focus-visible:opacity-100',
            interactive ? 'pointer-events-auto' : 'pointer-events-none',
          )}
          onClick={() => select(metrics.previousIndex)}
        >
          <ChevronUpIcon aria-hidden />
        </Button>
        <button
          ref={rail}
          type="button"
          aria-label={`Jump to message: ${(active ?? items[Math.max(0, metrics.currentIndex)])?.userText || 'User message'}`}
          className={cn(
            'focus-visible:ring-ring/70 relative block h-full rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset',
            interactive && !dragging ? 'pointer-events-auto cursor-pointer' : 'pointer-events-none',
          )}
          style={{ width: Math.max(hitWidth, 24) }}
          tabIndex={interactive ? 0 : -1}
          onMouseDown={event => event.preventDefault()}
          onPointerEnter={event => {
            if (event.buttons !== 0) setDragging(true)
          }}
          onPointerMove={event => setHovered(indexAtPointer(event.clientY))}
          onPointerLeave={() => setHovered(null)}
          onFocus={() => setFocusedIndex(Math.max(0, metrics.currentIndex))}
          onBlur={() => setFocusedIndex(null)}
          onClick={event => {
            const index = event.detail === 0 ? (focusedIndex ?? 0) : indexAtPointer(event.clientY)
            select(index)
            if (event.detail !== 0) event.currentTarget.blur()
          }}
          onKeyDown={event => {
            const current = focusedIndex ?? Math.max(0, metrics.currentIndex)
            let next: number | null = null
            if (event.key === 'ArrowUp') next = current - 1
            else if (event.key === 'ArrowDown') next = current + 1
            else if (event.key === 'Home') next = 0
            else if (event.key === 'End') next = count - 1
            if (next === null) return
            event.preventDefault()
            setFocusedIndex(Math.min(count - 1, Math.max(0, next)))
          }}
        >
          {items.map((item, index) => (
            <span
              key={item.id}
              ref={element => {
                if (element) marks.current.set(index, element)
                else marks.current.delete(index)
              }}
              aria-hidden
              data-in-view="false"
              data-active={activeIndex === index}
              className="bg-muted-foreground/25 data-[active=true]:bg-muted-foreground/60 after:bg-foreground/55 absolute left-0 block h-0.5 w-6 origin-left -translate-y-1/2 rounded-full transition-[transform,opacity] duration-150 after:absolute after:inset-0 after:rounded-full after:opacity-0 after:transition-opacity after:duration-150 data-[in-view=true]:after:opacity-100"
              style={{
                top: `${minimapMarkOffset(index, count)}%`,
                transform: `translateY(-50%) scaleX(${minimapMarkScale(activeIndex === null ? null : Math.abs(activeIndex - index))})`,
              }}
            />
          ))}
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Next message"
          title="Next message"
          disabled={metrics.nextIndex < 0}
          className={cn(
            'absolute -bottom-1.5 left-0 translate-y-full opacity-0 group-hover/minimap:opacity-100 focus-visible:opacity-100',
            interactive ? 'pointer-events-auto' : 'pointer-events-none',
          )}
          onClick={() => select(metrics.nextIndex)}
        >
          <ChevronDownIcon aria-hidden />
        </Button>
        {active && activeIndex !== null && (
          <div
            aria-hidden
            className="bg-popover text-popover-foreground pointer-events-none absolute left-8 w-80 -translate-y-1/2 rounded-xl border p-3 shadow-xl shadow-black/25"
            style={{ top: `${minimapMarkOffset(activeIndex, count)}%` }}
          >
            <p className="truncate text-sm font-medium">{active.userText || 'User message'}</p>
            {active.assistantText && (
              <p className="text-muted-foreground mt-1 line-clamp-3 text-sm">{active.assistantText}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
