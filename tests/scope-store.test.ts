import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  customRangeAtom,
  overviewScopeAtom,
  periodAtom,
  providerAtom,
  setCustomRangeAtom,
  setPeriodAtom,
  setProviderAtom,
} from '../src/renderer/stores/atoms/scope.js'
import { createRendererRuntimeOwner } from '../src/renderer/app/renderer-runtime.js'
let owner: ReturnType<typeof createRendererRuntimeOwner>
beforeEach(() => {
  owner = createRendererRuntimeOwner({ initialPeriod: 'week' })
})
afterEach(() => owner.dispose())
describe('Scope atoms', () => {
  it('seeds the transient active period before the first read', () => {
    expect(owner.registry.get(periodAtom)).toBe('week')
    expect(owner.registry.get(providerAtom)).toBe('all')
    expect(owner.registry.get(customRangeAtom)).toBeNull()
  })
  it('clears the custom range when the selected period changes', () => {
    owner.registry.set(setCustomRangeAtom, { since: '2026-01-01', until: '2026-01-07' })
    owner.registry.set(setPeriodAtom, '30days')
    expect(owner.registry.get(overviewScopeAtom)).toEqual({ period: '30days' })
  })
  it('includes the provider and custom range in the query identity', () => {
    owner.registry.set(setProviderAtom, 'openai')
    owner.registry.set(setCustomRangeAtom, { since: '2026-01-01', until: '2026-01-31' })
    expect(owner.registry.get(overviewScopeAtom)).toEqual({
      period: 'week',
      provider: 'openai',
      range: { since: '2026-01-01', until: '2026-01-31' },
    })
  })
})
