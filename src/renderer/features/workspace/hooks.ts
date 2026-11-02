import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import * as Option from 'effect/Option'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import type * as Atom from 'effect/reactivity/Atom'
import { useContext, useEffect } from 'react'

import type { RpcQuerySlot } from '@/renderer/stores/atoms/rpc-query.js'
import { pinWindowAtom, querySnapshot, useRemoteQuery } from '@/renderer/stores/hooks/use-remote-query.js'

import {
  cancelQueuedFollowUpAtom,
  cloneProjectAtom,
  createProjectAtom,
  createTaskAtom,
  enqueueFollowUpAtom,
  interruptAtom,
  promoteQueuedFollowUpAtom,
  registerProjectAtom,
  respondAtom,
  retainWorkspaceQuery,
  retainWorkspaceSidebarQuery,
  startRunAtom,
  steerAtom,
  workspaceConversation,
  workspaceFollowUps,
  workspaceNativeAgentSessions,
  workspacePayload,
  workspaceProject,
  workspaceProjectionAtom,
  workspaceProjects,
  workspaceRequestResponses,
  workspaceRequests,
  workspaceStatus,
  workspaceSteerIntents,
  workspaceStreamStateAtom,
  workspaceSubscriptionAtom,
  workspaceTask,
  workspaceTasks,
  workspaceTasksForSidebar,
  workspaceTaskSnapshot,
} from './atoms.js'
import { nextConversationRequest, nextPayloadRequest, workspaceQueryKey, type WorkspaceRequest } from './lib.js'

function useWorkspaceLifetime() {
  const registry = useContext(RegistryContext)
  useEffect(() => {
    pinWindowAtom(registry, workspaceSubscriptionAtom)
  }, [registry])
}

function useWorkspaceQuery<Request, Value, Error>(slot: RpcQuerySlot<Request, Value, Error>, request: Request | null) {
  useWorkspaceLifetime()
  const registry = useContext(RegistryContext)
  const active = request !== null
  useEffect(() => {
    if (active) return retainWorkspaceQuery(registry, slot)
  }, [registry, slot, active])
  return useRemoteQuery(slot, request, workspaceQueryKey)
}

/** Activates the one-per-window subscription; unmounting a view never interrupts a Run. */
export function useWorkspaceEvents() {
  useWorkspaceLifetime()
  return { projection: useAtomValue(workspaceProjectionAtom), stream: useAtomValue(workspaceStreamStateAtom) }
}

const statusRequest = {}
export const useWorkspaceStatus = () => useWorkspaceQuery(workspaceStatus, statusRequest)
export const useWorkspaceProjects = (request: WorkspaceRequest<'workspace:listProjects'> | null) =>
  useWorkspaceQuery(workspaceProjects, request)
export const useWorkspaceProject = (request: WorkspaceRequest<'workspace:getProject'> | null) =>
  useWorkspaceQuery(workspaceProject, request)
export const useWorkspaceTasks = (request: WorkspaceRequest<'workspace:listTasks'> | null) =>
  useWorkspaceQuery(workspaceTasks, request)
export function useWorkspaceSidebarTasks(
  projectId: import('@/shared/schemas/workspace.js').ProjectId,
  request: WorkspaceRequest<'workspace:listTasks'> | null,
) {
  useWorkspaceLifetime()
  const registry = useContext(RegistryContext)
  const slot = workspaceTasksForSidebar(projectId)
  const selected = useAtomValue(slot.requestAtom)
  const result = useAtomValue(slot.resultAtom)
  const select = useAtomSet(slot.requestAtom)
  const active = request !== null
  useEffect(() => {
    if (!request) return
    const release = retainWorkspaceSidebarQuery(registry, slot)
    select(request)
    return () => {
      select(null)
      release()
    }
  }, [active, registry, request, select, slot])
  if (!request || !selected || workspaceQueryKey(selected) !== workspaceQueryKey(request))
    return querySnapshot(AsyncResult.initial())
  return querySnapshot(result)
}
export const useWorkspaceTask = (request: WorkspaceRequest<'workspace:readTaskDetail'> | null) =>
  useWorkspaceQuery(workspaceTask, request)
export const useWorkspaceTaskSnapshot = (request: WorkspaceRequest<'workspace:readTaskSnapshot'> | null) =>
  useWorkspaceQuery(workspaceTaskSnapshot, request)
export const useWorkspaceNativeAgentSessions = (
  request: WorkspaceRequest<'workspace:listNativeAgentSessions'> | null,
) => useWorkspaceQuery(workspaceNativeAgentSessions, request)
export const useWorkspacePendingRequests = (request: WorkspaceRequest<'workspace:listPendingRuntimeRequests'> | null) =>
  useWorkspaceQuery(workspaceRequests, request)
export const useWorkspaceRequestResponses = (request: WorkspaceRequest<'workspace:listRequestResponses'> | null) =>
  useWorkspaceQuery(workspaceRequestResponses, request)
export const useWorkspaceSteerIntents = (request: WorkspaceRequest<'workspace:listSteerIntents'> | null) =>
  useWorkspaceQuery(workspaceSteerIntents, request)
export const useWorkspaceQueuedFollowUps = (request: WorkspaceRequest<'workspace:listQueuedFollowUps'> | null) =>
  useWorkspaceQuery(workspaceFollowUps, request)

export function useWorkspaceConversation(request: WorkspaceRequest<'workspace:readConversationPage'> | null) {
  const query = useWorkspaceQuery(workspaceConversation, request)
  return {
    ...query,
    nextRequest: request && query.data ? nextConversationRequest(request, query.data) : null,
    resumeAfterSequence: query.data && !query.data.hasMore ? query.data.highWatermark : null,
  }
}

export function useWorkspacePayload(request: WorkspaceRequest<'workspace:readWorkspacePayload'> | null) {
  const query = useWorkspaceQuery(workspacePayload, request)
  return { ...query, nextRequest: request && query.data ? nextPayloadRequest(request, query.data) : null }
}

function commandStatus(result: AsyncResult.AsyncResult<unknown, unknown>): 'idle' | 'pending' | 'success' | 'error' {
  if (result.waiting) return 'pending'
  if (result._tag === 'Success') return 'success'
  if (result._tag === 'Failure') return 'error'
  return 'idle'
}

function useWorkspaceCommand<Input, Value, Error>(atom: Atom.AtomResultFn<Input, Value, Error>) {
  useWorkspaceLifetime()
  const registry = useContext(RegistryContext)
  useEffect(() => {
    pinWindowAtom(registry, atom)
  }, [registry, atom])
  const result = useAtomValue(atom)
  const execute = useAtomSet(atom, { mode: 'promise' })
  return {
    execute: (input: Input) => execute(input),
    pending: result.waiting,
    status: commandStatus(result),
    data: Option.getOrNull(AsyncResult.value(result)),
    error: querySnapshot(result).error,
    failure: Option.getOrNull(AsyncResult.error(result)),
  }
}

export const useRegisterProject = () => useWorkspaceCommand(registerProjectAtom)
export const useCreateProject = () => useWorkspaceCommand(createProjectAtom)
export const useCloneProject = () => useWorkspaceCommand(cloneProjectAtom)
export const useCreateTask = () => useWorkspaceCommand(createTaskAtom)
export const useStartRun = () => useWorkspaceCommand(startRunAtom)
export const useInterruptRun = () => useWorkspaceCommand(interruptAtom)
export const useRespondToRuntimeRequest = () => useWorkspaceCommand(respondAtom)
export const useSteerRun = () => useWorkspaceCommand(steerAtom)
export const useEnqueueFollowUp = () => useWorkspaceCommand(enqueueFollowUpAtom)
export const useCancelQueuedFollowUp = () => useWorkspaceCommand(cancelQueuedFollowUpAtom)
export const usePromoteQueuedFollowUp = () => useWorkspaceCommand(promoteQueuedFollowUpAtom)

export type {
  WorkspaceAttention,
  WorkspaceProjection,
  WorkspaceRunProjection,
  WorkspaceTaskProjection,
} from './events.js'
export type { WorkspaceCommandInput, WorkspaceRequest, WorkspaceResult } from './lib.js'
