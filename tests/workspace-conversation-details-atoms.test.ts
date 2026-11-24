import { AtomRegistry } from 'effect/reactivity'
import { describe, expect, it } from 'vitest'

import { CONVERSATION_DETAILS_ITEMS_STORAGE_KEY } from '../src/renderer/features/workspace/conversation-details-items.js'
import {
  conversationDetailsItemsAtom,
  hydrateConversationDetailsItems,
  resetConversationDetailsItemsAtom,
  setConversationDetailsItemVisibilityAtom,
} from '../src/renderer/features/workspace/conversation-details-items-atoms.js'
import {
  conversationDetailsVisibilityAtom,
  hydrateConversationDetailsVisibility,
  updateConversationDetailsVisibilityAtom,
} from '../src/renderer/features/workspace/conversation-details-visibility-atoms.js'

class MemoryStorage {
  readonly values = new Map<string, string>()
  readonly writes: Array<{ readonly key: string; readonly value: string }> = []
  reads = 0

  getItem(key: string): string | null {
    this.reads += 1
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.writes.push({ key, value })
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

describe('conversation details Effect atoms', () => {
  it('hydrates visibility once per registry and persists shared updates', () => {
    const storage = new MemoryStorage()
    storage.values.set('watchtower.workspace.conversation-details-visibility.v1', JSON.stringify({ alpha: false }))
    const registry = AtomRegistry.make()

    hydrateConversationDetailsVisibility(registry, storage)
    hydrateConversationDetailsVisibility(registry, new MemoryStorage())
    expect(registry.get(conversationDetailsVisibilityAtom)).toEqual({ alpha: false })
    expect(storage.reads).toBe(1)

    registry.set(updateConversationDetailsVisibilityAtom, { conversationId: 'beta', open: false })
    expect(registry.get(conversationDetailsVisibilityAtom)).toEqual({ alpha: false, beta: false })
    expect(JSON.parse(storage.writes[0]?.value ?? '')).toEqual({ alpha: false, beta: false })
  })

  it('keeps visibility isolated between registries', () => {
    const firstStorage = new MemoryStorage()
    const secondStorage = new MemoryStorage()
    firstStorage.values.set('watchtower.workspace.conversation-details-visibility.v1', JSON.stringify({ alpha: false }))
    secondStorage.values.set('watchtower.workspace.conversation-details-visibility.v1', JSON.stringify({ beta: false }))
    const first = AtomRegistry.make()
    const second = AtomRegistry.make()

    hydrateConversationDetailsVisibility(first, firstStorage)
    hydrateConversationDetailsVisibility(second, secondStorage)
    first.set(updateConversationDetailsVisibilityAtom, { conversationId: 'alpha', open: true })

    expect(first.get(conversationDetailsVisibilityAtom).alpha).toBe(true)
    expect(second.get(conversationDetailsVisibilityAtom)).toEqual({ beta: false })
    expect(secondStorage.writes).toEqual([])
  })

  it('hydrates and shares item visibility, then resets to defaults', () => {
    const storage = new MemoryStorage()
    storage.values.set(CONVERSATION_DETAILS_ITEMS_STORAGE_KEY, JSON.stringify({ workspace: false }))
    const registry = AtomRegistry.make()

    hydrateConversationDetailsItems(registry, storage)
    expect(registry.get(conversationDetailsItemsAtom).workspace).toBe(false)
    registry.set(setConversationDetailsItemVisibilityAtom, { id: 'branch', visible: false })
    expect(registry.get(conversationDetailsItemsAtom).branch).toBe(false)
    expect(JSON.parse(storage.writes[0]?.value ?? '')).toMatchObject({ workspace: false, branch: false })

    registry.set(resetConversationDetailsItemsAtom, undefined)
    expect(Object.values(registry.get(conversationDetailsItemsAtom)).every(Boolean)).toBe(true)
    expect(storage.values.has(CONVERSATION_DETAILS_ITEMS_STORAGE_KEY)).toBe(false)
  })

  it('keeps item preferences isolated between registries', () => {
    const firstStorage = new MemoryStorage()
    const secondStorage = new MemoryStorage()
    firstStorage.values.set(CONVERSATION_DETAILS_ITEMS_STORAGE_KEY, JSON.stringify({ branch: false }))
    const first = AtomRegistry.make()
    const second = AtomRegistry.make()

    hydrateConversationDetailsItems(first, firstStorage)
    hydrateConversationDetailsItems(second, secondStorage)
    first.set(setConversationDetailsItemVisibilityAtom, { id: 'workspace', visible: false })

    expect(first.get(conversationDetailsItemsAtom).workspace).toBe(false)
    expect(second.get(conversationDetailsItemsAtom).workspace).toBe(true)
    expect(secondStorage.writes).toEqual([])
  })
})
