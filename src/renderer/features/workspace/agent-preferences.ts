import { RegistryContext, useAtomValue } from '@effect/atom-react'
import * as Atom from 'effect/reactivity/Atom'
import * as Schema from 'effect/Schema'
import { useContext, useEffect } from 'react'

const STORAGE_KEY = 'watchtower.workspace.agent-preferences.v1'
const choiceSchema = Schema.Struct({ modelId: Schema.String, modeId: Schema.String })
const preferencesSchema = Schema.Struct({
  connectionId: Schema.String,
  choices: Schema.Record(Schema.String, choiceSchema),
})
type Preferences = Schema.Schema.Type<typeof preferencesSchema>
const preferencesAtom = Atom.keepAlive(Atom.make<Preferences>({ connectionId: '', choices: {} }))
const hydrated = new WeakSet<object>()

/** Remember user choices by immutable connection identity, independently of draft text. */
export function useWorkspaceAgentPreferences() {
  const registry = useContext(RegistryContext)
  const preferences = useAtomValue(preferencesAtom)
  useEffect(() => {
    if (hydrated.has(registry)) return
    hydrated.add(registry)
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const decoded = Schema.decodeUnknownOption(preferencesSchema)(JSON.parse(raw))
      if (decoded._tag === 'Some') registry.set(preferencesAtom, decoded.value)
    } catch {
      /* Keep the current window usable when storage cannot be read. */
    }
  }, [registry])

  function save(value: Preferences): void {
    registry.set(preferencesAtom, value)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    } catch {
      /* Choices still apply in this window. */
    }
  }
  function updateChoice(change: { readonly modelId?: string; readonly modeId?: string }): void {
    const current = registry.get(preferencesAtom)
    const selected = current.choices[current.connectionId] ?? { modelId: '', modeId: '' }
    const choices = { ...current.choices, [current.connectionId]: { ...selected, ...change } }
    save({ ...current, choices })
  }
  return {
    connectionId: preferences.connectionId,
    modelId: preferences.choices[preferences.connectionId]?.modelId ?? '',
    modeId: preferences.choices[preferences.connectionId]?.modeId ?? '',
    setConnectionId: (connectionId: string) => save({ ...registry.get(preferencesAtom), connectionId }),
    setModelId: (modelId: string) => updateChoice({ modelId, modeId: '' }),
    setModeId: (modeId: string) => updateChoice({ modeId }),
  }
}
