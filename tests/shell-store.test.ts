import { beforeEach, describe, expect, it } from 'vitest'

import { selectScope, useShellStore } from '../src/renderer/src/app/stores/shell-store.js'
import { useSettingsStore } from '../src/renderer/src/features/settings/store.js'

beforeEach(() => {
  useShellStore.setState(useShellStore.getInitialState(), true)
})

describe('useShellStore (map ticket 02/05)', () => {
  it('starts on overview, today, all providers, no session', () => {
    const s = useShellStore.getState()
    expect(s.section).toBe('overview')
    expect(s.period).toBe('today')
    expect(s.provider).toBe('all')
    expect(s.customRange).toBeNull()
    expect(s.openSession).toBeNull()
  })

  it('seeds the active period from the persisted default (map ticket 02)', () => {
    expect(useShellStore.getState().period).toBe(useSettingsStore.getState().defaultPeriod)
  })

  it('navigate sets the section and clears any open session', () => {
    useShellStore.getState().openSessionById('abc')
    useShellStore.getState().navigate('models')
    const s = useShellStore.getState()
    expect(s.section).toBe('models')
    expect(s.openSession).toBeNull()
  })

  it('navigateString only accepts known sections', () => {
    useShellStore.getState().navigateString('nonsense')
    expect(useShellStore.getState().section).toBe('overview')

    useShellStore.getState().navigateString('spend')
    expect(useShellStore.getState().section).toBe('spend')
  })

  it('setPeriod clears a custom range (parity with AppShell)', () => {
    useShellStore.getState().setCustomRange({ since: '2026-01-01', until: '2026-01-07' })
    useShellStore.getState().setPeriod('week')
    const s = useShellStore.getState()
    expect(s.period).toBe('week')
    expect(s.customRange).toBeNull()
  })

  it('setCustomRange/setProvider store the raw values', () => {
    useShellStore.getState().setProvider('openai')
    useShellStore.getState().setCustomRange({ since: 'a', until: 'b' })
    const s = useShellStore.getState()
    expect(s.provider).toBe('openai')
    expect(s.customRange).toEqual({ since: 'a', until: 'b' })
  })

  it('openSessionById/closeSession round-trip', () => {
    useShellStore.getState().openSessionById('s1')
    expect(useShellStore.getState().openSession).toBe('s1')
    useShellStore.getState().closeSession()
    expect(useShellStore.getState().openSession).toBeNull()
  })
})

describe('selectScope', () => {
  it('maps the all-provider sentinel to an undefined filter', () => {
    useShellStore.setState({ period: 'week', provider: 'all', customRange: null })
    expect(selectScope(useShellStore.getState())).toEqual({ period: 'week' })
  })

  it('maps a concrete provider and custom range through', () => {
    useShellStore.setState({
      period: '30days',
      provider: 'openai',
      customRange: { since: '2026-01-01', until: '2026-01-31' },
    })
    expect(selectScope(useShellStore.getState())).toEqual({
      period: '30days',
      provider: 'openai',
      range: { since: '2026-01-01', until: '2026-01-31' },
    })
  })
})
