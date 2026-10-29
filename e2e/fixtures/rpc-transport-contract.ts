import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import { CoachRpcGroup } from '../../src/shared/rpc/coach.js'

export class ProbeFailure extends Schema.TaggedError<ProbeFailure>()('ProbeFailure', {
  code: Schema.Literal('expected'),
  message: Schema.String,
}) {}

export const ProbeRpcGroup = RpcGroup.make(
  Rpc.make('probe:read', { success: Schema.Struct({ writes: Schema.Int }) }),
  Rpc.make('probe:write', { payload: { value: Schema.String }, success: Schema.Struct({ committed: Schema.Boolean }) }),
  Rpc.make('probe:fail', { error: ProbeFailure }),
  Rpc.make('probe:finite-stream', { success: Schema.Int, stream: true }),
  Rpc.make('probe:infinite-stream', { success: Schema.Int, stream: true }),
)

export const ProbeReadOnlyRpcGroup = RpcGroup.make(
  Rpc.make('probe:read', { success: Schema.Struct({ writes: Schema.Int }) }),
  Rpc.make('probe:finite-stream', { success: Schema.Int, stream: true }),
)

export const AppProbeRpcGroup = ProbeRpcGroup.merge(CoachRpcGroup)
