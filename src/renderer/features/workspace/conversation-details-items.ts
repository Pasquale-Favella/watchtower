import * as Schema from 'effect/Schema'

export const CONVERSATION_DETAILS_ITEMS_STORAGE_KEY = 'watchtower.workspace.conversation-details-items.v1'

export const CONVERSATION_DETAILS_ITEMS = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'branch', label: 'Branch' },
  { id: 'changes', label: 'Diff' },
  { id: 'pullRequests', label: 'Pull requests' },
  { id: 'sideChats', label: 'Side chats' },
] as const

export type ConversationDetailsItemId = (typeof CONVERSATION_DETAILS_ITEMS)[number]['id']
export type ConversationDetailsItems = Readonly<Record<ConversationDetailsItemId, boolean>>
export type ConversationDetailsItemsStorage = Pick<Storage, 'getItem' | 'setItem'>

export const defaultConversationDetailsItems = Object.fromEntries(
  CONVERSATION_DETAILS_ITEMS.map(({ id }) => [id, true]),
) as Record<ConversationDetailsItemId, boolean>

const itemsRecordSchema = Schema.Record(Schema.String, Schema.Unknown)

export function decodeConversationDetailsItems(raw: string | null): ConversationDetailsItems {
  if (!raw || raw.length > 10_000) return defaultConversationDetailsItems
  try {
    const decoded = Schema.decodeUnknownOption(itemsRecordSchema)(JSON.parse(raw))
    if (decoded._tag === 'None') return defaultConversationDetailsItems
    const visible = { ...defaultConversationDetailsItems }
    for (const { id } of CONVERSATION_DETAILS_ITEMS) {
      const value = Schema.decodeUnknownOption(Schema.Boolean)(decoded.value[id])
      if (value._tag === 'Some') visible[id] = value.value
    }
    return visible
  } catch {
    return defaultConversationDetailsItems
  }
}

export function readConversationDetailsItems(
  storage: ConversationDetailsItemsStorage | null,
): ConversationDetailsItems {
  try {
    return decodeConversationDetailsItems(storage?.getItem(CONVERSATION_DETAILS_ITEMS_STORAGE_KEY) ?? null)
  } catch {
    return defaultConversationDetailsItems
  }
}

export function writeConversationDetailsItems(
  storage: ConversationDetailsItemsStorage | null,
  items: ConversationDetailsItems,
): void {
  try {
    storage?.setItem(CONVERSATION_DETAILS_ITEMS_STORAGE_KEY, JSON.stringify(items))
  } catch {
    /* Choices still apply in this window when storage is unavailable. */
  }
}
