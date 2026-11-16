import type { ConversationDetailsMode } from './use-conversation-details-layout.js'

const STORAGE_KEY = 'watchtower.workspace.conversation-details-visibility.v1'
export const CONVERSATION_DETAILS_VISIBILITY_LIMIT = 200

export interface ConversationDetailsVisibilityStorage {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
}

export type ConversationDetailsPreferences = Readonly<Record<string, boolean>>

export function browserConversationDetailsStorage(): ConversationDetailsVisibilityStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function readConversationDetailsPreferences(
  storage: ConversationDetailsVisibilityStorage | null,
): ConversationDetailsPreferences {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (!raw || raw.length > 100_000) return {}
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, open]) => key.length > 0 && typeof open === 'boolean')
        .slice(-CONVERSATION_DETAILS_VISIBILITY_LIMIT),
    )
  } catch {
    return {}
  }
}

export function rememberConversationDetailsOpen(
  storage: ConversationDetailsVisibilityStorage | null,
  preferences: ConversationDetailsPreferences,
  key: string,
  open: boolean,
): ConversationDetailsPreferences {
  const entries = Object.entries(preferences).filter(([candidate]) => candidate !== key)
  entries.push([key, open])
  const bounded = Object.fromEntries(entries.slice(-CONVERSATION_DETAILS_VISIBILITY_LIMIT))
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(bounded))
  } catch {
    /* The toggle still applies in this window when storage is unavailable. */
  }
  return bounded
}

/** Inline visibility is remembered per Conversation; popover visibility is always transient. */
export function initialConversationDetailsOpen(
  key: string,
  mode: ConversationDetailsMode,
  preferences: ConversationDetailsPreferences,
): boolean {
  if (mode !== 'inline' || !Object.hasOwn(preferences, key)) return mode === 'inline'
  return preferences[key] ?? true
}

export function transitionConversationDetailsState(
  key: string,
  mode: ConversationDetailsMode,
  previous: { readonly key: string; readonly mode: ConversationDetailsMode; readonly open: boolean },
  preferences: ConversationDetailsPreferences,
): { readonly key: string; readonly mode: ConversationDetailsMode; readonly open: boolean } {
  if (previous.key === key && previous.mode === mode) return previous
  return { key, mode, open: initialConversationDetailsOpen(key, mode, preferences) }
}
