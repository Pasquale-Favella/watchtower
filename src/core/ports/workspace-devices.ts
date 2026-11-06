import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'

import type {
  WorkspaceDeviceAction,
  WorkspaceDeviceError,
  WorkspaceDeviceList,
  WorkspaceDeviceRef,
  WorkspaceDeviceScreenshot,
} from '@/shared/schemas/workspace-devices.js'

export class WorkspaceDevices extends Context.Service<
  WorkspaceDevices,
  {
    readonly list: Effect.Effect<WorkspaceDeviceList, WorkspaceDeviceError>
    readonly connect: (address: string) => Effect.Effect<void, WorkspaceDeviceError>
    readonly boot: (device: WorkspaceDeviceRef) => Effect.Effect<void, WorkspaceDeviceError>
    readonly shutdown: (device: WorkspaceDeviceRef) => Effect.Effect<void, WorkspaceDeviceError>
    readonly screenshot: (device: WorkspaceDeviceRef) => Effect.Effect<WorkspaceDeviceScreenshot, WorkspaceDeviceError>
    readonly action: (action: WorkspaceDeviceAction) => Effect.Effect<void, WorkspaceDeviceError>
    readonly install: (device: WorkspaceDeviceRef, path: string) => Effect.Effect<void, WorkspaceDeviceError>
  }
>()('watchtower/core/WorkspaceDevices') {}
