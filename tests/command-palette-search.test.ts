import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { describe, expect, it, vi } from 'vitest'

import { createSearchAtoms, paletteSearchKey } from '../src/renderer/src/app/atoms/search.js'
import { paletteSearchRequest } from '../src/renderer/src/app/hooks/use-search.js'

describe('command palette search', () => {
  it('debounces input by 180ms and reset clears the bounded request', async () => {
    vi.useFakeTimers()
    const atoms = createSearchAtoms(Atom.context())
    const registry = AtomRegistry.make()
    expect(registry.get(atoms.debouncedSearchTextAtom)).toBe('')
    const unsubscribe = registry.subscribe(atoms.debouncedSearchTextAtom, () => {})

    registry.set(atoms.searchTextAtom, 'first')
    await vi.advanceTimersByTimeAsync(179)
    expect(registry.get(atoms.debouncedSearchTextAtom)).toBe('')
    await vi.advanceTimersByTimeAsync(1)
    expect(registry.get(atoms.debouncedSearchTextAtom)).toBe('first')

    registry.set(atoms.searchSlot.requestAtom, {
      query: 'first',
      scope: { period: 'today', provider: 'openai' },
    })
    registry.set(atoms.resetSearchAtom, undefined)
    expect(registry.get(atoms.searchTextAtom)).toBe('')
    expect(registry.get(atoms.searchSlot.requestAtom)).toBeNull()

    unsubscribe()
    registry.dispose()
    vi.useRealTimers()
  })

  it('uses the full scope in query identity, even though search itself is global', () => {
    const query = 'compiler error'
    expect(paletteSearchKey({ query, scope: { period: 'today' } })).not.toBe(
      paletteSearchKey({ query, scope: { period: 'week' } }),
    )
    expect(paletteSearchKey({ query, scope: { period: 'week', provider: 'openai' } })).not.toBe(
      paletteSearchKey({ query, scope: { period: 'week', provider: 'anthropic' } }),
    )
    expect(
      paletteSearchKey({ query, scope: { period: 'week', range: { since: '2026-01-01', until: '2026-01-07' } } }),
    ).not.toBe(paletteSearchKey({ query, scope: { period: 'week' } }))
  })

  it('does not select an unsettled or closed query, preventing stale hits from showing', () => {
    const scope = { period: 'month' } as const
    expect(paletteSearchRequest(false, 'new term', 'old term', scope)).toBeNull()
    expect(paletteSearchRequest(true, 'new term', 'old term', scope)).toBeNull()
    expect(paletteSearchRequest(true, '  new term  ', 'new term', scope)).toEqual({ query: 'new term', scope })
    expect(paletteSearchRequest(true, '   ', '', scope)).toBeNull()
  })
})
