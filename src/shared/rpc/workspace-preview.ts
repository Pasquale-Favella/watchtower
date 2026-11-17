import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import { taskIdSchema } from '@/shared/schemas/workspace.js'
import * as Preview from '@/shared/schemas/workspace-preview.js'

export const workspacePreviewMessages = {
  unavailable: 'Browser preview is unavailable.',
  'not-found': 'Browser tab was not found.',
  'invalid-request': 'Browser request is invalid.',
  'limit-reached': 'Close a browser tab before opening another.',
  failed: 'Browser operation failed.',
  'agent-paused': 'The user paused agent browser interaction. Wait for the user to resume it.',
  'agent-owned': 'This tab belongs to another Agent Session. Open a new tab.',
  'ambiguous-tab': 'Pass a tabId from preview_status, or open a browser tab with preview_open.',
} as const

export class WorkspacePreviewRpcError extends Schema.TaggedError<WorkspacePreviewRpcError>()(
  'WorkspacePreviewRpcError',
  {
    code: Schema.Literals([
      'unavailable',
      'not-found',
      'invalid-request',
      'limit-reached',
      'failed',
      'agent-paused',
      'agent-owned',
      'ambiguous-tab',
    ]),
    message: Schema.Literals(Object.values(workspacePreviewMessages)),
  },
) {}

export const workspacePreviewConfigureSchema = Schema.Struct({
  ...Preview.workspacePreviewRefSchema.fields,
  width: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 }))),
  height: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 }))),
  colorScheme: Schema.optional(Schema.Literals(['light', 'dark', 'system'])),
}).check(
  Schema.makeFilter(
    input => (input.width === undefined) === (input.height === undefined) || 'Supply both viewport dimensions.',
  ),
)
export type WorkspacePreviewConfigure = Schema.Schema.Type<typeof workspacePreviewConfigureSchema>
export const workspacePreviewPickResultSchema = Schema.Struct({
  image: Preview.workspacePreviewCaptureSchema,
  text: Schema.String.check(Schema.isMaxLength(64_000)),
  element: Preview.workspacePreviewPickedElementSchema,
})
export type WorkspacePreviewPickResult = Schema.Schema.Type<typeof workspacePreviewPickResultSchema>

export const WorkspacePreviewRpcGroup = RpcGroup.make(
  Rpc.make('preview:bind', {
    payload: Schema.Struct({ ownerKey: Preview.workspacePreviewRefSchema.fields.ownerKey, taskId: taskIdSchema }),
    success: Schema.Void,
    error: WorkspacePreviewRpcError,
  }),
  Rpc.make('preview:tabs', {
    payload: Schema.Struct({ ownerKey: Preview.workspacePreviewRefSchema.fields.ownerKey }),
    success: Schema.Array(Preview.workspacePreviewStateSchema),
    error: WorkspacePreviewRpcError,
  }),
  Rpc.make('preview:tabEvents', {
    payload: Schema.Struct({ ownerKey: Preview.workspacePreviewRefSchema.fields.ownerKey }),
    success: Schema.Array(Preview.workspacePreviewStateSchema),
    error: WorkspacePreviewRpcError,
    stream: true,
  }),
  Rpc.make('preview:configure', {
    payload: workspacePreviewConfigureSchema,
    success: Schema.Void,
    error: WorkspacePreviewRpcError,
  }),
  Rpc.make('preview:pick', {
    payload: Preview.workspacePreviewRefSchema,
    success: workspacePreviewPickResultSchema,
    error: WorkspacePreviewRpcError,
  }),
  Rpc.make('preview:cancelPick', {
    payload: Preview.workspacePreviewRefSchema,
    success: Schema.Void,
    error: WorkspacePreviewRpcError,
  }),
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
