import * as Schema from 'effect/Schema'

import { overviewPeriodSchema } from '../../../../shared/schemas/overview.js'
import { DEFAULT_SKILLS_THRESHOLDS } from '../../../../shared/skills-defaults.js'

export const PREFERENCES_STORAGE_KEY = 'watchtower:settings'

export const preferencesSchema = Schema.Struct({
  theme: Schema.Literals(['light', 'dark', 'system']),
  defaultPeriod: overviewPeriodSchema,
  onboarded: Schema.Boolean,
  skillsFrequency: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  skillsSpread: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  allowHarnessApiKeyEnv: Schema.Boolean,
})

export type Preferences = Schema.Schema.Type<typeof preferencesSchema>

const storedPreferencesSchema = Schema.Struct({
  state: Schema.Struct({
    theme: Schema.optional(preferencesSchema.fields.theme),
    defaultPeriod: Schema.optional(preferencesSchema.fields.defaultPeriod),
    onboarded: Schema.optional(preferencesSchema.fields.onboarded),
    skillsFrequency: Schema.optional(preferencesSchema.fields.skillsFrequency),
    skillsSpread: Schema.optional(preferencesSchema.fields.skillsSpread),
    allowHarnessApiKeyEnv: Schema.optional(preferencesSchema.fields.allowHarnessApiKeyEnv),
  }),
  version: Schema.Literal(0),
})

export const defaultPreferences: Preferences = Object.freeze({
  theme: 'system',
  defaultPeriod: 'today',
  onboarded: false,
  skillsFrequency: DEFAULT_SKILLS_THRESHOLDS.frequency,
  skillsSpread: DEFAULT_SKILLS_THRESHOLDS.spread,
  allowHarnessApiKeyEnv: false,
})

export interface PreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  subscribe(listener: (value: string | null) => void): () => void
}

export function decodePreferencesValue(encoded: string | null): Preferences | undefined {
  if (encoded === null) return defaultPreferences
  try {
    const decoded = Schema.decodeUnknownResult(storedPreferencesSchema)(JSON.parse(encoded))
    if (decoded._tag === 'Failure') return undefined
    return { ...defaultPreferences, ...decoded.success.state }
  } catch {
    return undefined
  }
}

/** Reads the Zustand persist envelope used by existing Watchtower profiles. */
export function readPreferences(storage: PreferenceStorage): Preferences {
  try {
    const encoded = storage.getItem(PREFERENCES_STORAGE_KEY)
    return decodePreferencesValue(encoded) ?? defaultPreferences
  } catch {
    return defaultPreferences
  }
}

/** Writes only the six persisted preferences in the current Zustand envelope. */
export function writePreferences(storage: PreferenceStorage, value: Preferences): void {
  try {
    const validated = Schema.decodeUnknownResult(preferencesSchema)(value)
    if (validated._tag === 'Failure') return
    storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({ state: validated.success, version: 0 }))
  } catch {
    // Browser storage may be disabled or full. Keep the in-memory preference.
  }
}
