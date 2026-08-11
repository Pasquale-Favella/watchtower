import { beforeEach, describe, expect, it, vi } from 'vitest'

function mockWindow(api: unknown): void {
  ;(globalThis as { window?: unknown }).window = { api }
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() { return store.size },
    clear: () => { store.clear() },
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => { store.delete(key) },
    setItem: (key: string, value: string) => { store.set(key, value) },
  }
}

// The settings store persists via `createJSONStorage(() => localStorage)`
// evaluated at module load — install the memory storage BEFORE the dynamic
// import so persist hydrates/writes against it (the plain-node suite has no
// real localStorage).
const memory = createMemoryStorage()
vi.stubGlobal('localStorage', memory)

const { useSettingsStore } = await import('../src/renderer/src/features/settings/store.js')

const PERSIST_KEY = 'watchtower:settings'

beforeEach(() => {
  memory.clear()
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
})

describe('useSettingsStore (ADR 0011)', () => {
  it('starts with defaults', () => {
    const s = useSettingsStore.getState()
    expect(s.theme).toBe('system')
    expect(s.defaultPeriod).toBe('today')
    expect(s.onboarded).toBe(false)
    expect(s.cadence).toBe('1m')
    expect(s.activeCurrency).toEqual({ code: 'USD', symbol: '$', rate: 1 })
    expect(s.currencyOptions).toEqual([])
  })

  it('persists only the partialized slice under one key', () => {
    useSettingsStore.getState().setTheme('dark')
    useSettingsStore.getState().markOnboarded()
    const persisted = JSON.parse(memory.getItem(PERSIST_KEY)!)
    expect(persisted.state).toEqual({
      theme: 'dark',
      defaultPeriod: 'today',
      onboarded: true,
      skillsFrequency: 5,
      skillsSpread: 2,
    })
  })

  it('setTheme and markOnboarded update state', () => {
    useSettingsStore.getState().setTheme('light')
    useSettingsStore.getState().markOnboarded()
    const s = useSettingsStore.getState()
    expect(s.theme).toBe('light')
    expect(s.onboarded).toBe(true)
  })

  it('setDefaultPeriod updates and persists the new default', () => {
    useSettingsStore.getState().setDefaultPeriod('week')
    expect(useSettingsStore.getState().defaultPeriod).toBe('week')
    const persisted = JSON.parse(memory.getItem(PERSIST_KEY)!)
    expect(persisted.state.defaultPeriod).toBe('week')
  })

  it('loadCadence/loadCurrency/loadCurrencyOptions hydrate server values', async () => {
    mockWindow({
      getCadence: () => Promise.resolve('5m'),
      getCurrency: () => Promise.resolve({ code: 'EUR', symbol: '€', rate: 0.92, updatedAt: '2026-01-01T00:00:00Z' }),
      getCurrencies: () => Promise.resolve([
        { code: 'USD', symbol: '$' },
        { code: 'EUR', symbol: '€' },
      ]),
    })
    const { loadCadence, loadCurrency, loadCurrencyOptions } = useSettingsStore.getState()
    await loadCadence()
    await loadCurrency()
    await loadCurrencyOptions()
    const s = useSettingsStore.getState()
    expect(s.cadence).toBe('5m')
    expect(s.activeCurrency).toEqual({ code: 'EUR', symbol: '€', rate: 0.92, updatedAt: '2026-01-01T00:00:00Z' })
    expect(s.currencyOptions).toHaveLength(2)
  })

  it('setCadence applies optimistically, then confirms with the persisted value', async () => {
    let resolveCadence!: (value: string) => void
    mockWindow({
      setCadence: () => new Promise<string>(resolve => { resolveCadence = resolve }),
    })
    const pending = useSettingsStore.getState().setCadence('3m')
    expect(useSettingsStore.getState().cadence).toBe('3m')
    resolveCadence('3m')
    await pending
    expect(useSettingsStore.getState().cadence).toBe('3m')
  })

  it('setCurrency applies the main-process-confirmed currency', async () => {
    mockWindow({ setCurrency: () => Promise.resolve({ code: 'GBP', symbol: '£', rate: 0.78 }) })
    await useSettingsStore.getState().setCurrency('GBP')
    expect(useSettingsStore.getState().activeCurrency).toEqual({ code: 'GBP', symbol: '£', rate: 0.78 })
  })

  it('setCurrency ignores a failed write (keeps the current currency)', async () => {
    mockWindow({ setCurrency: () => Promise.resolve({ code: 'NOT-A-CURRENCY', symbol: '?', rate: 'NaN' }) })
    await useSettingsStore.getState().setCurrency('EUR')
    expect(useSettingsStore.getState().activeCurrency.code).toBe('USD')
  })

  it('onCurrencyChanged repaints with the broadcast rate', () => {
    useSettingsStore.getState().onCurrencyChanged({ code: 'JPY', symbol: '¥', rate: 150, updatedAt: '2026-01-01T00:00:00Z' })
    expect(useSettingsStore.getState().activeCurrency)
      .toEqual({ code: 'JPY', symbol: '¥', rate: 150, updatedAt: '2026-01-01T00:00:00Z' })
  })

  it('the agents consent gate defaults OFF and is server-fed, not partialized (ticket 22)', async () => {
    expect(useSettingsStore.getState().agentsConsent).toBe(false)
    // The opt-in is main-persisted (ADR 0012 addendum) — it must NOT ride the
    // localStorage partialize like theme/defaultPeriod.
    useSettingsStore.setState({ agentsConsent: true })
    const persisted = JSON.parse(memory.getItem(PERSIST_KEY)!)
    expect(persisted.state.agentsConsent).toBeUndefined()
  })

  it('loadAgentsConsent hydrates the persisted gate state from main', async () => {
    mockWindow({ getAgentsConsent: () => Promise.resolve({ granted: true }) })
    await useSettingsStore.getState().loadAgentsConsent()
    expect(useSettingsStore.getState().agentsConsent).toBe(true)
  })

  it('setAgentsConsent persists the opt-in through the main process', async () => {
    mockWindow({ setAgentsConsent: () => Promise.resolve({ granted: true }) })
    await useSettingsStore.getState().setAgentsConsent(true)
    expect(useSettingsStore.getState().agentsConsent).toBe(true)
  })

  it('setAgentsConsent keeps the previous value when the main write fails', async () => {
    mockWindow({ setAgentsConsent: () => Promise.resolve({ granted: 'bogus' }) })
    await useSettingsStore.getState().setAgentsConsent(true)
    expect(useSettingsStore.getState().agentsConsent).toBe(false)
  })

  it('the Skills detection thresholds default to 5 × 2 and persist locally (ticket 24)', () => {
    expect(useSettingsStore.getState().skillsFrequency).toBe(5)
    expect(useSettingsStore.getState().skillsSpread).toBe(2)
    useSettingsStore.getState().setSkillsThresholds(3, 1)
    expect(useSettingsStore.getState().skillsFrequency).toBe(3)
    expect(useSettingsStore.getState().skillsSpread).toBe(1)
    const persisted = JSON.parse(memory.getItem(PERSIST_KEY)!)
    expect(persisted.state.skillsFrequency).toBe(3)
    expect(persisted.state.skillsSpread).toBe(1)
  })
})
