import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'

import {
  CONVERSATION_DETAILS_ITEMS_STORAGE_KEY,
  type ConversationDetailsItemId,
  type ConversationDetailsItemsStorage,
  defaultConversationDetailsItems,
  readConversationDetailsItems,
  writeConversationDetailsItems,
} from './conversation-details-items.js'

export type ConversationDetailsItemsAtomStorage = ConversationDetailsItemsStorage & Pick<Storage, 'removeItem'>

export const conversationDetailsItemsAtom = Atom.keepAlive(Atom.make(defaultConversationDetailsItems))

const storageAtom = Atom.keepAlive(Atom.make<ConversationDetailsItemsAtomStorage | null>(null))
const hydratedRegistries = new WeakSet<AtomRegistry.AtomRegistry>()

/** Reads saved row visibility once for this renderer registry. */
export function hydrateConversationDetailsItems(
  registry: AtomRegistry.AtomRegistry,
  storage: ConversationDetailsItemsAtomStorage | null,
): void {
  if (hydratedRegistries.has(registry)) return
  hydratedRegistries.add(registry)
  registry.set(storageAtom, storage)
  registry.set(conversationDetailsItemsAtom, readConversationDetailsItems(storage))
}

/** Updates and persists one row's visibility. */
export const setConversationDetailsItemVisibilityAtom = Atom.writable(
  get => get(conversationDetailsItemsAtom),
  (context, update: { readonly id: ConversationDetailsItemId; readonly visible: boolean }) => {
    const next = { ...context.get(conversationDetailsItemsAtom), [update.id]: update.visible }
    context.set(conversationDetailsItemsAtom, next)
    writeConversationDetailsItems(context.get(storageAtom), next)
  },
)

/** Restores default visibility and removes the stored override. */
export const resetConversationDetailsItemsAtom = Atom.writable(
  get => get(conversationDetailsItemsAtom),
  context => {
    context.set(conversationDetailsItemsAtom, defaultConversationDetailsItems)
    try {
      context.get(storageAtom)?.removeItem(CONVERSATION_DETAILS_ITEMS_STORAGE_KEY)
    } catch {
      /* Reset still applies in this window when storage is unavailable. */
    }
  },
)
