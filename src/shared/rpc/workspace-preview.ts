import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import * as Preview from '@/shared/schemas/workspace-preview.js'

export const workspacePreviewMessages = {
  unavailable: 'Browser preview is unavailable.',
  'not-found': 'Browser tab was not found.',
  'invalid-request': 'Browser request is invalid.',
  'limit-reached': 'Close a browser tab before opening another.',
  failed: 'Browser operation failed.',
} as const

export class WorkspacePreviewRpcError extends Schema.TaggedError<WorkspacePreviewRpcError>()(
  'WorkspacePreviewRpcError',
  {
    code: Schema.Literals(['unavailable', 'not-found', 'invalid-request', 'limit-reached', 'failed']),
    message: Schema.Literals(Object.values(workspacePreviewMessages)),
  },
) {}

export const WorkspacePreviewRpcGroup = RpcGroup.make(
  Rpc.make('preview:capture', {
    payload: Preview.workspacePreviewRefSchema,
    success: Preview.workspacePreviewCaptureSchema,
    error: WorkspacePreviewRpcError,
  }),
  Rpc.make('preview:focusApp', {
    payload: Preview.workspacePreviewRefSchema,
    success: Schema.Void,
    error: WorkspacePreviewRpcError,
  }),
  Rpc.make('preview:open', {
    payload: Preview.workspacePreviewOpenSchema,
    success: Preview.workspacePreviewStateSchema,
    error: WorkspacePreviewRpcError,
  }),
  Rpc.make('preview:navigate', {
    payload: Preview.workspacePreviewNavigateSchema,
    success: Preview.workspacePreviewStateSchema,
    error: WorkspacePreviewRpcError,
  }),
  Rpc.make('preview:command', {
    payload: Preview.workspacePreviewCommandSchema,
    success: Preview.workspacePreviewStateSchema,
    error: WorkspacePreviewRpcError,
  }),
  Rpc.make('preview:layout', {
    payload: Preview.workspacePreviewLayoutSchema,
    success: Schema.Void,
    error: WorkspacePreviewRpcError,
  }),
  Rpc.make('preview:close', {
    payload: Preview.workspacePreviewRefSchema,
    success: Schema.Void,
    error: WorkspacePreviewRpcError,
  }),
  Rpc.make('preview:adopt', {
    payload: Preview.workspacePreviewAdoptSchema,
    success: Schema.Void,
    error: WorkspacePreviewRpcError,
  }),
  Rpc.make('preview:events', {
    payload: Preview.workspacePreviewRefSchema,
    success: Preview.workspacePreviewStateSchema,
    error: WorkspacePreviewRpcError,
    stream: true,
  }),
)
