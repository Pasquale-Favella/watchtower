import { describe, expect, it } from 'vitest'

import { paletteOpenAtom, setPaletteOpenAtom, togglePaletteAtom } from '../src/renderer/src/app/atoms/palette.js'
import {
  customRangeAtom,
  overviewScopeAtom,
  periodAtom,
  setCustomRangeAtom,
  setPeriodAtom,
  setProviderAtom,
} from '../src/renderer/src/app/atoms/scope.js'
import { createRendererRuntimeOwner } from '../src/renderer/src/app/renderer-runtime.js'

describe('renderer Scope atoms', () => {
  it('derives the analytics Scope and preserves the all-provider sentinel semantics', () => {
    const owner = createRendererRuntimeOwner({ initialPeriod: 'week' })

    expect(owner.registry.get(overviewScopeAtom)).toEqual({ period: 'week' })

    owner.registry.set(setProviderAtom, 'openai')
    owner.registry.set(setCustomRangeAtom, { since: '2026-01-01', until: '2026-01-07' })
    expect(owner.registry.get(overviewScopeAtom)).toEqual({
      period: 'week',
      provider: 'openai',
      range: { since: '2026-01-01', until: '2026-01-07' },
    })

    owner.registry.set(setProviderAtom, 'all')
    expect(owner.registry.get(overviewScopeAtom)).toEqual({
      period: 'week',
      range: { since: '2026-01-01', until: '2026-01-07' },
    })

    owner.dispose()
  })

  it('clears the custom range when the period changes', () => {
    const owner = createRendererRuntimeOwner({ initialPeriod: 'today' })
    owner.registry.set(customRangeAtom, { since: '2026-02-01', until: '2026-02-03' })

    owner.registry.set(setPeriodAtom, 'month')

    expect(owner.registry.get(periodAtom)).toBe('month')
    expect(owner.registry.get(customRangeAtom)).toBeNull()
    expect(owner.registry.get(overviewScopeAtom)).toEqual({ period: 'month' })
    owner.dispose()
  })
})

describe('command palette atoms', () => {
  it('starts closed and supports explicit set and toggle writes', () => {
    const owner = createRendererRuntimeOwner()

    expect(owner.registry.get(paletteOpenAtom)).toBe(false)
    owner.registry.set(setPaletteOpenAtom, true)
    expect(owner.registry.get(paletteOpenAtom)).toBe(true)
    owner.registry.set(togglePaletteAtom, undefined)
    expect(owner.registry.get(paletteOpenAtom)).toBe(false)
    owner.registry.set(togglePaletteAtom, undefined)
    expect(owner.registry.get(paletteOpenAtom)).toBe(true)

    owner.dispose()
  })
})
