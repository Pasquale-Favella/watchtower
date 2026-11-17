import * as Schema from 'effect/Schema'

import { WORKSPACE_PROMPT_MAX_LENGTH } from '@/shared/schemas/prompt-context.js'

const STORAGE_KEY = 'watchtower.workspace.new-chat-draft.v1'
export const NEW_CHAT_DRAFT_MAX_LENGTH = WORKSPACE_PROMPT_MAX_LENGTH
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000

const storedDraftSchema = Schema.Struct({ text: Schema.String, updatedAt: Schema.Number })
export type StoredNewChatDraft = Schema.Schema.Type<typeof storedDraftSchema>

export type NewChatDraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function newChatTaskTitle(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
  return firstLine.slice(0, 100) || 'New Task'
}

export function readNewChatDraft(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null,
  now = Date.now(),
): string {
  if (!storage) return ''
  try {
    const value = storage.getItem(STORAGE_KEY)
    if (!value) return ''
    const draft = Schema.decodeUnknownOption(storedDraftSchema)(JSON.parse(value))
    if (draft._tag === 'None' || now - draft.value.updatedAt > RETENTION_MS) {
      storage.removeItem(STORAGE_KEY)
      return ''
    }
    return draft.value.text.slice(0, NEW_CHAT_DRAFT_MAX_LENGTH)
  } catch {
    return ''
  }
}

export function writeNewChatDraft(storage: NewChatDraftStorage | null, text: string, now = Date.now()): string {
  const bounded = text.slice(0, NEW_CHAT_DRAFT_MAX_LENGTH)
  try {
    if (!storage) return bounded
    if (!bounded) storage.removeItem(STORAGE_KEY)
    else storage.setItem(STORAGE_KEY, JSON.stringify({ text: bounded, updatedAt: now } satisfies StoredNewChatDraft))
  } catch {
    // Keep the current window usable when browser storage is unavailable.
  }
  return bounded
}
