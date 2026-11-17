import { RegistryContext, useAtomValue } from '@effect/atom-react'
import { useCallback, useContext, useEffect } from 'react'

import type { ConversationId } from '@/shared/schemas/workspace.js'
import type { WorkspaceConversationPageItem } from '@/shared/schemas/workspace-store.js'

import {
  conversationSubmissionsAtom,
  hydratePendingStartStore,
  pendingStartStoreAtom,
  reconcileConversationSubmission,
  submissionMessageKeysAtom,
  updatePendingStartStoreAtom,
} from './pending-start-atoms.js'
import type { PendingStartCommand } from './pending-start-state.js'

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function usePendingStart() {
  const registry = useContext(RegistryContext)
  const store = useAtomValue(pendingStartStoreAtom)
  const submissions = useAtomValue(conversationSubmissionsAtom)
  const messageKeys = useAtomValue(submissionMessageKeysAtom)

  useEffect(() => hydratePendingStartStore(registry, browserStorage()), [registry])

  const capture = useCallback(
    (input: {
      readonly conversationId: ConversationId
      readonly command: PendingStartCommand
      readonly rawDraft: string
    }) => {
      registry.set(updatePendingStartStoreAtom, {
        kind: 'capture',
        record: { ...input, state: 'pending', updatedAt: Date.now() },
      })
      return registry.get(pendingStartStoreAtom)
    },
    [registry],
  )
  const reconcile = useCallback(
    (conversationId: ConversationId, items: readonly WorkspaceConversationPageItem[]) => {
      reconcileConversationSubmission(registry, conversationId, items)
    },
    [registry],
  )

  return { store, submissions, messageKeys, capture, reconcile }
}
