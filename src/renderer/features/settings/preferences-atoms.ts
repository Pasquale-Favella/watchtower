import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Schema from 'effect/Schema'

import {
  decodePreferencesValue,
  defaultPreferences,
  type Preferences,
  PREFERENCES_STORAGE_KEY,
  preferencesSchema,
  type PreferenceStorage,
  readPreferences,
  writePreferences,
} from '@/renderer/shared/lib/preferences'

export const preferencesAtom = Atom.keepAlive(
  Atom.make(defaultPreferences).pipe(
    Atom.withEquality<Preferences>(
      (current, next) =>
        current.theme === next.theme &&
        current.defaultPeriod === next.defaultPeriod &&
        current.onboarded === next.onboarded &&
        current.skillsFrequency === next.skillsFrequency &&
        current.skillsSpread === next.skillsSpread &&
        current.allowHarnessApiKeyEnv === next.allowHarnessApiKeyEnv,
    ),
  ),
)

const preferenceStorageAtom = Atom.keepAlive(Atom.make<PreferenceStorage | undefined>(undefined))

/** Applies a validated preference patch and persists it through this registry's hydrated storage port. */
export const setPreferencesAtom = Atom.writable(
  get => get(preferencesAtom),
  (context, update: Partial<Preferences>) => {
    const candidate = { ...context.get(preferencesAtom), ...update }
    const decoded = Schema.decodeUnknownResult(preferencesSchema)(candidate)
    if (decoded._tag === 'Failure') return

    context.set(preferencesAtom, decoded.success)
    const storage = context.get(preferenceStorageAtom)
    if (storage) writePreferences(storage, decoded.success)
  },
)

/** Reads storage once, then applies valid cross-window changes to this registry. */
export function hydratePreferences(registry: AtomRegistry.AtomRegistry, storage: PreferenceStorage): () => void {
  registry.set(preferenceStorageAtom, storage)
  registry.set(preferencesAtom, readPreferences(storage))

  const clearStorage = (): void => {
    if (registry.get(preferenceStorageAtom) === storage) registry.set(preferenceStorageAtom, undefined)
  }
  try {
    const unsubscribe = storage.subscribe(value => {
      const next = decodePreferencesValue(value)
      if (next) registry.set(preferencesAtom, next)
    })
    return () => {
      unsubscribe()
      clearStorage()
    }
  } catch {
    return clearStorage
  }
}

/** Updates and persists the six preferences while preserving other window state. */
export function updatePreferences(
  registry: AtomRegistry.AtomRegistry,
  storage: PreferenceStorage,
  update: Partial<Preferences>,
): void {
  const previousStorage = registry.get(preferenceStorageAtom)
  registry.set(preferenceStorageAtom, storage)
  try {
    registry.set(setPreferencesAtom, update)
  } finally {
    if (registry.get(preferenceStorageAtom) === storage) {
      registry.set(preferenceStorageAtom, previousStorage)
    }
  }
}

export { PREFERENCES_STORAGE_KEY }
