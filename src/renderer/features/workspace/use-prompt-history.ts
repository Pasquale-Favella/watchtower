import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Schema from 'effect/Schema'
import { useContext, useEffect, useMemo } from 'react'

import { ApplicationClient } from '@/renderer/shared/lib/application-rpc.js'
import { createRpcQuerySlot } from '@/renderer/stores/atoms/rpc-query.js'
import { querySnapshot } from '@/renderer/stores/hooks/use-remote-query.js'
import { type ConversationId, conversationIdSchema, type TaskId } from '@/shared/schemas/workspace.js'

import { useWorkspaceEvents } from './hooks.js'
import { workspaceQueryKey, type WorkspaceRequest } from './lib.js'

/** Loads only the current Conversation's recent user messages in a private query slot. */
export function usePromptHistory(taskId: TaskId, conversationId: ConversationId) {
  const registry = useContext(RegistryContext)
  const slot = useMemo(
    () =>
      createRpcQuerySlot({
        key: workspaceQueryKey,
        query: (request: WorkspaceRequest<'workspace:readConversationPage'>, id: string) =>
          ApplicationClient.query('workspace:readConversationPage', request, { serializationKey: id }),
      }),
    [],
  )
  const request = useMemo<WorkspaceRequest<'workspace:readConversationPage'>>(
    () => ({ conversationId, afterSequence: 0, direction: 'backward', limit: 100 }),
    [conversationId],
  )
  const selected = useAtomValue(slot.requestAtom)
  const result = useAtomValue(slot.resultAtom)
  const select = useAtomSet(slot.requestAtom)
  const refresh = useAtomSet(slot.refreshAtom)
  const { projection } = useWorkspaceEvents()
  const latestUserMessageSequence = useMemo(() => {
    const transcript = projection.tasks[taskId]?.transcript ?? []
    return [...transcript].reverse().find(event => {
      if (event.kind !== 'runQueued') return false
      const identity = Schema.decodeUnknownOption(Schema.Struct({ conversationId: conversationIdSchema }))(event.data)
      return identity._tag === 'Some' && identity.value.conversationId === conversationId
    })?.sequence
  }, [projection.tasks, taskId, conversationId])
  useEffect(() => {
    const unmount = slot.pin(registry)
    select(request)
    return () => {
      select(null)
      unmount()
    }
  }, [registry, request, select, slot])
  useEffect(() => {
    refresh()
  }, [latestUserMessageSequence, refresh])
  if (!selected || workspaceQueryKey(selected) !== workspaceQueryKey(request))
    return querySnapshot(AsyncResult.initial())
  return querySnapshot(result)
}
