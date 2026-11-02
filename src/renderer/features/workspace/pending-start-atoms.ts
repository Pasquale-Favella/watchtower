import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'

import {
  capturePendingStart,
  clearPendingStart,
  emptyPendingStartStore,
  markPendingStartUncertain,
  type PendingStartRecord,
  type PendingStartStorage,
  type PendingStartStore,
  readPendingStartStore,
} from './pending-start-state.js'

export const pendingStartStoreAtom = Atom.keepAlive(
  Atom.make<PendingStartStore>({
    ...emptyPendingStartStore,
    error: 'Checking saved Run intents…',
  }),
)
const pendingStartStorageAtom = Atom.keepAlive(Atom.make<PendingStartStorage | null>(null))
const hydratedRegistries = new WeakSet<AtomRegistry.AtomRegistry>()

export function hydratePendingStartStore(
  registry: AtomRegistry.AtomRegistry,
  storage: PendingStartStorage | null,
): void {
  if (hydratedRegistries.has(registry)) return
  hydratedRegistries.add(registry)
  registry.set(pendingStartStorageAtom, storage)
  registry.set(pendingStartStoreAtom, readPendingStartStore(storage))
}

type PendingStartAction =
  | { readonly kind: 'capture'; readonly record: PendingStartRecord }
  | {
      readonly kind: 'uncertain'
      readonly conversationId: PendingStartRecord['conversationId']
      readonly commandId: string
    }
  | {
      readonly kind: 'clear'
      readonly conversationId: PendingStartRecord['conversationId']
      readonly commandId: string
    }

export const updatePendingStartStoreAtom = Atom.writable(
  get => get(pendingStartStoreAtom),
  (context, action: PendingStartAction) => {
    const storage = context.get(pendingStartStorageAtom)
    const current = context.get(pendingStartStoreAtom)
    const next =
      action.kind === 'capture'
        ? capturePendingStart(storage, current, action.record, action.record.updatedAt)
        : action.kind === 'uncertain'
          ? markPendingStartUncertain(storage, current, action.conversationId, action.commandId)
          : clearPendingStart(storage, current, action.conversationId, action.commandId)
    context.set(pendingStartStoreAtom, next)
  },
)
