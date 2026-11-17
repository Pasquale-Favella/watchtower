import { describe, expect, it } from 'vitest'

import { readPromptStash, writePromptStash } from '@/renderer/features/workspace/prompt-stash.js'

describe('workspace prompt stash', () => {
  it('round trips prompt text and attachment metadata', () => {
    let value: string | null = null
    const storage = {
      getItem: () => value,
      setItem: (_key: string, next: string) => {
        value = next
      },
    }
    const entry = {
      id: 'stash-1',
      value: 'Review this file',
      attachments: [
        {
          id: 'a'.repeat(64),
          name: 'notes.txt',
          mediaType: 'text/plain',
          size: 12,
          source: 'file' as const,
        },
      ],
      createdAt: 123,
    }

    writePromptStash(storage, 'stash', [entry])

    expect(readPromptStash(storage, 'stash')).toEqual([entry])
  })

  it('discards malformed saved state', () => {
    const storage = { getItem: () => '{broken' }
    expect(readPromptStash(storage, 'stash')).toEqual([])
  })
})
