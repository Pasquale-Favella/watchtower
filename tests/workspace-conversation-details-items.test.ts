import { describe, expect, it } from 'vitest'

import {
  CONVERSATION_DETAILS_ITEMS,
  decodeConversationDetailsItems,
} from '../src/renderer/features/workspace/use-conversation-details-items.js'

describe('conversation details items', () => {
  it('defaults every supported row to visible', () => {
    const visible = decodeConversationDetailsItems(null)
    expect(Object.keys(visible)).toEqual(CONVERSATION_DETAILS_ITEMS.map(item => item.id))
    expect(Object.values(visible).every(Boolean)).toBe(true)
  })

  it('accepts known boolean choices and ignores unknown or prototype keys', () => {
    const visible = decodeConversationDetailsItems(
      '{"workspace":false,"pullRequests":false,"unknown":false,"__proto__":false,"constructor":false}',
    )
    expect(visible.workspace).toBe(false)
    expect(visible.pullRequests).toBe(false)
    expect(visible.branch).toBe(true)
    expect(visible).not.toHaveProperty('runs')
    expect(CONVERSATION_DETAILS_ITEMS.map(item => item.label)).not.toContain('Agent runs')
    expect(Object.keys(visible)).toEqual(CONVERSATION_DETAILS_ITEMS.map(item => item.id))
  })

  it('falls back to defaults for malformed or oversized data', () => {
    expect(decodeConversationDetailsItems('{')).toEqual(decodeConversationDetailsItems(null))
    expect(decodeConversationDetailsItems('x'.repeat(10_001))).toEqual(decodeConversationDetailsItems(null))
  })
})
