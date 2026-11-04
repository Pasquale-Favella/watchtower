import { RegistryContext, useAtomValue } from '@effect/atom-react'
import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Schema from 'effect/Schema'
import { useContext } from 'react'

import { type AgentAccessMode, agentAccessModeSchema, DEFAULT_AGENT_ACCESS_MODE } from '@/shared/schemas/execution.js'

const STORAGE_KEY = 'watchtower.workspace.agent-preferences.v1'
const choiceSchema = Schema.Struct({ modelId: Schema.String, modeId: Schema.String })
const preferencesSchema = Schema.Struct({
  connectionId: Schema.String,
  choices: Schema.Record(Schema.String, choiceSchema),
  /** The permissions a new chat starts with. Absent means the fail-safe default. */
  accessMode: Schema.optional(agentAccessModeSchema),
})
export type AgentChoice = Schema.Schema.Type<typeof choiceSchema>
export type AgentPreferences = Schema.Schema.Type<typeof preferencesSchema>

const preferencesAtom = Atom.keepAlive(Atom.make<AgentPreferences>({ connectionId: '', choices: {} }))
const hydrated = new WeakSet<AtomRegistry.AtomRegistry>()

/** Decodes stored preferences. Malformed or unreadable storage yields null. */
export function decodeAgentPreferences(raw: string | null): AgentPreferences | null {
  if (!raw) return null
  try {
    const decoded = Schema.decodeUnknownOption(preferencesSchema)(JSON.parse(raw))
    return decoded._tag === 'Some' ? decoded.value : null
  } catch {
    return null
  }
}

/** Merges a change into the choice remembered for one connection. Other connections are untouched. */
export function withRememberedChoice(
  preferences: AgentPreferences,
  connectionId: string,
  change: { readonly modelId?: string; readonly modeId?: string },
): AgentPreferences {
  const selected = preferences.choices[connectionId] ?? { modelId: '', modeId: '' }
  return { ...preferences, choices: { ...preferences.choices, [connectionId]: { ...selected, ...change } } }
}

export function rememberedChoice(preferences: AgentPreferences, connectionId: string): AgentChoice | undefined {
  return preferences.choices[connectionId]
}

function hydrate(registry: AtomRegistry.AtomRegistry): void {
  if (hydrated.has(registry)) return
  hydrated.add(registry)
  try {
    const stored = decodeAgentPreferences(localStorage.getItem(STORAGE_KEY))
    if (stored) registry.set(preferencesAtom, stored)
  } catch {
    /* Keep the current window usable when storage cannot be read. */
  }
}

function save(registry: AtomRegistry.AtomRegistry, value: AgentPreferences): void {
  registry.set(preferencesAtom, value)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    /* Choices still apply in this window. */
  }
}

/** Remember user choices by immutable connection identity, independently of draft text.
 *  Hydration runs during the first render, before any effect can read or normalize a choice. */
export function useWorkspaceAgentPreferences() {
  const registry = useContext(RegistryContext)
  hydrate(registry)
  const preferences = useAtomValue(preferencesAtom)
  function updateChoice(change: { readonly modelId?: string; readonly modeId?: string }): void {
    const current = registry.get(preferencesAtom)
    save(registry, withRememberedChoice(current, current.connectionId, change))
  }
  const selected = rememberedChoice(preferences, preferences.connectionId)
  return {
    connectionId: preferences.connectionId,
    modelId: selected?.modelId ?? '',
    modeId: selected?.modeId ?? '',
    accessMode: preferences.accessMode ?? DEFAULT_AGENT_ACCESS_MODE,
    setConnectionId: (connectionId: string) => save(registry, { ...registry.get(preferencesAtom), connectionId }),
    setModelId: (modelId: string) => updateChoice({ modelId, modeId: '' }),
    setModeId: (modeId: string) => updateChoice({ modeId }),
    setAccessMode: (accessMode: AgentAccessMode) => save(registry, { ...registry.get(preferencesAtom), accessMode }),
  }
}

/** Reads and records the sticky choice of every connection, for the agent picker. */
export function useRememberedAgentChoices() {
  const registry = useContext(RegistryContext)
  hydrate(registry)
  const preferences = useAtomValue(preferencesAtom)
  return {
    choiceFor: (connectionId: string): AgentChoice | undefined => rememberedChoice(preferences, connectionId),
    remember: (connectionId: string, choice: AgentChoice): void =>
      save(registry, withRememberedChoice(registry.get(preferencesAtom), connectionId, choice)),
  }
}
