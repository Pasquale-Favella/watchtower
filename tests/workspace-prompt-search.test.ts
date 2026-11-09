import { describe, expect, it } from 'vitest'

import {
  type PromptMenuItem,
  searchFileItems,
  searchPromptItems,
  slashPromptItems,
} from '@/renderer/features/workspace/prompt-search.js'

const skill = (name: string): PromptMenuItem => ({ id: `skill:${name}`, label: name, category: 'skill', path: name })
const native = (name: string, description?: string): PromptMenuItem => ({
  id: `native:${name}`,
  label: name,
  description,
  category: 'native',
})

describe('workspace prompt search', () => {
  it('limits provider commands and disk commands to the first thing typed, keeping skills and actions anywhere', () => {
    const items = [
      native('compact'),
      { ...skill('review'), category: 'command' as const },
      skill('review'),
      { id: 'action:model', label: 'model', category: 'action' as const },
    ]
    expect(slashPromptItems(items, true).map(item => item.category)).toEqual(['native', 'command', 'skill', 'action'])
    expect(slashPromptItems(items, false).map(item => item.category)).toEqual(['skill', 'action'])
  })

  it('ranks exact, prefix and boundary matches ahead of substring and fuzzy matches', () => {
    const ranked = searchPromptItems(
      [native('review-other'), native('review'), native('code-review'), native('unrelated')],
      'review',
    )
    expect(ranked.map(item => item.label)).toEqual(['review', 'review-other', 'code-review'])
  })

  it('falls back to fuzzy subsequence matches and keeps the declared order on ties', () => {
    const ranked = searchPromptItems([native('unrelated'), native('code-review')], 'rvw')
    expect(ranked.map(item => item.label)).toEqual(['code-review'])
  })

  it('matches descriptions and treats `skill` queries as skill selectors', () => {
    expect(searchPromptItems([native('latest', 'Show recent runs')], 'show').map(item => item.label)).toEqual([
      'latest',
    ])
    expect(searchPromptItems([native('skillx'), skill('review')], 'skill').map(item => item.label)).toEqual([
      'review',
      'skillx',
    ])
    expect(searchPromptItems([skill('review'), native('review')], 'skill:rev').map(item => item.label)).toEqual([
      'review',
    ])
  })

  it('ranks file paths shallower and earlier matches first, with fuzzy fallback', () => {
    const paths = ['new name with spaces/readme.md', 'readme.md', 'src/new-naming.md']
    const files = paths.map(path => ({ id: `file:${path}`, label: '', category: 'file' as const, path }))
    const ranked = searchFileItems(files, 'new')
    expect(ranked.map(item => item.path)).toEqual(['src/new-naming.md', 'new name with spaces/readme.md'])
    expect(searchFileItems(files, 'nw').map(item => item.path)).toContain('src/new-naming.md')
  })

  it('searches context references by their display label as well as their path', () => {
    const references: PromptMenuItem[] = [
      {
        id: 'model:connection/model-id',
        label: 'Claude Sonnet',
        description: 'Anthropic connection',
        category: 'model',
        path: 'model:connection/model-id',
      },
      {
        id: 'conversation:task-id',
        label: 'Refactor prompt input',
        description: 'Task abc123',
        category: 'conversation',
        path: 'task-id',
      },
    ]
    expect(searchFileItems(references, 'sonnet').map(item => item.label)).toEqual(['Claude Sonnet'])
    expect(searchFileItems(references, 'refactor').map(item => item.label)).toEqual(['Refactor prompt input'])
  })
})
