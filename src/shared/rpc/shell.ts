import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import { rendererNoticeSchema } from '../schemas/ipc.js'
import { sectionSchema } from '../schemas/navigation.js'
import { orbPanelRequestSchema, orbPlacementSchema } from '../schemas/orb.js'

export const orbCommandSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal('Panel'), request: orbPanelRequestSchema }),
  Schema.Struct({ _tag: Schema.Literal('DragStart') }),
  Schema.Struct({ _tag: Schema.Literal('DragMove'), dx: Schema.Finite, dy: Schema.Finite }),
  Schema.Struct({ _tag: Schema.Literal('DragEnd') }),
  Schema.Struct({ _tag: Schema.Literal('OpenApp'), section: Schema.optional(sectionSchema) }),
  Schema.Struct({ _tag: Schema.Literal('Hide') }),
  Schema.Struct({ _tag: Schema.Literal('Quit') }),
  Schema.Struct({ _tag: Schema.Literal('PanelPainted') }),
  Schema.Struct({ _tag: Schema.Literal('PanelDataReady') }),
])
export type OrbCommand = Schema.Schema.Type<typeof orbCommandSchema>

export const shellEventSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal('Ready'), placement: Schema.NullOr(orbPlacementSchema) }),
  Schema.Struct({ _tag: Schema.Literal('Placement'), placement: orbPlacementSchema }),
  Schema.Struct({ _tag: Schema.Literal('Navigate'), section: sectionSchema }),
])
export type ShellEvent = Schema.Schema.Type<typeof shellEventSchema>

export class ShellRpcError extends Schema.TaggedError<ShellRpcError>()('ShellRpcError', {
  code: Schema.Literals(['unavailable', 'unauthorized', 'lagged']),
  message: Schema.Literals(['Shell unavailable', 'Shell capability denied', 'Shell subscriber fell behind']),
}) {}

export const ShellRpcGroup = RpcGroup.make(
  Rpc.make('shell:events', { success: shellEventSchema, error: ShellRpcError, stream: true }),
  Rpc.make('shell:notice', { payload: rendererNoticeSchema, success: Schema.Void, error: ShellRpcError }),
  Rpc.make('shell:open-external', { payload: { url: Schema.String }, success: Schema.Void, error: ShellRpcError }),
  Rpc.make('shell:open-settings', { success: Schema.Boolean, error: ShellRpcError }),
)

export const OrbRpcGroup = RpcGroup.make(
  Rpc.make('orb:placement', { success: Schema.NullOr(orbPlacementSchema), error: ShellRpcError }),
  Rpc.make('orb:command', {
    payload: orbCommandSchema,
    success: Schema.NullOr(orbPlacementSchema),
    error: ShellRpcError,
  }),
)

export const OrbShellRpcGroup = ShellRpcGroup.omit('shell:open-external', 'shell:open-settings').merge(OrbRpcGroup)
