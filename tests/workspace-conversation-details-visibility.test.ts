import { describe, expect, it } from 'vitest'

import {
  CONVERSATION_DETAILS_VISIBILITY_LIMIT,
  type ConversationDetailsVisibilityStorage,
  initialConversationDetailsOpen,
  readConversationDetailsPreferences,
  rememberConversationDetailsOpen,
  transitionConversationDetailsState,
} from '../src/renderer/features/workspace/conversation-details-visibility.js'

class MemoryStorage implements ConversationDetailsVisibilityStorage {
  value: string | null = null
  getItem(): string | null {
    return this.value
  }
  setItem(_key: string, value: string): void {
    this.value = value
  }
}

describe('conversation details visibility', () => {
  it('defaults inline open and popover closed', () => {
    expect(initialConversationDetailsOpen('conversation-a', 'inline', {})).toBe(true)
    expect(initialConversationDetailsOpen('conversation-a', 'popover', {})).toBe(false)
  })

  it('remembers inline visibility independently for each Conversation', () => {
    const storage = new MemoryStorage()
    const preferences = rememberConversationDetailsOpen(storage, {}, 'conversation-a', false)
    const next = rememberConversationDetailsOpen(storage, preferences, 'conversation-b', true)

    expect(readConversationDetailsPreferences(storage)).toEqual({ 'conversation-a': false, 'conversation-b': true })
    expect(initialConversationDetailsOpen('conversation-a', 'inline', next)).toBe(false)
    expect(initialConversationDetailsOpen('conversation-b', 'inline', next)).toBe(true)
  })

  it('ignores malformed storage and malformed entries', () => {
    const storage = new MemoryStorage()
    storage.value = '{broken'
    expect(readConversationDetailsPreferences(storage)).toEqual({})
    storage.value = JSON.stringify({ valid: false, ignored: 'no', empty: null })
    expect(readConversationDetailsPreferences(storage)).toEqual({ valid: false })
  })

  it('uses own preference keys instead of inherited object properties', () => {
    expect(initialConversationDetailsOpen('constructor', 'inline', {})).toBe(true)
    expect(initialConversationDetailsOpen('toString', 'inline', {})).toBe(true)
    expect(initialConversationDetailsOpen('constructor', 'inline', { constructor: false })).toBe(false)
  })

  it('bounds stored keys and moves updated keys to the newest position', () => {
    const storage = new MemoryStorage()
    const oversized = Object.fromEntries(
      Array.from({ length: CONVERSATION_DETAILS_VISIBILITY_LIMIT + 2 }, (_, i) => [`c${i}`, true]),
    )
    storage.value = JSON.stringify(oversized)
    const loaded = readConversationDetailsPreferences(storage)
    expect(Object.keys(loaded)).toHaveLength(CONVERSATION_DETAILS_VISIBILITY_LIMIT)
    expect(loaded.c0).toBeUndefined()
    const updated = rememberConversationDetailsOpen(storage, loaded, 'c2', false)
    expect(Object.keys(updated)).toHaveLength(CONVERSATION_DETAILS_VISIBILITY_LIMIT)
    expect(Object.keys(updated).at(-1)).toBe('c2')
    expect(readConversationDetailsPreferences(storage).c2).toBe(false)
  })

  it('resets popover state on mode changes and never carries it through resize', () => {
    const preferences = { 'conversation-a': true }
    const openedPopover = { key: 'conversation-a', mode: 'popover' as const, open: true }
    const returnedInline = transitionConversationDetailsState('conversation-a', 'inline', openedPopover, preferences)
    expect(returnedInline.open).toBe(true)
    const reopenedAsPopover = transitionConversationDetailsState(
      'conversation-a',
      'popover',
      returnedInline,
      preferences,
    )
    expect(reopenedAsPopover.open).toBe(false)
  })

  it('commits Conversation changes so returning to a prior key cannot restore a stale popover', () => {
    const preferences = { 'conversation-a': true }
    const opened = { key: 'conversation-a', mode: 'popover' as const, open: true }
    const switched = transitionConversationDetailsState('conversation-b', 'popover', opened, preferences)
    expect(switched.open).toBe(false)
    const returned = transitionConversationDetailsState('conversation-a', 'popover', switched, preferences)
    expect(returned.open).toBe(false)
  })
})
