import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { fetchCadence, fetchCurrencies, fetchCurrency, fetchSetCadence, fetchSetCurrency } from '@/shared/lib/api'
import type { ActiveCurrency, CurrencyOption } from '../../../../shared/schemas/fx.js'
import type { Theme } from '../../../../shared/schemas/renderer.js'
import { DEFAULT_SKILLS_THRESHOLDS } from '../../../../shared/schemas/skills.js'
import { setActiveCurrency } from '@/shared/lib/currency'

/** Persisted (theme/defaultPeriod/onboarded) + server-fed (cadence/currency)
 * settings. (ADR 0011) The hand-rolled localStorage libs (`watchtower:
 * theme`, `watchtower:defaultPeriod`, `watchtower:onboarded`) are absorbed by
 * `persist` under a single `watchtower:settings` key. */
export interface SettingsState {
  theme: Theme
  defaultPeriod: string
  onboarded: boolean
  cadence: string
  activeCurrency: ActiveCurrency
  currencyOptions: CurrencyOption[]
  /** The Skills detection gate (ticket 24): frequency × spread app settings
   * passed with every skills:view request. Tuning prefs — persisted locally
   * like theme, consumed by the main process per request. */
  skillsFrequency: number
  skillsSpread: number
  /** Coach harness API-key passthrough (opt-in, default off): when true,
   *  Coach runs/probes inherit API-key env vars (e.g. ANTHROPIC_API_KEY) from
   *  the app's environment instead of the main process scrubbing them — for
   *  users whose terminal sign-in is key-based rather than stored-login. The
   *  key itself is never stored: this flag only controls scrubbing. */
  allowHarnessApiKeyEnv: boolean
  setTheme: (theme: Theme) => void
  setDefaultPeriod: (period: string) => void
  markOnboarded: () => void
  setCadence: (value: string) => Promise<void>
  setCurrency: (code: string) => Promise<void>
  loadCadence: () => Promise<void>
  loadCurrency: () => Promise<void>
  loadCurrencyOptions: () => Promise<void>
  setSkillsThresholds: (frequency: number, spread: number) => void
  setAllowHarnessApiKeyEnv: (allow: boolean) => void
  onCurrencyChanged: (currency: ActiveCurrency) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    set => ({
      theme: 'system',
      defaultPeriod: 'today',
      onboarded: false,
      cadence: '1m',
      activeCurrency: { code: 'USD', symbol: '$', rate: 1 },
      currencyOptions: [],
      skillsFrequency: DEFAULT_SKILLS_THRESHOLDS.frequency,
      skillsSpread: DEFAULT_SKILLS_THRESHOLDS.spread,
      allowHarnessApiKeyEnv: false,
      setTheme: theme => set({ theme }),
      setDefaultPeriod: defaultPeriod => set({ defaultPeriod }),
      markOnboarded: () => set({ onboarded: true }),
      setSkillsThresholds: (frequency, spread) => set({ skillsFrequency: frequency, skillsSpread: spread }),
      setAllowHarnessApiKeyEnv: allowHarnessApiKeyEnv => set({ allowHarnessApiKeyEnv }),
      setCadence: async value => {
        // Optimistic, matching today's Settings › General handler: paint the
        // choice immediately, confirm it with the main process's persisted value.
        set({ cadence: value })
        const result = await fetchSetCadence(value)
        if (result.ok) set({ cadence: result.data })
      },
      setCurrency: async code => {
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
      onCurrencyChanged: activeCurrency => {
        set({ activeCurrency })
        setActiveCurrency(activeCurrency)
      },
    }),
    {
      name: 'watchtower:settings',
      storage: createJSONStorage(() => localStorage),
      partialize: s => ({
        theme: s.theme,
        defaultPeriod: s.defaultPeriod,
        onboarded: s.onboarded,
        skillsFrequency: s.skillsFrequency,
        skillsSpread: s.skillsSpread,
        allowHarnessApiKeyEnv: s.allowHarnessApiKeyEnv,
      }),
    },
  ),
)
