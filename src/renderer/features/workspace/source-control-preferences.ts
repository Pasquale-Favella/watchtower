import { RegistryContext, useAtomValue } from '@effect/atom-react'
import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Schema from 'effect/Schema'
import { useContext } from 'react'

const STORAGE_KEY = 'watchtower.workspace.source-control-preferences.v1'

export const mergeMethodSchema = Schema.Literals(['merge', 'squash', 'rebase'])
export type MergeMethod = Schema.Schema.Type<typeof mergeMethodSchema>

/** Fields are optional on disk so a value added later never invalidates what an older build stored. */
const storedSchema = Schema.Struct({
  githubOffered: Schema.optional(Schema.Boolean),
  mergeMethod: Schema.optional(mergeMethodSchema),
})
export interface SourceControlPreferences {
  /** Whether add-project offers cloning from and publishing to GitHub. */
  readonly githubOffered: boolean
  /** The method a merge starts with; each merge can still change it. */
  readonly mergeMethod: MergeMethod
}

export const DEFAULT_SOURCE_CONTROL_PREFERENCES: SourceControlPreferences = {
  githubOffered: true,
  mergeMethod: 'squash',
}

export const MERGE_METHOD_OPTIONS: readonly { readonly value: MergeMethod; readonly label: string }[] = [
  { value: 'squash', label: 'Squash and merge' },
  { value: 'merge', label: 'Create a merge commit' },
  { value: 'rebase', label: 'Rebase and merge' },
]

/** Decodes stored preferences over the defaults. Missing, malformed or unreadable storage yields null. */
export function decodeSourceControlPreferences(raw: string | null): SourceControlPreferences | null {
  if (!raw) return null
  try {
    const decoded = Schema.decodeUnknownOption(storedSchema)(JSON.parse(raw))
    return decoded._tag === 'Some' ? { ...DEFAULT_SOURCE_CONTROL_PREFERENCES, ...decoded.value } : null
  } catch {
    return null
  }
}

const preferencesAtom = Atom.keepAlive(Atom.make<SourceControlPreferences>(DEFAULT_SOURCE_CONTROL_PREFERENCES))
const hydrated = new WeakSet<AtomRegistry.AtomRegistry>()

function hydrate(registry: AtomRegistry.AtomRegistry): void {
  if (hydrated.has(registry)) return
  hydrated.add(registry)
  try {
    const stored = decodeSourceControlPreferences(localStorage.getItem(STORAGE_KEY))
    if (stored) registry.set(preferencesAtom, stored)
  } catch {
    /* Keep the current window usable when storage cannot be read. */
  }
}

function save(registry: AtomRegistry.AtomRegistry, change: Partial<SourceControlPreferences>): void {
  const value = { ...registry.get(preferencesAtom), ...change }
  registry.set(preferencesAtom, value)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    /* The choice still applies in this window. */
  }
}

/** Renderer-only Source control preferences: nothing here is read by the main process. */
export function useSourceControlPreferences() {
  const registry = useContext(RegistryContext)
  hydrate(registry)
  const preferences = useAtomValue(preferencesAtom)
  return {
    ...preferences,
    setGithubOffered: (githubOffered: boolean) => save(registry, { githubOffered }),
    setMergeMethod: (mergeMethod: MergeMethod) => save(registry, { mergeMethod }),
    resetGithubOffered: () => save(registry, { githubOffered: DEFAULT_SOURCE_CONTROL_PREFERENCES.githubOffered }),
    resetMergeMethod: () => save(registry, { mergeMethod: DEFAULT_SOURCE_CONTROL_PREFERENCES.mergeMethod }),
  }
}
