import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { RpcClientError } from 'effect/rpc/RpcClientError'
import * as Stream from 'effect/Stream'

import { ApplicationClient, ApplicationProtocolLayer } from '@/renderer/shared/lib/application-rpc.js'
import { createRpcQuerySlot } from '@/renderer/stores/atoms/rpc-query.js'
import { RendererConnection } from '@/shared/rpc/reconnecting-protocol.js'
import type { WorkspaceEventFrame, WorkspaceRpcError } from '@/shared/rpc/workspace.js'

import { createWorkspaceIntent, retryWorkspaceIntent } from './commands.js'
import { applyWorkspaceFrame, createWorkspaceProjection, workspaceResume } from './events.js'
import { workspaceQueryKey, type WorkspaceRequest } from './lib.js'
import { createWorkspaceQueryPolling } from './polling.js'

export interface WorkspaceStreamState {
  readonly status: 'inactive' | 'connecting' | 'live' | 'reconnecting' | 'error'
  readonly error: string | null
}
type Client = Effect.Success<typeof ApplicationClient>
type CommandError = WorkspaceRpcError | RpcClientError

const waitForWorkspaceConnection = Effect.gen(function* () {
  const connection = yield* RendererConnection
  while ((yield* connection.current)._tag !== 'Connected') {
    yield* Stream.runHead(connection.changes.pipe(Stream.filter(state => state._tag === 'Connected')))
    yield* Effect.yieldNow
  }
})

export interface WorkspaceSubscriptionOptions {
  readonly runtime?: Atom.RegistryRuntimeFactory
  readonly layer?: Layer.Layer<RendererConnection>
  readonly events?: (afterSequence: number) => Stream.Stream<WorkspaceEventFrame, unknown>
}

/** Descriptors are shared, but every value and subscription belongs to the window's registry. */
export function createWorkspaceAtoms(
  client: typeof ApplicationClient = ApplicationClient,
  options: WorkspaceSubscriptionOptions = {},
) {
  const queryOptions = (selectionId: string) => ({ serializationKey: selectionId })
  const workspaceStatus = createRpcQuerySlot({
    key: workspaceQueryKey,
    query: (_: Record<string, never>, id: string) => client.query('workspace:status', undefined, queryOptions(id)),
  })
  const workspaceProjects = createRpcQuerySlot({
    key: workspaceQueryKey,
    query: (request: WorkspaceRequest<'workspace:listProjects'>, id: string) =>
      client.query('workspace:listProjects', request, queryOptions(id)),
  })
  const workspaceProject = createRpcQuerySlot({
    key: workspaceQueryKey,
    query: (request: WorkspaceRequest<'workspace:getProject'>, id: string) =>
      client.query('workspace:getProject', request, queryOptions(id)),
  })
  const workspaceTasks = createRpcQuerySlot({
    key: workspaceQueryKey,
    query: (request: WorkspaceRequest<'workspace:listTasks'>, id: string) =>
      client.query('workspace:listTasks', request, queryOptions(id)),
  })
  const workspaceTask = createRpcQuerySlot({
    key: workspaceQueryKey,
    query: (request: WorkspaceRequest<'workspace:readTaskDetail'>, id: string) =>
      client.query('workspace:readTaskDetail', request, queryOptions(id)),
  })
  const workspaceConversation = createRpcQuerySlot({
    key: workspaceQueryKey,
    query: (request: WorkspaceRequest<'workspace:readConversationPage'>, id: string) =>
      client.query('workspace:readConversationPage', request, queryOptions(id)),
  })
  const workspaceRequests = createRpcQuerySlot({
    key: workspaceQueryKey,
    query: (request: WorkspaceRequest<'workspace:listPendingRuntimeRequests'>, id: string) =>
      client.query('workspace:listPendingRuntimeRequests', request, queryOptions(id)),
  })
  const workspaceFollowUps = createRpcQuerySlot({
    key: workspaceQueryKey,
    query: (request: WorkspaceRequest<'workspace:listQueuedFollowUps'>, id: string) =>
      client.query('workspace:listQueuedFollowUps', request, queryOptions(id)),
  })
  const workspacePayload = createRpcQuerySlot({
    key: workspaceQueryKey,
    query: (request: WorkspaceRequest<'workspace:readWorkspacePayload'>, id: string) =>
      client.query('workspace:readWorkspacePayload', request, queryOptions(id)),
  })
  const workspaceProjectionAtom = Atom.keepAlive(Atom.make(createWorkspaceProjection()))
  const workspaceStreamStateAtom = Atom.keepAlive(Atom.make<WorkspaceStreamState>({ status: 'inactive', error: null }))
  const workspaceRuntime = client.runtime.factory(get =>
    Layer.merge(get(client.runtime.layer), ApplicationProtocolLayer),
  )
  // Registration, task creation and queue edits lack execution events. Only visible,
  // mounted readers of those mutable records need the bounded fallback.
  const fallbackTargets = [
    workspaceStatus,
    workspaceProjects,
    workspaceProject,
    workspaceTasks,
    workspaceTask,
    workspaceFollowUps,
  ]
  const queryPolling = createWorkspaceQueryPolling(
    (options.runtime ?? client.runtime.factory)(options.layer ?? ApplicationProtocolLayer),
    { targets: fallbackTargets, beforeRefresh: waitForWorkspaceConnection },
  )
  const refreshWorkspace = (registry: AtomRegistry.AtomRegistry, source: 'command' | 'event') => {
    const targets =
      source === 'command'
        ? [...fallbackTargets, workspaceRequests]
        : [workspaceStatus, workspaceTasks, workspaceTask, workspaceRequests, workspaceFollowUps]
    queryPolling.refresh(registry, targets)
    const conversation = registry.get(workspaceConversation.requestAtom)
    if (conversation && conversation.throughSequence === undefined)
      queryPolling.refresh(registry, [workspaceConversation])
  }

  const makeCommand = <Request extends { readonly commandId: string }, Value>(
    send: (rpc: Client, request: Request) => Effect.Effect<Value, CommandError>,
  ) =>
    workspaceRuntime.fn<Omit<Request, 'commandId'>>()(
      (input, get) =>
        Effect.gen(function* () {
          const intent = createWorkspaceIntent(input) as Request
          const rpc = yield* client
          const reconnect = Effect.sleep(100).pipe(Effect.andThen(waitForWorkspaceConnection))
          const result = yield* retryWorkspaceIntent(intent, request => send(rpc, request), reconnect)
          refreshWorkspace(get.registry, 'command')
          return result
        }),
      { concurrent: true },
    )

  const registerProjectAtom = makeCommand((rpc, request: WorkspaceRequest<'workspace:registerProject'>) =>
    rpc('workspace:registerProject', request),
  )
  const createTaskAtom = makeCommand((rpc, request: WorkspaceRequest<'workspace:createTask'>) =>
    rpc('workspace:createTask', request),
  )
  const startRunAtom = makeCommand((rpc, request: WorkspaceRequest<'workspace:startRun'>) =>
    rpc('workspace:startRun', request),
  )
  const interruptAtom = makeCommand((rpc, request: WorkspaceRequest<'workspace:interrupt'>) =>
    rpc('workspace:interrupt', request),
  )
  const respondAtom = makeCommand((rpc, request: WorkspaceRequest<'workspace:respond'>) =>
    rpc('workspace:respond', request),
  )
  const steerAtom = makeCommand((rpc, request: WorkspaceRequest<'workspace:steer'>) => rpc('workspace:steer', request))
  const enqueueFollowUpAtom = makeCommand((rpc, request: WorkspaceRequest<'workspace:enqueueFollowUp'>) =>
    rpc('workspace:enqueueFollowUp', request),
  )
  const cancelQueuedFollowUpAtom = makeCommand((rpc, request: WorkspaceRequest<'workspace:cancelQueuedFollowUp'>) =>
    rpc('workspace:cancelQueuedFollowUp', request),
  )
  const promoteQueuedFollowUpAtom = makeCommand((rpc, request: WorkspaceRequest<'workspace:promoteQueuedFollowUp'>) =>
    rpc('workspace:promoteQueuedFollowUp', request),
  )

  const makeSubscription = Effect.fnUntraced(function* (
    get: Atom.AtomContext,
    events: (afterSequence: number) => Stream.Stream<WorkspaceEventFrame, unknown>,
  ) {
    const registry = get.registry
    let attempt = 0
    while (true) {
      registry.set(workspaceStreamStateAtom, { status: attempt === 0 ? 'connecting' : 'reconnecting', error: null })
      yield* waitForWorkspaceConnection
      const resume = workspaceResume(registry.get(workspaceProjectionAtom), attempt)
      const result = yield* Effect.exit(
        Effect.scoped(
          Stream.runDrain(
            events(resume.afterSequence).pipe(
              Stream.map(frame => {
                const projected = applyWorkspaceFrame(registry.get(workspaceProjectionAtom), frame)
                registry.set(workspaceProjectionAtom, projected.state)
                if (projected.applied.length > 0) refreshWorkspace(registry, 'event')
                registry.set(workspaceStreamStateAtom, { status: 'live', error: null })
                if (projected.applied.length > 0) attempt = 0
                return !projected.resubscribe
              }),
              Stream.takeWhile(continuous => continuous),
            ),
          ),
        ),
      )
      registry.set(workspaceStreamStateAtom, {
        status: 'reconnecting',
        error: result._tag === 'Failure' ? 'Workspace event connection interrupted. Resuming.' : null,
      })
      yield* Effect.sleep(workspaceResume(registry.get(workspaceProjectionAtom), attempt++).delayMs)
    }
  })
  const injectedEvents = options.events
  const workspaceSubscriptionAtom = injectedEvents
    ? (options.runtime ?? client.runtime.factory)(options.layer ?? ApplicationProtocolLayer).atom(get =>
        makeSubscription(get, injectedEvents),
      )
    : workspaceRuntime.atom(get =>
        Effect.gen(function* () {
          const rpc = yield* client
          return yield* makeSubscription(get, afterSequence => rpc('workspace:events', { afterSequence }))
        }),
      )

  return {
    retainWorkspaceQuery: queryPolling.retain,
    workspaceStatus,
    workspaceProjects,
    workspaceProject,
    workspaceTasks,
    workspaceTask,
    workspaceConversation,
    workspaceRequests,
    workspaceFollowUps,
    workspacePayload,
    workspaceProjectionAtom,
    workspaceStreamStateAtom,
    workspaceSubscriptionAtom,
    registerProjectAtom,
    createTaskAtom,
    startRunAtom,
    interruptAtom,
    respondAtom,
    steerAtom,
    enqueueFollowUpAtom,
    cancelQueuedFollowUpAtom,
    promoteQueuedFollowUpAtom,
  }
}

export const {
  retainWorkspaceQuery,
  workspaceStatus,
  workspaceProjects,
  workspaceProject,
  workspaceTasks,
  workspaceTask,
  workspaceConversation,
  workspaceRequests,
  workspaceFollowUps,
  workspacePayload,
  workspaceProjectionAtom,
  workspaceStreamStateAtom,
  workspaceSubscriptionAtom,
  registerProjectAtom,
  createTaskAtom,
  startRunAtom,
  interruptAtom,
  respondAtom,
  steerAtom,
  enqueueFollowUpAtom,
  cancelQueuedFollowUpAtom,
  promoteQueuedFollowUpAtom,
} = createWorkspaceAtoms()
