import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { describe, expect, it } from 'vitest'

import {
  clearNewChatDraftIfUnchangedAtom,
  newChatDraftAtom,
  updateNewChatDraftAtom,
} from '@/renderer/features/workspace/new-chat-atoms.js'
import {
  NEW_CHAT_DRAFT_MAX_LENGTH,
  newChatTaskTitle,
  readNewChatDraft,
  writeNewChatDraft,
} from '@/renderer/features/workspace/new-chat-state.js'

const storageKey = 'watchtower.workspace.new-chat-draft.v1'

function memoryStorage(initial?: string) {
  const values = new Map<string, string>()
  if (initial) values.set(storageKey, initial)
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
}

describe('new chat state', () => {
  it('keeps a new draft when an earlier send is acknowledged after navigation', () => {
    const registry = AtomRegistry.make()
    try {
      registry.set(updateNewChatDraftAtom, 'Already submitted')
      registry.set(updateNewChatDraftAtom, 'A new objective')
      registry.set(clearNewChatDraftIfUnchangedAtom, 'Already submitted')
      expect(registry.get(newChatDraftAtom)).toBe('A new objective')
      registry.set(clearNewChatDraftIfUnchangedAtom, 'A new objective')
      expect(registry.get(newChatDraftAtom)).toBe('')
    } finally {
      registry.dispose()
    }
  })

  it('persists a bounded draft under its stable key and removes it when cleared', () => {
    const storage = memoryStorage()
    const longText = 'x'.repeat(NEW_CHAT_DRAFT_MAX_LENGTH + 10)
    expect(writeNewChatDraft(storage, longText, 100)).toHaveLength(NEW_CHAT_DRAFT_MAX_LENGTH)
    expect(readNewChatDraft(storage, 101)).toHaveLength(NEW_CHAT_DRAFT_MAX_LENGTH)
    expect(writeNewChatDraft(storage, '', 102)).toBe('')
    expect(storage.getItem(storageKey)).toBeNull()
  })

  it('drops expired and malformed drafts', () => {
    const expired = memoryStorage(JSON.stringify({ text: 'old', updatedAt: 1 }))
    expect(readNewChatDraft(expired, 40 * 24 * 60 * 60 * 1000)).toBe('')
    expect(readNewChatDraft(memoryStorage('{broken'), 1)).toBe('')
  })

  it('derives a short title from the first prompt line', () => {
    expect(newChatTaskTitle('Fix the parser\nThen update tests')).toBe('Fix the parser')
    expect(newChatTaskTitle('x'.repeat(120))).toHaveLength(100)
    expect(newChatTaskTitle('  \nsecond line')).toBe('second line')
  })
})
