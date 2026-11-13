import { describe, expect, it } from 'vitest'

import { rankModelRows } from '@/renderer/features/workspace/model-picker/search.js'

const rows = [
  { id: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
  { id: 'claude-opus-4', label: 'Claude Opus 4' },
  { id: 'gpt-5', label: 'GPT-5' },
  { id: 'sonnet', label: 'Sonnet' },
]

const ids = (matches: readonly { readonly id: string }[]) => matches.map(match => match.id)

describe('rankModelRows', () => {
  it('keeps the declared order for a blank query', () => {
    expect(ids(rankModelRows(rows, '   '))).toEqual(ids(rows))
  })

  it('requires every whitespace token to match the label or the id', () => {
    expect(ids(rankModelRows(rows, 'claude   opus'))).toEqual(['claude-opus-4'])
    expect(ids(rankModelRows(rows, 'claude gpt'))).toEqual([])
  })

  it('matches case-insensitively against both label and id', () => {
    expect(ids(rankModelRows(rows, 'GPT-5'))).toEqual(['gpt-5'])
    expect(ids(rankModelRows(rows, 'CLAUDE-OPUS'))).toEqual(['claude-opus-4'])
  })

  it('ranks an exact label match before partial matches', () => {
    expect(ids(rankModelRows(rows, 'sonnet'))).toEqual(['sonnet', 'claude-sonnet-4'])
  })

  it('ranks an exact id match first', () => {
    expect(ids(rankModelRows(rows, 'claude-sonnet-4'))).toEqual(['claude-sonnet-4'])
  })

  it('ranks labels that start with the query before labels that only contain it', () => {
    const catalog = [
      { id: 'a', label: 'Big Opus' },
      { id: 'b', label: 'Opus 4' },
    ]
    expect(ids(rankModelRows(catalog, 'opus'))).toEqual(['b', 'a'])
  })

  it('keeps the declared order among equally ranked matches', () => {
    expect(ids(rankModelRows(rows, 'claude'))).toEqual(['claude-sonnet-4', 'claude-opus-4'])
  })

  it('places the agent default row first for its own name', () => {
    const withDefault = [
      { id: 'fast', label: 'Fast' },
      { id: '', label: 'Default' },
    ]
    expect(ids(rankModelRows(withDefault, 'default'))).toEqual([''])
    expect(ids(rankModelRows(withDefault, ' '))).toEqual(['fast', ''])
  })
})
