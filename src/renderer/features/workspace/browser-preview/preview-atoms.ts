import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import { ApplicationClient, ApplicationProtocolLayer } from '@/renderer/shared/lib/application-rpc.js'
import type { WorkspacePreviewConfigure } from '@/shared/rpc/workspace-preview.js'
import { WorkspacePreviewRpcError } from '@/shared/rpc/workspace-preview.js'
import type { TaskId } from '@/shared/schemas/workspace.js'
import type {
  WorkspacePreviewAdopt,
  WorkspacePreviewCommand,
  WorkspacePreviewLayout,
  WorkspacePreviewNavigate,
  WorkspacePreviewOpen,
  WorkspacePreviewRef,
  WorkspacePreviewState,
} from '@/shared/schemas/workspace-preview.js'

const runtime = ApplicationClient.runtime.factory(get =>
  Layer.merge(get(ApplicationClient.runtime.layer), ApplicationProtocolLayer),
)

export const captureWorkspacePreviewAtom = () =>
  runtime.fn<WorkspacePreviewRef>()(
    request => Effect.flatMap(ApplicationClient, client => client('preview:capture', request)),
    { concurrent: true },
  )

export const focusWorkspacePreviewAppAtom = () =>
  runtime.fn<WorkspacePreviewRef>()(
    request => Effect.flatMap(ApplicationClient, client => client('preview:focusApp', request)),
    { concurrent: true },
  )

export const navigateWorkspacePreviewAtom = () =>
  runtime.fn<WorkspacePreviewNavigate>()(
    request => Effect.flatMap(ApplicationClient, client => client('preview:navigate', request)),
    { concurrent: true },
  )
export const commandWorkspacePreviewAtom = () =>
  runtime.fn<WorkspacePreviewCommand>()(
    request => Effect.flatMap(ApplicationClient, client => client('preview:command', request)),
    { concurrent: true },
  )
export const layoutWorkspacePreviewAtom = () =>
  runtime.fn<WorkspacePreviewLayout>()(
    request => Effect.flatMap(ApplicationClient, client => client('preview:layout', request)),
    { concurrent: true },
  )
export const closeWorkspacePreviewAtom = () =>
  runtime.fn<WorkspacePreviewRef>()(
    request => Effect.flatMap(ApplicationClient, client => client('preview:close', request)),
    { concurrent: true },
  )
export const adoptWorkspacePreviewAtom = () =>
  runtime.fn<WorkspacePreviewAdopt>()(
    request => Effect.flatMap(ApplicationClient, client => client('preview:adopt', request)),
    { concurrent: true },
  )

export const configureWorkspacePreviewAtom = () =>
  runtime.fn<WorkspacePreviewConfigure>()(
    request => Effect.flatMap(ApplicationClient, client => client('preview:configure', request)),
    { concurrent: true },
  )

export const pickWorkspacePreviewAtom = () =>
  runtime.fn<WorkspacePreviewRef>()(
    request => Effect.flatMap(ApplicationClient, client => client('preview:pick', request)),
    { concurrent: true },
  )

export const cancelWorkspacePreviewPickAtom = () =>
  runtime.fn<WorkspacePreviewRef>()(
    request => Effect.flatMap(ApplicationClient, client => client('preview:cancelPick', request)),
    { concurrent: true },
  )

export const bindWorkspacePreviewAtom = () =>
  runtime.fn<{ readonly ownerKey: string; readonly taskId: TaskId }>()(
    request => Effect.flatMap(ApplicationClient, client => client('preview:bind', request)),
    { concurrent: true },
  )

export type WorkspacePreviewTabsEvent = ReadonlyArray<WorkspacePreviewState>
type TabsListener = (states: WorkspacePreviewTabsEvent) => void
const tabsListeners = new Map<string, Set<TabsListener>>()
const tabsSessions = new Map<string, ReturnType<typeof makeTabsSession>>()

function publishTabs(ownerKey: string, states: WorkspacePreviewTabsEvent): void {
  for (const listener of [...(tabsListeners.get(ownerKey) ?? [])]) listener(states)
}

export function subscribeWorkspacePreviewTabs(ownerKey: string, listener: TabsListener): () => void {
  const group = tabsListeners.get(ownerKey) ?? new Set<TabsListener>()
  group.add(listener)
  tabsListeners.set(ownerKey, group)
  return () => {
    group.delete(listener)
    if (group.size === 0) tabsListeners.delete(ownerKey)
  }
}

function makeTabsSession(ownerKey: string) {
  return runtime.atom(() =>
    Effect.gen(function* () {
      const client = yield* ApplicationClient
      let attempt = 0
      while (true) {
        const outcome = yield* Effect.exit(
          Effect.gen(function* () {
            publishTabs(ownerKey, yield* client('preview:tabs', { ownerKey }))
            yield* Stream.runForEach(client('preview:tabEvents', { ownerKey }), states =>
              Effect.sync(() => {
                attempt = 0
                publishTabs(ownerKey, states)
              }),
            )
          }),
        )
        if (Exit.isFailure(outcome)) {
          if (Cause.hasInterruptsOnly(outcome.cause)) return
          const error = Option.getOrUndefined(Cause.findErrorOption(outcome.cause))
          if (Schema.is(WorkspacePreviewRpcError)(error) && error.code === 'invalid-request') return
        }
        yield* Effect.sleep(Math.min(5000, 250 * 2 ** attempt++))
      }
    }),
  )
}

export function workspacePreviewTabsSessionAtom(ownerKey: string) {
  let session = tabsSessions.get(ownerKey)
  if (!session) {
    session = makeTabsSession(ownerKey)
    tabsSessions.set(ownerKey, session)
  }
  return session
}

export type WorkspacePreviewEvent = WorkspacePreviewState | { readonly _tag: 'failed'; readonly message: string }
type Listener = (state: WorkspacePreviewEvent) => void
const listeners = new Map<string, Set<Listener>>()
const sessions = new Map<string, ReturnType<typeof makeSession>>()

function key(ref: WorkspacePreviewRef): string {
  return JSON.stringify([ref.ownerKey, ref.tabId])
}

function publish(ref: WorkspacePreviewRef, event: WorkspacePreviewEvent): void {
  for (const listener of [...(listeners.get(key(ref)) ?? [])]) listener(event)
}

export function describeWorkspacePreviewError(error: unknown): string {
  return Schema.is(WorkspacePreviewRpcError)(error) ? error.message : 'Browser connection interrupted. Reconnecting.'
}

export function subscribeWorkspacePreview(ref: WorkspacePreviewRef, listener: Listener): () => void {
  const identity = key(ref)
  const group = listeners.get(identity) ?? new Set<Listener>()
  group.add(listener)
  listeners.set(identity, group)
  return () => {
    group.delete(listener)
    if (group.size === 0) listeners.delete(identity)
  }
}

function makeSession(ref: WorkspacePreviewOpen) {
  return runtime.atom(() =>
    Effect.gen(function* () {
      const client = yield* ApplicationClient
      let attempt = 0
      while (true) {
        const outcome = yield* Effect.exit(
          Effect.gen(function* () {
            const opened = yield* client('preview:open', ref)
            publish(ref, opened)
            yield* Stream.runForEach(client('preview:events', { ownerKey: ref.ownerKey, tabId: ref.tabId }), state =>
              Effect.sync(() => {
                attempt = 0
                publish(ref, state)
              }),
            )
          }),
        )
        if (Exit.isFailure(outcome)) {
          if (Cause.hasInterruptsOnly(outcome.cause)) return
          const error = Option.getOrUndefined(Cause.findErrorOption(outcome.cause))
          publish(ref, { _tag: 'failed', message: describeWorkspacePreviewError(error) })
          if (
            Schema.is(WorkspacePreviewRpcError)(error) &&
            (error.code === 'limit-reached' || error.code === 'invalid-request')
          )
            return
        }
        yield* Effect.sleep(Math.min(5000, 250 * 2 ** attempt++))
      }
    }),
  )
}

export function workspacePreviewSessionAtom(ref: WorkspacePreviewOpen) {
  const identity = key(ref)
  let session = sessions.get(identity)
  if (!session) {
    session = makeSession(ref)
    sessions.set(identity, session)
  }
  return session
}
