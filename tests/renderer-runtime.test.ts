import { describe, expect, it } from 'vitest'

import { periodAtom } from '../src/renderer/stores/atoms/scope.js'
import { createRendererRuntimeOwner } from '../src/renderer/app/renderer-runtime.js'

describe('renderer runtime owner', () => {
  it('creates independent registries with an injectable initial period', () => {
    const first = createRendererRuntimeOwner({ initialPeriod: 'week' })
    const second = createRendererRuntimeOwner({ initialPeriod: 'month' })

    expect(first.registry.get(periodAtom)).toBe('week')
    expect(second.registry.get(periodAtom)).toBe('month')

    first.registry.set(periodAtom, 'lifetime')
    expect(first.registry.get(periodAtom)).toBe('lifetime')
    expect(second.registry.get(periodAtom)).toBe('month')

    first.dispose()
    second.dispose()
  })

  it('keeps the transient Scope and allows idempotent window disposal', () => {
    const owner = createRendererRuntimeOwner({ initialPeriod: 'today' })
    owner.registry.set(periodAtom, '30days')
    expect(owner.registry.get(periodAtom)).toBe('30days')
    owner.dispose()
    expect(() => owner.dispose()).not.toThrow()
  })
})
