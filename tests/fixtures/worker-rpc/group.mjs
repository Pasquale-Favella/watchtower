import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

export class ProbeFailure extends Schema.TaggedError()('ProbeFailure', { message: Schema.String }) {}

export const Echo = Rpc.make('probe:echo', {
  payload: { value: Schema.String },
  success: Schema.Struct({ value: Schema.String }),
})
export const Fail = Rpc.make('probe:fail', { error: ProbeFailure })
export const Wait = Rpc.make('probe:wait', { success: Schema.String })
export const Stats = Rpc.make('probe:stats', {
  success: Schema.Struct({ initialized: Schema.String, cancelled: Schema.Number }),
})

export const ProbeGroup = RpcGroup.make(Echo, Fail, Wait, Stats)
