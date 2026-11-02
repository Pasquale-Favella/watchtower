import { RegistryContext, useAtomValue } from '@effect/atom-react'
import { useCallback, useContext, useEffect } from 'react'

import type { ConversationId } from '@/shared/schemas/workspace.js'

import { hydratePendingStartStore, pendingStartStoreAtom, updatePendingStartStoreAtom } from './pending-start-atoms.js'
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
  const markUncertain = useCallback(
    (conversationId: ConversationId, commandId: string) => {
      registry.set(updatePendingStartStoreAtom, { kind: 'uncertain', conversationId, commandId })
      return registry.get(pendingStartStoreAtom)
    },
    [registry],
  )
  const clear = useCallback(
    (conversationId: ConversationId, commandId: string) => {
      registry.set(updatePendingStartStoreAtom, { kind: 'clear', conversationId, commandId })
      return registry.get(pendingStartStoreAtom)
    },
    [registry],
  )

  return { store, capture, markUncertain, clear }
}
