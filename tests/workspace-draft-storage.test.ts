import { describe, expect, it } from 'vitest'

import {
  readWorkspaceComposerPreferences,
  readWorkspaceDrafts,
  WORKSPACE_DRAFT_MAX_CONVERSATIONS,
  WORKSPACE_DRAFT_MAX_LENGTH,
  WORKSPACE_DRAFT_RETENTION_MS,
  writeWorkspaceComposerPreference,
  writeWorkspaceDraft,
} from '@/renderer/features/workspace/draft-storage.js'
import { conversationIdSchema } from '@/shared/schemas/workspace.js'

const key = 'watchtower.workspace.drafts.v1'

function memoryStorage(initial?: string) {
  const values = new Map<string, string>()
  if (initial) values.set(key, initial)
  return {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => values.set(name, value),
    removeItem: (name: string) => values.delete(name),
  }
}

describe('workspace draft storage', () => {
  it('round trips drafts by Conversation and removes a cleared draft', () => {
    const storage = memoryStorage()
    const conversationId = conversationIdSchema.make('conversation-1')
    const saved = writeWorkspaceDraft(storage, {}, conversationId, 'preserve this', 100)
    expect(readWorkspaceDrafts(storage, 101)).toEqual(saved)
    expect(writeWorkspaceDraft(storage, saved, conversationId, '', 102)).toEqual({})
    expect(storage.getItem(key)).toBeNull()
  })

  it('expires old drafts, keeps the most recently edited bounded set, and caps prompt length', () => {
    const storage = memoryStorage()
    const now = WORKSPACE_DRAFT_RETENTION_MS + 10
    let drafts = writeWorkspaceDraft(storage, {}, conversationIdSchema.make('old'), 'old', 1)
    for (let index = 0; index < WORKSPACE_DRAFT_MAX_CONVERSATIONS + 2; index++) {
      drafts = writeWorkspaceDraft(
        storage,
        drafts,
        conversationIdSchema.make(`conversation-${index}`),
        'x'.repeat(WORKSPACE_DRAFT_MAX_LENGTH + 5),
        now + index,
      )
    }
    const loaded = readWorkspaceDrafts(storage, now + WORKSPACE_DRAFT_MAX_CONVERSATIONS + 2)
    expect(Object.keys(loaded)).toHaveLength(WORKSPACE_DRAFT_MAX_CONVERSATIONS)
    expect(Object.values(loaded).every(draft => draft.text.length === WORKSPACE_DRAFT_MAX_LENGTH)).toBe(true)
    expect(loaded.old).toBeUndefined()
  })

  it('recovers from malformed local data without exposing it as a draft', () => {
    const storage = memoryStorage('{not valid json')
    expect(readWorkspaceDrafts(storage, 10)).toEqual({})
  })

  it('retains selected checkout and connection per Conversation across reloads', () => {
    const storage = memoryStorage()
    const conversationId = conversationIdSchema.make('conversation-1')
    const saved = writeWorkspaceComposerPreference(
      storage,
      {},
      conversationId,
      {
        checkoutId: 'checkout-1',
        connectionId: 'connection-1',
      },
      100,
    )
    expect(readWorkspaceComposerPreferences(storage, 101)).toEqual(saved)
    expect(saved[conversationId]).toMatchObject({ checkoutId: 'checkout-1', connectionId: 'connection-1' })
  })
})
