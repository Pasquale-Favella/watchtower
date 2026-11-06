import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { ApplicationClient, ApplicationProtocolLayer } from '@/renderer/shared/lib/application-rpc.js'
import {
  type WorkspaceDeviceAction,
  WorkspaceDeviceError,
  type WorkspaceDeviceRef,
  type WorkspaceDeviceScreenshot,
} from '@/shared/schemas/workspace-devices.js'

const runtime = ApplicationClient.runtime.factory(get =>
  Layer.merge(get(ApplicationClient.runtime.layer), ApplicationProtocolLayer),
)
export const connectWorkspaceDeviceAtom = () =>
  runtime.fn<{ readonly address: string }>()(
    request => Effect.flatMap(ApplicationClient, client => client('devices:connect', request)),
    { concurrent: true },
  )
export const listWorkspaceDevicesAtom = () =>
  runtime.fn<undefined>()(() => Effect.flatMap(ApplicationClient, client => client('devices:list', {})), {
    concurrent: true,
  })
export const bootWorkspaceDeviceAtom = () =>
  runtime.fn<WorkspaceDeviceRef>()(
    request => Effect.flatMap(ApplicationClient, client => client('devices:boot', request)),
    { concurrent: true },
  )
export const shutdownWorkspaceDeviceAtom = () =>
  runtime.fn<WorkspaceDeviceRef>()(
    request => Effect.flatMap(ApplicationClient, client => client('devices:shutdown', request)),
    { concurrent: true },
  )
export const actionWorkspaceDeviceAtom = () =>
  runtime.fn<WorkspaceDeviceAction>()(
    request => Effect.flatMap(ApplicationClient, client => client('devices:action', request)),
    { concurrent: true },
  )
export const installWorkspaceDeviceAtom = () =>
  runtime.fn<WorkspaceDeviceRef>()(
    request => Effect.flatMap(ApplicationClient, client => client('devices:install', request)),
    { concurrent: true },
  )
export const screenshotWorkspaceDeviceAtom = () =>
  runtime.fn<WorkspaceDeviceRef>()(
    request => Effect.flatMap(ApplicationClient, client => client('devices:screenshot', request)),
    { concurrent: true },
  )

type FrameEvent = { readonly frame: WorkspaceDeviceScreenshot | null; readonly error: string | null }
type FrameListener = (event: FrameEvent) => void
const listeners = new Map<string, Set<FrameListener>>()
const sessions = new Map<string, ReturnType<typeof makeFrameAtom>>()
function key(ref: WorkspaceDeviceRef): string {
  return JSON.stringify([ref.platform, ref.id])
}
export function workspaceDeviceErrorMessage(error: unknown): string {
  return Schema.is(WorkspaceDeviceError)(error) ? error.message : 'Device connection unavailable. Try again.'
}

function makeFrameAtom(ref: WorkspaceDeviceRef) {
  const identity = key(ref)
  return runtime.atom(() =>
    Effect.gen(function* () {
      const client = yield* ApplicationClient
      while (true) {
        const result = yield* Effect.exit(client('devices:screenshot', ref))
        if (Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause)) return
        const event = Exit.isSuccess(result)
          ? { frame: result.value, error: null }
          : {
              frame: null,
              error: workspaceDeviceErrorMessage(Option.getOrUndefined(Cause.findErrorOption(result.cause))),
            }
        for (const listener of [...(listeners.get(identity) ?? [])]) listener(event)
        yield* Effect.sleep(Exit.isSuccess(result) ? 500 : 1500)
      }
    }),
  )
}

export function workspaceDeviceFrameAtom(ref: WorkspaceDeviceRef) {
  const identity = key(ref)
  let atom = sessions.get(identity)
  if (!atom) {
    atom = makeFrameAtom(ref)
    sessions.set(identity, atom)
  }
  return atom
}

export function subscribeWorkspaceDeviceFrames(ref: WorkspaceDeviceRef, listener: FrameListener): () => void {
  const identity = key(ref)
  const group = listeners.get(identity) ?? new Set<FrameListener>()
  group.add(listener)
  listeners.set(identity, group)
  return () => {
    group.delete(listener)
    if (group.size === 0) listeners.delete(identity)
  }
}
