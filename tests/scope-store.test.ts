import { beforeEach, describe, expect, it } from 'vitest'

import { selectScope, useScopeStore } from '../src/renderer/src/app/stores/scope-store.js'
import { useSettingsStore } from '../src/renderer/src/features/settings/store.js'

beforeEach(() => {
  useScopeStore.setState(useScopeStore.getInitialState(), true)
})

describe('useScopeStore (ADR 0011)', () => {
  it('starts on the persisted default period, all providers, no custom range', () => {
    const s = useScopeStore.getState()
    expect(s.period).toBe('today')
    expect(s.provider).toBe('all')
    expect(s.customRange).toBeNull()
  })

  it('seeds the active period from the persisted default (ADR 0011)', () => {
    expect(useScopeStore.getState().period).toBe(useSettingsStore.getState().defaultPeriod)
  })

  it('setPeriod clears a custom range (parity with AppShell)', () => {
    useScopeStore.getState().setCustomRange({ since: '2026-01-01', until: '2026-01-07' })
    useScopeStore.getState().setPeriod('week')
    const s = useScopeStore.getState()
    expect(s.period).toBe('week')
    expect(s.customRange).toBeNull()
  })

  it('setCustomRange/setProvider store the raw values', () => {
    useScopeStore.getState().setProvider('openai')
    useScopeStore.getState().setCustomRange({ since: 'a', until: 'b' })
    const s = useScopeStore.getState()
    expect(s.provider).toBe('openai')
    expect(s.customRange).toEqual({ since: 'a', until: 'b' })
  })
})

describe('selectScope', () => {
  it('maps the all-provider sentinel to an undefined filter', () => {
    useScopeStore.setState({ period: 'week', provider: 'all', customRange: null })
    expect(selectScope(useScopeStore.getState())).toEqual({ period: 'week' })
  })

  it('maps a concrete provider and custom range through', () => {
    useScopeStore.setState({
      period: '30days',
      provider: 'openai',
      customRange: { since: '2026-01-01', until: '2026-01-31' },
    })
    expect(selectScope(useScopeStore.getState())).toEqual({
      period: '30days',
      provider: 'openai',
      range: { since: '2026-01-01', until: '2026-01-31' },
    })
  })
})
