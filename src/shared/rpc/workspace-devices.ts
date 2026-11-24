import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import * as Device from '@/shared/schemas/workspace-devices.js'

export const WorkspaceDeviceRpcGroup = RpcGroup.make(
  Rpc.make('devices:connect', {
    payload: Device.workspaceDeviceConnectSchema,
    success: Schema.Void,
    error: Device.WorkspaceDeviceError,
  }),
  Rpc.make('devices:list', {
    payload: Schema.Struct({}),
    success: Device.workspaceDeviceListSchema,
    error: Device.WorkspaceDeviceError,
  }),
  Rpc.make('devices:boot', {
    payload: Device.workspaceDeviceRefSchema,
    success: Schema.Void,
    error: Device.WorkspaceDeviceError,
  }),
  Rpc.make('devices:shutdown', {
    payload: Device.workspaceDeviceRefSchema,
    success: Schema.Void,
    error: Device.WorkspaceDeviceError,
  }),
  Rpc.make('devices:screenshot', {
    payload: Device.workspaceDeviceRefSchema,
    success: Device.workspaceDeviceScreenshotSchema,
    error: Device.WorkspaceDeviceError,
  }),
  Rpc.make('devices:action', {
    payload: Device.workspaceDeviceActionSchema,
    success: Schema.Void,
    error: Device.WorkspaceDeviceError,
  }),
  Rpc.make('devices:install', {
    payload: Device.workspaceDeviceRefSchema,
    success: Schema.Struct({ installed: Schema.Boolean }),
    error: Device.WorkspaceDeviceError,
  }),
)
