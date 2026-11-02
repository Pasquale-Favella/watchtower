import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  readExpandedFolds,
  readScrollAnchor,
  resetTimelineMemory,
  setFoldExpanded,
  writeScrollAnchor,
} from '../src/renderer/features/workspace/timeline/conversation-memory.js'
import { elapsedBetween } from '../src/renderer/features/workspace/timeline/duration.js'
import {
  initialTimelineFollow,
  reduceTimelineFollow,
  SCROLL_PILL_SHOW_DELAY_MS,
  type TimelineFollowState,
} from '../src/renderer/features/workspace/timeline/follow-state.js'
import { isCollapsibleMessage } from '../src/renderer/features/workspace/timeline/message-collapse.js'
import {
  attachTimelineViewport,
  canScrollToward,
  handleTimelinePageKey,
  pageDirectionForKey,
  type TimelinePageKeyEvent,
} from '../src/renderer/features/workspace/timeline/scroll-keys.js'

describe('timeline follow state', () => {
  it('follows the end by default and shows no pill', () => {
    expect(initialTimelineFollow(false)).toEqual({ released: false, atEnd: true, pill: 'hidden' })
  })

  it('starts released with a pending pill when a remembered position is restored', () => {
    expect(initialTimelineFollow(true)).toMatchObject({ released: true, pill: 'pending' })
  })

  it('releases on a reader scrolling up and shows the pill only after the delay', () => {
    expect(SCROLL_PILL_SHOW_DELAY_MS).toBe(150)
    let state = reduceTimelineFollow(initialTimelineFollow(false), { type: 'scrolledUp' })
    expect(state).toMatchObject({ released: true, atEnd: false, pill: 'pending' })
    state = reduceTimelineFollow(state, { type: 'pillDelayElapsed' })
    expect(state.pill).toBe('visible')
  })

  it('hides the pill immediately when the reader returns to the end, and resumes following', () => {
    const visible: TimelineFollowState = { released: true, atEnd: false, pill: 'visible' }
    const state = reduceTimelineFollow(visible, { type: 'atEndChanged', atEnd: true })
    expect(state).toEqual({ released: false, atEnd: true, pill: 'hidden' })
  })

  it('does not release for transient gaps while output streams', () => {
    const state = reduceTimelineFollow(initialTimelineFollow(false), { type: 'atEndChanged', atEnd: false })
    expect(state).toEqual({ released: false, atEnd: false, pill: 'hidden' })
  })

  it('keeps a released reader released while new output arrives below', () => {
    let state = reduceTimelineFollow(initialTimelineFollow(false), { type: 'scrolledUp' })
    state = reduceTimelineFollow(state, { type: 'atEndChanged', atEnd: false })
    expect(state).toMatchObject({ released: true, pill: 'pending' })
  })

  it('resume from the pill re-follows and hides it at once', () => {
    const visible: TimelineFollowState = { released: true, atEnd: false, pill: 'visible' }
    expect(reduceTimelineFollow(visible, { type: 'resume' })).toEqual({ released: false, atEnd: false, pill: 'hidden' })
  })

  it('ignores a stale delay expiry after the pill was already hidden', () => {
    const hidden = initialTimelineFollow(false)
    expect(reduceTimelineFollow(hidden, { type: 'pillDelayElapsed' })).toBe(hidden)
  })
})

describe('message collapse thresholds', () => {
  it('folds messages over eight lines', () => {
    expect(isCollapsibleMessage(Array.from({ length: 8 }, () => 'line').join('\n'))).toBe(false)
    expect(isCollapsibleMessage(Array.from({ length: 9 }, () => 'line').join('\n'))).toBe(true)
  })

  it('folds messages over six hundred characters', () => {
    expect(isCollapsibleMessage('x'.repeat(600))).toBe(false)
    expect(isCollapsibleMessage('x'.repeat(601))).toBe(true)
  })
})

describe('elapsed between durable timestamps', () => {
  it('returns null for missing or unparseable values and clamps reversed ranges', () => {
    expect(elapsedBetween(null, '2026-10-30T12:00:01.000Z')).toBeNull()
    expect(elapsedBetween('2026-10-30T12:00:00.000Z', 'not a date')).toBeNull()
    expect(elapsedBetween('2026-10-30T12:00:02.000Z', '2026-10-30T12:00:01.000Z')).toBe(0)
    expect(elapsedBetween('2026-10-30T12:00:00.000Z', '2026-10-30T12:00:04.200Z')).toBe(4200)
  })
})

describe('page keys from the composer', () => {
  type Geometry = { scrollTop: number; scrollHeight: number; clientHeight: number }
  const keyEvent = (key: string, target: Geometry | null) => {
    const preventDefault = vi.fn()
    const event: TimelinePageKeyEvent & { preventDefault: typeof preventDefault } = {
      key,
      currentTarget: target as unknown as EventTarget | null,
      preventDefault,
    }
    return { event, preventDefault }
  }

  it('maps only PageUp and PageDown to a direction', () => {
    expect(pageDirectionForKey('PageUp')).toBe('up')
    expect(pageDirectionForKey('PageDown')).toBe('down')
    expect(pageDirectionForKey('ArrowDown')).toBeNull()
  })

  it('reports whether a geometry can still move toward an edge', () => {
    expect(canScrollToward({ scrollTop: 0, scrollHeight: 1000, clientHeight: 200 }, 'up')).toBe(false)
    expect(canScrollToward({ scrollTop: 10, scrollHeight: 1000, clientHeight: 200 }, 'up')).toBe(true)
    expect(canScrollToward({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 }, 'down')).toBe(false)
    expect(canScrollToward({ scrollTop: 0, scrollHeight: 150, clientHeight: 200 }, 'down')).toBe(false)
  })

  describe('with a mounted timeline', () => {
    let scrollBy: ReturnType<typeof vi.fn>
    beforeEach(() => {
      scrollBy = vi.fn()
      attachTimelineViewport({
        clientHeight: 500,
        isConnected: true,
        scrollBy,
      } as unknown as HTMLElement)
    })
    afterEach(() => {
      attachTimelineViewport(null)
    })

    it('leaves the key to the textarea while it can still scroll', () => {
      const { event, preventDefault } = keyEvent('PageDown', { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 })
      expect(handleTimelinePageKey(event)).toBe(false)
      expect(preventDefault).not.toHaveBeenCalled()
      expect(scrollBy).not.toHaveBeenCalled()
    })

    it('scrolls the timeline by most of a page once the textarea cannot scroll', () => {
      const { event, preventDefault } = keyEvent('PageDown', { scrollTop: 800, scrollHeight: 1000, clientHeight: 200 })
      expect(handleTimelinePageKey(event)).toBe(true)
      expect(preventDefault).toHaveBeenCalledOnce()
      expect(scrollBy).toHaveBeenCalledWith({ top: 450, behavior: 'smooth' })
    })

    it('scrolls up when the textarea is already at its top', () => {
      const { event } = keyEvent('PageUp', { scrollTop: 0, scrollHeight: 100, clientHeight: 200 })
      expect(handleTimelinePageKey(event)).toBe(true)
      expect(scrollBy).toHaveBeenCalledWith({ top: -450, behavior: 'smooth' })
    })

    it('ignores other keys', () => {
      const { event, preventDefault } = keyEvent('Enter', null)
      expect(handleTimelinePageKey(event)).toBe(false)
      expect(preventDefault).not.toHaveBeenCalled()
    })
  })

  it('does not consume the key when no timeline is mounted', () => {
    attachTimelineViewport(null)
    const preventDefault = vi.fn()
    expect(handleTimelinePageKey({ key: 'PageDown', currentTarget: null, preventDefault })).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
  })
})

describe('per-Conversation timeline memory', () => {
  beforeEach(() => {
    resetTimelineMemory()
  })

  it('remembers expanded folds per Conversation and clears them on collapse', () => {
    setFoldExpanded('conversation-1', 'fold:turn-1', true)
    expect([...readExpandedFolds('conversation-1')]).toEqual(['fold:turn-1'])
    expect(readExpandedFolds('conversation-2').size).toBe(0)
    setFoldExpanded('conversation-1', 'fold:turn-1', false)
    expect(readExpandedFolds('conversation-1').size).toBe(0)
  })

  it('remembers a released reading anchor and forgets it when the reader returns to the end', () => {
    expect(readScrollAnchor('conversation-1')).toBeNull()
    writeScrollAnchor('conversation-1', { messageId: 'turn:run-1:1:4', offset: 12 })
    expect(readScrollAnchor('conversation-1')).toEqual({ messageId: 'turn:run-1:1:4', offset: 12 })
    writeScrollAnchor('conversation-1', null)
    expect(readScrollAnchor('conversation-1')).toBeNull()
  })

  it('bounds memory by forgetting the least recently used Conversation first', () => {
    writeScrollAnchor('oldest', { messageId: 'message:1', offset: 0 })
    for (let index = 0; index < 50; index += 1) readScrollAnchor(`filler-${index}`)
    expect(readScrollAnchor('oldest')).toBeNull()
  })
})
