import * as Schema from 'effect/Schema'

import type { ConversationId } from '@/shared/schemas/workspace.js'

const STORAGE_KEY = 'watchtower.workspace.drafts.v1'
export const WORKSPACE_DRAFT_RETENTION_MS = 60 * 24 * 60 * 60 * 1000
export const WORKSPACE_DRAFT_MAX_CONVERSATIONS = 40
export const WORKSPACE_DRAFT_MAX_LENGTH = 12_000

const draftSchema = Schema.Struct({ text: Schema.String, updatedAt: Schema.Number })
const draftsSchema = Schema.Record(Schema.String, draftSchema)
const composerPreferenceSchema = Schema.Struct({
  checkoutId: Schema.optional(Schema.String),
  connectionId: Schema.optional(Schema.String),
  updatedAt: Schema.Number,
})
const composerPreferencesSchema = Schema.Record(Schema.String, composerPreferenceSchema)

export type WorkspaceDraft = Schema.Schema.Type<typeof draftSchema>
export type WorkspaceDrafts = Readonly<Record<string, WorkspaceDraft>>
export type WorkspaceComposerPreference = Schema.Schema.Type<typeof composerPreferenceSchema>
export type WorkspaceComposerPreferences = Readonly<Record<string, WorkspaceComposerPreference>>
export type WorkspaceDraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function pruneDrafts(drafts: WorkspaceDrafts, now: number): Record<string, WorkspaceDraft> {
  return Object.fromEntries(
    Object.entries(drafts)
      .filter(([, draft]) => draft.text.length > 0 && now - draft.updatedAt <= WORKSPACE_DRAFT_RETENTION_MS)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, WORKSPACE_DRAFT_MAX_CONVERSATIONS)
      .map(([id, draft]) => [id, { ...draft, text: draft.text.slice(0, WORKSPACE_DRAFT_MAX_LENGTH) }]),
  )
}

export function readWorkspaceDrafts(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  now = Date.now(),
): Record<string, WorkspaceDraft> {
  if (!storage) return {}
  try {
    const value = storage.getItem(STORAGE_KEY)
    if (!value) return {}
    const decoded = Schema.decodeUnknownOption(draftsSchema)(JSON.parse(value))
    if (decoded._tag === 'None') {
      storage.setItem(STORAGE_KEY, '{}')
      return {}
    }
    const pruned = pruneDrafts(decoded.value, now)
    if (Object.keys(pruned).length !== Object.keys(decoded.value).length)
      storage.setItem(STORAGE_KEY, JSON.stringify(pruned))
    return pruned
  } catch {
    return {}
  }
}

export function writeWorkspaceDraft(
  storage: WorkspaceDraftStorage | null,
  drafts: WorkspaceDrafts,
  conversationId: ConversationId,
  text: string,
  now = Date.now(),
): Record<string, WorkspaceDraft> {
  const next = { ...drafts }
  if (text.length === 0) {
    const remaining = Object.fromEntries(Object.entries(next).filter(([id]) => id !== conversationId))
    return writeDrafts(storage, remaining, now)
  }
  next[conversationId] = { text: text.slice(0, WORKSPACE_DRAFT_MAX_LENGTH), updatedAt: now }
  return writeDrafts(storage, next, now)
}

function writeDrafts(storage: WorkspaceDraftStorage | null, drafts: WorkspaceDrafts, now: number) {
  const pruned = pruneDrafts(drafts, now)
  try {
    if (!storage) return pruned
    if (Object.keys(pruned).length === 0) storage.removeItem(STORAGE_KEY)
    else storage.setItem(STORAGE_KEY, JSON.stringify(pruned))
  } catch {
    // Draft editing remains available in the current window when storage is unavailable.
  }
  return pruned
}

const PREFERENCES_STORAGE_KEY = 'watchtower.workspace.composer-preferences.v1'

export function readWorkspaceComposerPreferences(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  now = Date.now(),
): Record<string, WorkspaceComposerPreference> {
  if (!storage) return {}
  try {
    const value = storage.getItem(PREFERENCES_STORAGE_KEY)
    if (!value) return {}
    const decoded = Schema.decodeUnknownOption(composerPreferencesSchema)(JSON.parse(value))
    if (decoded._tag === 'None') {
      storage.setItem(PREFERENCES_STORAGE_KEY, '{}')
      return {}
    }
    const preferences = Object.fromEntries(
      Object.entries(decoded.value)
        .filter(([, preference]) => now - preference.updatedAt <= WORKSPACE_DRAFT_RETENTION_MS)
        .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
        .slice(0, WORKSPACE_DRAFT_MAX_CONVERSATIONS),
    )
    if (Object.keys(preferences).length !== Object.keys(decoded.value).length)
      storage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences))
    return preferences
  } catch {
    return {}
  }
}

export function writeWorkspaceComposerPreference(
  storage: WorkspaceDraftStorage | null,
  preferences: WorkspaceComposerPreferences,
  conversationId: ConversationId,
  preference: Omit<WorkspaceComposerPreference, 'updatedAt'>,
  now = Date.now(),
): Record<string, WorkspaceComposerPreference> {
  const next = { ...preferences }
  next[conversationId] = { ...preference, updatedAt: now }
  const pruned = Object.fromEntries(
    Object.entries(next)
      .filter(([, value]) => now - value.updatedAt <= WORKSPACE_DRAFT_RETENTION_MS)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, WORKSPACE_DRAFT_MAX_CONVERSATIONS),
  )
  try {
    storage?.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(pruned))
  } catch {
    // Selection still works for this window when storage is unavailable.
  }
  return pruned
}
