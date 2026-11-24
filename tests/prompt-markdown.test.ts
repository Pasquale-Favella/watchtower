import { describe, expect, it } from 'vitest'

import {
  backspacePromptCodeFence,
  continuePromptCodeFence,
  indentPromptBlock,
} from '@/renderer/features/workspace/prompt-markdown.js'

describe('workspace prompt Markdown editing', () => {
  it('opens fenced code blocks and keeps Enter inside the block', () => {
    expect(continuePromptCodeFence('```ts', 5, 5)).toEqual({
      value: '```ts\n\n```',
      start: 6,
      end: 6,
    })
    expect(continuePromptCodeFence('```\ncode', 8, 8)).toEqual({
      value: '```\ncode\n',
      start: 9,
      end: 9,
    })
    expect(continuePromptCodeFence('```\ncode\n\n', 10, 10)?.value).toBe('```\ncode\n\n```\n')
    expect(backspacePromptCodeFence('```\ncode', 4, 4)).toEqual({ value: 'code', start: 0, end: 0 })
  })

  it('nests and outdents list lines with Tab and Shift+Tab', () => {
    expect(indentPromptBlock('- item', 2, 2, false)).toEqual({ value: '  - item', start: 4, end: 4 })
    expect(indentPromptBlock('  - item', 4, 4, true)).toEqual({ value: '- item', start: 2, end: 2 })
  })

  it('indents selected lines in a fenced code block', () => {
    const value = '```\nfirst\nsecond\n```'
    expect(indentPromptBlock(value, 4, 17, false)?.value).toBe('```\n  first\n  second\n```')
  })
})
