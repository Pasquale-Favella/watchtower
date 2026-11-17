import { describe, expect, it } from 'vitest'

import { resolveConversationDetailsLayout } from '../src/renderer/features/workspace/use-conversation-details-layout.js'

describe('conversation details placement', () => {
  it('requires enough width for the card, chat clearance and a usable conversation', () => {
    expect(resolveConversationDetailsLayout(995, 800)).toBe('popover')
    expect(resolveConversationDetailsLayout(996, 800)).toBe('inline')
    expect(resolveConversationDetailsLayout(1600, 800)).toBe('inline')
  })

  it('falls back to a popover when the available height cannot fit the card', () => {
    expect(resolveConversationDetailsLayout(1600, 183)).toBe('popover')
    expect(resolveConversationDetailsLayout(1600, 184)).toBe('inline')
    expect(resolveConversationDetailsLayout(0, 0)).toBe('popover')
  })
})
