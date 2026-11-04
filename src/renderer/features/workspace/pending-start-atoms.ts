import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'

import type { ConversationId } from '@/shared/schemas/workspace.js'
import type { WorkspaceConversationPageItem } from '@/shared/schemas/workspace-store.js'

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
import { type ConversationSubmission, submissionEcho } from './submission-state.js'

export const pendingStartStoreAtom = Atom.keepAlive(
  Atom.make<PendingStartStore>({
    ...emptyPendingStartStore,
    error: 'Checking saved Run intents…',
  }),
)
export const conversationSubmissionsAtom = Atom.keepAlive(
  Atom.make<Readonly<Record<string, ConversationSubmission>>>({}),
)
export const submissionMessageKeysAtom = Atom.keepAlive(Atom.make<Readonly<Record<string, string>>>({}))
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
  const saved = registry.get(pendingStartStoreAtom)
  registry.set(
    conversationSubmissionsAtom,
    Object.fromEntries(
      Object.entries(saved.records).map(([id, record]) => [
        id,
        { record, runId: null, state: 'reconnecting' as const, error: null },
      ]),
    ),
  )
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
    if (action.kind === 'capture' && !next.error) {
      const record = next.records[action.record.conversationId]
      if (record)
        context.set(conversationSubmissionsAtom, {
          ...context.get(conversationSubmissionsAtom),
          [record.conversationId]: { record, runId: null, state: 'sending', error: null },
        })
    }
  },
)

export function reconcileConversationSubmission(
  registry: AtomRegistry.AtomRegistry,
  conversationId: ConversationId,
  items: readonly WorkspaceConversationPageItem[],
): void {
  const current = registry.get(conversationSubmissionsAtom)[conversationId]
  if (!current) return
  const echo = submissionEcho(current, items)
  if (!echo?.userMessage) return
  registry.set(
    submissionMessageKeysAtom,
    Object.fromEntries(
      Object.entries({
        ...registry.get(submissionMessageKeysAtom),
        [echo.userMessage.id]: `message:pending:${current.record.command.commandId}`,
      }).slice(-200),
    ),
  )
  registry.set(updatePendingStartStoreAtom, {
    kind: 'clear',
    conversationId,
    commandId: current.record.command.commandId,
  })
  const { [conversationId]: removed, ...remaining } = registry.get(conversationSubmissionsAtom)
  void removed
  registry.set(conversationSubmissionsAtom, remaining)
}
