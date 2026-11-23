import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import { useCallback, useContext, useEffect } from 'react'

import { useErrorToast } from '@/renderer/features/workspace/error-toast.js'
import { useWorkspaceEvents } from '@/renderer/features/workspace/hooks.js'
import { restartRpcQuery } from '@/renderer/stores/atoms/rpc-query.js'
import { pinWindowAtom, querySnapshot, useRemoteQuery } from '@/renderer/stores/hooks/use-remote-query.js'
import type { TaskId } from '@/shared/schemas/workspace.js'

import {
  coachChatKey,
  coachChatQuery,
  coachChatRequest,
  coachChatStartingAtom,
  discardCoachChatAtom,
  saveSkillAtom,
} from './coach-chat-atoms.js'

/** The one live coaching chat, found again after navigation and refreshed whenever the Workspace stream reconnects. */
export function useCoachChat() {
  const registry = useContext(RegistryContext)
  const chat = useRemoteQuery(coachChatQuery, coachChatRequest, coachChatKey)
  const { stream } = useWorkspaceEvents()
  useEffect(() => {
    if (stream.status === 'live') registry.set(coachChatQuery.refreshAtom, undefined)
  }, [registry, stream.status])
  const reload = useCallback(() => restartRpcQuery(registry, coachChatQuery), [registry])
  return { chat, reload }
}

/** New chat: interrupts and purges the live coaching chat, then reloads the lookup. Failures surface as a toast. */
export function useDiscardCoachChat() {
  const registry = useContext(RegistryContext)
  const result = useAtomValue(discardCoachChatAtom)
  const execute = useAtomSet(discardCoachChatAtom, { mode: 'promise' })
  useEffect(() => pinWindowAtom(registry, discardCoachChatAtom), [registry])
  useErrorToast('coach:discard-chat', "Couldn't discard the chat", querySnapshot(result).error)
  const discard = useCallback(
    async (taskId: TaskId): Promise<void> => {
      if (registry.get(discardCoachChatAtom).waiting) return
      try {
        await execute({ payload: { taskId } })
        restartRpcQuery(registry, coachChatQuery)
      } catch {
        // The RPC result supplies the error toast.
      }
    },
    [execute, registry],
  )
  return { discard, discarding: result.waiting }
}

/** Whether the first message of a new chat is still being created and admitted. */
export const useCoachChatStarting = () => useAtomValue(coachChatStartingAtom)

/** Reports the first-message start to New chat; the setter stays valid after the composer unmounts. */
export const useSetCoachChatStarting = () => useAtomSet(coachChatStartingAtom)

export function useSaveSkill() {
  return useAtomSet(saveSkillAtom, { mode: 'promise' })
}
