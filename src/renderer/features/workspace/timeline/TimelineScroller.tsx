import { LegendList, type LegendListRef, type MaintainScrollAtEndOptions } from '@legendapp/list/react'
import { ArrowDownIcon } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'

import { readScrollAnchor, type TimelineScrollAnchor, writeScrollAnchor } from './conversation-memory.js'
import { initialTimelineFollow, reduceTimelineFollow, SCROLL_PILL_SHOW_DELAY_MS } from './follow-state.js'
import { attachTimelineViewport, prefersReducedMotion } from './scroll-keys.js'

const MAINTAIN_END = {
  animated: false,
  on: { dataChange: true, itemLayout: true, layout: true },
} satisfies MaintainScrollAtEndOptions

function rowKey(row: { readonly id: string }): string {
  return row.id
}

function rowPosition(list: LegendListRef, key: string) {
  const viewport = list.getScrollableNode()
  if (!viewport) return null
  const row = [...viewport.querySelectorAll<HTMLElement>('[data-message-id]')].find(
    element => element.dataset.messageId === key,
  )
  return row ? { viewport, offset: row.getBoundingClientRect().top - viewport.getBoundingClientRect().top } : null
}

async function restorePosition(
  list: LegendListRef,
  anchor: TimelineScrollAnchor,
  isCurrent: () => boolean,
): Promise<void> {
  await list.scrollToKey({ key: anchor.messageId, viewOffset: anchor.offset, animated: false })
  for (let frame = 0; frame < 6; frame++) {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    if (!isCurrent()) return
    const position = rowPosition(list, anchor.messageId)
    if (!position) continue
    const delta = position.offset - anchor.offset
    if (Math.abs(delta) > 0.5)
      await list.scrollToOffset({ offset: position.viewport.scrollTop + delta, animated: false })
  }
}

/** The list owns measurement, prepend anchoring and live following. React owns the reader controls. */
export function TimelineScroller<Row extends { readonly id: string }>({
  conversationId,
  rows,
  renderRow,
  getRowType,
  extraData,
  historyExhausted = false,
}: {
  readonly conversationId: string
  readonly rows: readonly Row[]
  readonly renderRow: (row: Row) => React.ReactNode
  readonly getRowType: (row: Row) => string
  readonly extraData?: unknown
  readonly historyExhausted?: boolean
}): React.JSX.Element {
  const listRef = useRef<LegendListRef | null>(null)
  const readyRef = useRef(false)
  const [remembered] = useState(() => readScrollAnchor(conversationId))
  const restoredRef = useRef(remembered === null)
  const restoringRef = useRef(false)
  const [restorationPending, setRestorationPending] = useState(remembered !== null)
  const [openingIndex] = useState(() => rows.findIndex(row => row.id === remembered?.messageId))
  const [follow, dispatch] = useReducer(reduceTimelineFollow, remembered !== null, initialTimelineFollow)

  const rememberPosition = useCallback(() => {
    const list = listRef.current
    if (!list || !readyRef.current || !restoredRef.current) return
    const state = list.getState()
    if (state.isFollowingEnd && state.isAtEnd) {
      writeScrollAnchor(conversationId, null)
      return
    }
    if (state.isFollowingEnd) return
    const anchor = list.anchorVisibleContent({ hold: false })
    if (anchor) {
      const offset = rowPosition(list, anchor.key)?.offset ?? -anchor.offset
      writeScrollAnchor(conversationId, { messageId: anchor.key, offset })
    }
  }, [conversationId])

  const setList = useCallback((list: LegendListRef | null) => {
    listRef.current = list
    attachTimelineViewport(list?.getScrollableNode() ?? null, () => list?.cancelScroll())
  }, [])

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const state = list.getState()
    const stopEnd = state.listen('isAtEnd', atEnd => {
      dispatch({ type: 'atEndChanged', atEnd })
    })
    const stopFollow = state.listen('isFollowingEnd', following => {
      dispatch({ type: following ? 'resume' : 'scrolledUp' })
    })
    return () => {
      rememberPosition()
      stopEnd()
      stopFollow()
    }
  }, [rememberPosition])

  useEffect(() => {
    if (follow.pill !== 'pending') return
    const id = window.setTimeout(() => dispatch({ type: 'pillDelayElapsed' }), SCROLL_PILL_SHOW_DELAY_MS)
    return () => window.clearTimeout(id)
  }, [follow.pill])

  // An older page can supply a remembered row that was outside the opening page.
  const restoreAnchor = useCallback(() => {
    if (!readyRef.current || restoredRef.current || restoringRef.current || !remembered) return
    if (!rows.some(row => row.id === remembered.messageId)) {
      if (historyExhausted) {
        restoredRef.current = true
        setRestorationPending(false)
        writeScrollAnchor(conversationId, null)
      }
      return
    }
    const list = listRef.current
    if (!list) return
    restoringRef.current = true
    function finish(): void {
      restoringRef.current = false
      if (listRef.current !== list) return
      restoredRef.current = true
      setRestorationPending(false)
    }
    void restorePosition(list, remembered, () => listRef.current === list && !restoredRef.current).then(finish, finish)
  }, [conversationId, historyExhausted, remembered, rows])
  useLayoutEffect(restoreAnchor, [restoreAnchor])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <LegendList<Row>
        ref={setList}
        data={rows}
        extraData={extraData}
        keyExtractor={rowKey}
        getItemType={getRowType}
        renderItem={({ item }) => (
          <div data-message-id={item.id} className="min-w-0 px-4 pb-3">
            <div className="max-w-chat mx-auto w-full">{renderRow(item)}</div>
          </div>
        )}
        estimatedItemSize={90}
        drawDistance={600}
        recycleItems={false}
        initialScrollAtEnd={remembered === null}
        initialScrollIndex={
          openingIndex >= 0 && remembered ? { index: openingIndex, viewOffset: remembered.offset } : undefined
        }
        maintainVisibleContentPosition
        maintainScrollAtEnd={MAINTAIN_END}
        maintainScrollAtEndThreshold={0.01}
        onReady={() => {
          readyRef.current = true
          restoreAnchor()
          dispatch({ type: 'atEndChanged', atEnd: listRef.current?.getState().isAtEnd ?? false })
        }}
        onScroll={rememberPosition}
        role="region"
        aria-label="Messages"
        className="h-full min-h-0 flex-1 scrollbar-thin scrollbar-gutter-stable overflow-x-hidden overscroll-contain [overflow-anchor:none]"
        style={{ visibility: restorationPending ? 'hidden' : undefined }}
        aria-busy={restorationPending}
        ListHeaderComponent={<div aria-hidden className="h-4" />}
        ListFooterComponent={<div aria-hidden className="h-1" />}
      />
      {restorationPending && (
        <p role="status" className="text-muted-foreground absolute inset-x-4 top-4 text-sm">
          Restoring reading position…
        </p>
      )}
      <Button
        type="button"
        variant="secondary"
        size="icon-sm"
        data-active={follow.pill === 'visible'}
        aria-label="Scroll to end"
        aria-hidden={follow.pill !== 'visible'}
        tabIndex={follow.pill === 'visible' ? 0 : -1}
        title="Scroll to end"
        className="border-border bg-background text-foreground hover:bg-muted hover:text-foreground absolute bottom-4 left-1/2 z-10 -translate-x-1/2 transition-[translate,scale,opacity] duration-200 data-[active=false]:pointer-events-none data-[active=false]:translate-y-full data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-400 data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)]"
        onClick={() => {
          restoredRef.current = true
          setRestorationPending(false)
          writeScrollAnchor(conversationId, null)
          dispatch({ type: 'resume' })
          void listRef.current?.scrollToEnd({ animated: !prefersReducedMotion() })
        }}
      >
        <ArrowDownIcon aria-hidden />
      </Button>
    </div>
  )
}
