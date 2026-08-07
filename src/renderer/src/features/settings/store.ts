import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import {
  fetchCadence,
  fetchCurrencies,
  fetchCurrency,
  fetchSetCadence,
  fetchSetCurrency,
} from '@/shared/lib/api'
import type { ActiveCurrency, CurrencyOption } from '../../../../shared/schemas/fx.js'
import type { Theme } from '../../../../shared/schemas/renderer.js'
import { setActiveCurrency } from '@/shared/lib/currency'

/** Persisted (theme/defaultPeriod/onboarded) + server-fed (cadence/currency)
 * settings. (map ticket 02) The hand-rolled localStorage libs (`watchtower:
 * theme`, `watchtower:defaultPeriod`, `watchtower:onboarded`) are absorbed by
 * `persist` under a single `watchtower:settings` key. */
export interface SettingsState {
  theme: Theme
  defaultPeriod: string
  onboarded: boolean
  cadence: string
  activeCurrency: ActiveCurrency
  currencyOptions: CurrencyOption[]
  setTheme: (theme: Theme) => void
  setDefaultPeriod: (period: string) => void
  markOnboarded: () => void
  setCadence: (value: string) => Promise<void>
  setCurrency: (code: string) => Promise<void>
  loadCadence: () => Promise<void>
  loadCurrency: () => Promise<void>
  loadCurrencyOptions: () => Promise<void>
  onCurrencyChanged: (currency: ActiveCurrency) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'system',
      defaultPeriod: 'today',
      onboarded: false,
      cadence: '1m',
      activeCurrency: { code: 'USD', symbol: '$', rate: 1 },
      currencyOptions: [],
      setTheme: (theme) => set({ theme }),
      setDefaultPeriod: (defaultPeriod) => set({ defaultPeriod }),
      markOnboarded: () => set({ onboarded: true }),
      setCadence: async (value) => {
        // Optimistic, matching today's Settings › General handler: paint the
        // choice immediately, confirm it with the main process's persisted value.
        set({ cadence: value })
        const result = await fetchSetCadence(value)
        if (result.ok) set({ cadence: result.data })
      },
      setCurrency: async (code) => {
        // Not optimistic: the main process returns the current state (last
        // cached rate, or USD if none), which is what every section repaints.
        const result = await fetchSetCurrency(code)
        if (result.ok) {
          set({ activeCurrency: result.data })
          setActiveCurrency(result.data)
        }
      },
      loadCadence: async () => {
        const result = await fetchCadence()
        if (result.ok) set({ cadence: result.data })
      },
      loadCurrency: async () => {
        const result = await fetchCurrency()
        if (result.ok) {
          set({ activeCurrency: result.data })
          setActiveCurrency(result.data)
        }
      },
      loadCurrencyOptions: async () => {
        const result = await fetchCurrencies()
        if (result.ok) set({ currencyOptions: result.data })
      },
      onCurrencyChanged: (activeCurrency) => {
        set({ activeCurrency })
        setActiveCurrency(activeCurrency)
      },
    }),
    {
      name: 'watchtower:settings',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ theme: s.theme, defaultPeriod: s.defaultPeriod, onboarded: s.onboarded }),
    },
  ),
)
