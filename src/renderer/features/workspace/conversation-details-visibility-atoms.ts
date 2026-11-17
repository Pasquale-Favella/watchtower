import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'

import {
  type ConversationDetailsVisibilityStorage,
  readConversationDetailsPreferences,
  rememberConversationDetailsOpen,
} from './conversation-details-visibility.js'

export const conversationDetailsVisibilityAtom = Atom.keepAlive(Atom.make<Readonly<Record<string, boolean>>>({}))

const conversationDetailsStorageAtom = Atom.keepAlive(Atom.make<ConversationDetailsVisibilityStorage | null>(null))
const hydratedRegistries = new WeakSet<AtomRegistry.AtomRegistry>()

/** Reads saved visibility once for this renderer registry. */
export function hydrateConversationDetailsVisibility(
  registry: AtomRegistry.AtomRegistry,
  storage: ConversationDetailsVisibilityStorage | null,
): void {
  if (hydratedRegistries.has(registry)) return
  hydratedRegistries.add(registry)
  registry.set(conversationDetailsStorageAtom, storage)
  registry.set(conversationDetailsVisibilityAtom, readConversationDetailsPreferences(storage))
}

/** Remembers inline visibility for one Conversation. */
export const updateConversationDetailsVisibilityAtom = Atom.writable(
  get => get(conversationDetailsVisibilityAtom),
  (context, update: { readonly conversationId: string; readonly open: boolean }) => {
    context.set(
      conversationDetailsVisibilityAtom,
      rememberConversationDetailsOpen(
        context.get(conversationDetailsStorageAtom),
        context.get(conversationDetailsVisibilityAtom),
        update.conversationId,
        update.open,
      ),
    )
  },
)
