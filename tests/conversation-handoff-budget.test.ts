import { describe, expect, it } from 'vitest'

import { CONVERSATION_HANDOFF_MAX_CHARS, handoffBudget } from '@/core/application/execution/conversation-context.js'

describe('handoffBudget', () => {
  it('keeps the default budget when the target model context window is not reported', () => {
    expect(handoffBudget(undefined)).toEqual({ chars: CONVERSATION_HANDOFF_MAX_CHARS, source: 'default' })
  })

  it('sizes the budget from a reported context window and records that source', () => {
    const small = handoffBudget(8_000)
    expect(small.source).toBe('reported-context-window')
    expect(small.chars).toBeGreaterThan(0)
    expect(small.chars).toBeLessThan(CONVERSATION_HANDOFF_MAX_CHARS)
  })

  it('never exceeds the default budget, however large the reported window', () => {
    expect(handoffBudget(10_000_000)).toEqual({
      chars: CONVERSATION_HANDOFF_MAX_CHARS,
      source: 'reported-context-window',
    })
  })

  it('grows monotonically with the reported window', () => {
    expect(handoffBudget(4_000).chars).toBeLessThan(handoffBudget(16_000).chars)
  })

  it.each([0, -1, 1.5, Number.NaN])('ignores an invalid reported window %s and uses the default', tokens => {
    expect(handoffBudget(tokens)).toEqual({ chars: CONVERSATION_HANDOFF_MAX_CHARS, source: 'default' })
  })
})
