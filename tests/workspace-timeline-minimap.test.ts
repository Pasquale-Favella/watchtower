import { describe, expect, it } from 'vitest'

import {
  buildTimelineMinimapItems,
  minimapIndexAt,
  minimapMarkOffset,
  minimapMarkScale,
  minimapStepTargets,
  minimapTurnVisible,
  plainPreviewText,
} from '../src/renderer/features/workspace/timeline/timeline-minimap.js'
import type { TimelineRow } from '../src/renderer/features/workspace/timeline/timeline-rows.js'

const user = (id: string, content: string): TimelineRow =>
  ({ kind: 'user', id, entry: { kind: 'user', id, sequence: 0, message: { content } } }) as unknown as TimelineRow
const text = (id: string, value: string): TimelineRow =>
  ({ kind: 'segment', id, segment: { kind: 'block', block: { kind: 'text', text: value } } }) as unknown as TimelineRow
const other = (id: string): TimelineRow => ({ kind: 'leading', id }) as TimelineRow

describe('timeline minimap items', () => {
  it('makes one item per user message with the last reply text of its turn', () => {
    const items = buildTimelineMinimapItems([
      other('leading'),
      user('u1', 'Fix the **build**'),
      text('a1', 'Looking'),
      text('a2', 'Done: see [the log](https://x)'),
      user('u2', '# Next'),
    ])
    expect(items).toEqual([
      { id: 'u1', rowIndex: 1, userText: 'Fix the build', assistantText: 'Done: see the log' },
      { id: 'u2', rowIndex: 4, userText: 'Next', assistantText: '' },
    ])
  })

  it('ignores replies before the first user message', () => {
    expect(buildTimelineMinimapItems([text('a0', 'hello'), user('u1', 'hi')])).toEqual([
      { id: 'u1', rowIndex: 1, userText: 'hi', assistantText: '' },
    ])
  })

  it('flattens markdown into one line and drops code fences', () => {
    expect(plainPreviewText('- one\n- `two`\n\n```ts\nconst x = 1\n```\n> quoted')).toBe('one two quoted')
  })
})

describe('timeline minimap geometry', () => {
  it('spaces marks evenly and maps the pointer to the nearest mark', () => {
    expect(minimapMarkOffset(0, 5)).toBe(0)
    expect(minimapMarkOffset(4, 5)).toBe(100)
    expect(minimapMarkOffset(0, 1)).toBe(0)
    expect(minimapIndexAt(100, 100, 40, 5)).toBe(0)
    expect(minimapIndexAt(121, 100, 40, 5)).toBe(2)
    expect(minimapIndexAt(500, 100, 40, 5)).toBe(4)
    expect(minimapIndexAt(0, 100, 40, 5)).toBe(0)
  })

  it('shrinks marks away from the hovered one', () => {
    expect([null, 0, 1, 2, 3, 9].map(minimapMarkScale)).toEqual([1, 1, 0.667, 0.417, 0.333, 0.333])
  })

  it('lights every turn that overlaps the viewport', () => {
    expect(minimapTurnVisible(0, 100, 50, 200)).toBe(true)
    expect(minimapTurnVisible(0, 50, 50, 200)).toBe(false)
    expect(minimapTurnVisible(250, 300, 50, 200)).toBe(false)
  })

  it('steps relative to the reading line so Previous never re-targets the message it just aligned', () => {
    const turns = [
      { start: 0, end: 400 },
      { start: 400, end: 900 },
      { start: 900, end: 1000 },
    ]
    // Message 1 was just aligned at the 24px jump inset.
    expect(minimapStepTargets(turns, 376)).toEqual({ current: 1, previous: 0, next: 2 })
    // Mid-way through turn 1, Previous returns to its own start.
    expect(minimapStepTargets(turns, 600)).toEqual({ current: 1, previous: 1, next: 2 })
    expect(minimapStepTargets(turns, -24)).toEqual({ current: 0, previous: -1, next: 1 })
    expect(minimapStepTargets([], 0)).toEqual({ current: -1, previous: -1, next: -1 })
  })
})
