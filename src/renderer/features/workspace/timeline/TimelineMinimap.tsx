import type { LegendListRef } from '@legendapp/list/react'
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { TextTooltip, Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
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
const STEP_BUTTON_CLASS =
  'absolute left-0 opacity-0 transition-opacity duration-150 group-hover/minimap:opacity-100 focus-visible:opacity-100 active:not-aria-[haspopup]:translate-y-0'

interface Metrics {
  readonly gutter: number
  readonly currentIndex: number
  readonly previousIndex: number
  readonly nextIndex: number
}

interface ActiveMark {
  readonly index: number
  readonly anchor: HTMLSpanElement | null
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
  const [hovered, setHovered] = useState<ActiveMark | null>(null)
  const [focused, setFocused] = useState<ActiveMark | null>(null)
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
  const activeMark = hovered ?? focused
  const activeIndex = activeMark?.index ?? null
  const active = activeMark ? items[activeMark.index] : null
  const railHeight = `min(${(count - 1) * TIMELINE_MINIMAP_MARK_GAP_PX}px, max(4rem, calc(100% - 14.75rem)))`

  const indexAtPointer = (clientY: number): number => {
    const box = rail.current?.getBoundingClientRect()
    return box ? minimapIndexAt(clientY, box.top, box.height, count) : 0
  }
  function markAtIndex(index: number): ActiveMark {
    return { index, anchor: marks.current.get(index) ?? null }
  }

  function hoverAtPointer(clientY: number): void {
    const mark = markAtIndex(indexAtPointer(clientY))
    setHovered(previous => (previous?.anchor === mark.anchor && previous.index === mark.index ? previous : mark))
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
        <TextTooltip
          label="Previous message"
          side="right"
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Previous message"
              disabled={metrics.previousIndex < 0}
              className={cn(
                STEP_BUTTON_CLASS,
                'bottom-full mb-1.5',
                interactive ? 'pointer-events-auto' : 'pointer-events-none',
              )}
              onClick={() => select(metrics.previousIndex)}
            >
              <ChevronUpIcon aria-hidden />
            </Button>
          }
        />
        <Tooltip disableHoverablePopup disabled={!interactive || dragging}>
          <TooltipTrigger
            render={<button />}
            closeOnClick={false}
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
              else hoverAtPointer(event.clientY)
            }}
            onPointerMove={event => hoverAtPointer(event.clientY)}
            onPointerLeave={() => setHovered(null)}
            onFocus={() => setFocused(markAtIndex(Math.max(0, metrics.currentIndex)))}
            onBlur={() => setFocused(null)}
            onClick={event => {
              const index = event.detail === 0 ? (focused?.index ?? 0) : indexAtPointer(event.clientY)
              select(index)
              if (event.detail !== 0) event.currentTarget.blur()
            }}
            onKeyDown={event => {
              const current = focused?.index ?? Math.max(0, metrics.currentIndex)
              let next: number | null = null
              if (event.key === 'ArrowUp') next = current - 1
              else if (event.key === 'ArrowDown') next = current + 1
              else if (event.key === 'Home') next = 0
              else if (event.key === 'End') next = count - 1
              if (next === null) return
              event.preventDefault()
              setFocused(markAtIndex(Math.min(count - 1, Math.max(0, next))))
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
          </TooltipTrigger>
          {active && activeMark && (
            <TooltipContent
              anchor={activeMark.anchor}
              side="right"
              sideOffset={10}
              className="pointer-events-none block w-80 max-w-[calc(100vw-1rem)]"
            >
              <p className="truncate font-medium">{active.userText || 'User message'}</p>
              {active.assistantText && <p className="mt-1 line-clamp-3 opacity-80">{active.assistantText}</p>}
            </TooltipContent>
          )}
        </Tooltip>
        <TextTooltip
          label="Next message"
          side="right"
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Next message"
              disabled={metrics.nextIndex < 0}
              className={cn(
                STEP_BUTTON_CLASS,
                'top-full mt-1.5',
                interactive ? 'pointer-events-auto' : 'pointer-events-none',
              )}
              onClick={() => select(metrics.nextIndex)}
            >
              <ChevronDownIcon aria-hidden />
            </Button>
          }
        />
      </div>
    </div>
  )
}
