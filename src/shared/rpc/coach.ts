import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import { coachEventSchema, coachRunRequestSchema } from '@/shared/schemas/agents.js'

const writable = Schema.mutableKey

export const coachRunFrameSchema = Schema.Union([
  Schema.Struct({ _tag: writable(Schema.Literal('Started')), runId: writable(Schema.String) }),
  Schema.Struct({
    _tag: writable(Schema.Literal('Event')),
    runId: writable(Schema.String),
    event: writable(coachEventSchema),
  }),
])
export type CoachRunFrame = Schema.Schema.Type<typeof coachRunFrameSchema>

export class CoachRpcError extends Schema.TaggedError<CoachRpcError>()('CoachRpcError', {
  code: Schema.Literals(['start-failed', 'stream-overflow', 'run-failed', 'unauthorized']),
  message: Schema.Literals([
    'Unable to start the Coach run.',
    'Coach output exceeded the stream limit. Retry your message.',
    'The Coach run stopped unexpectedly.',
    'The Coach run is not owned by this connection.',
  ]),
}) {}

export const CoachRpcGroup = RpcGroup.make(
  Rpc.make('coach:run', {
    payload: coachRunRequestSchema,
    success: coachRunFrameSchema,
    error: CoachRpcError,
    stream: true,
  }),
  Rpc.make('coach:cancel', {
    payload: { runId: Schema.String },
    success: Schema.Void,
    error: CoachRpcError,
  }),
  Rpc.make('coach:reset', { success: Schema.Void, error: CoachRpcError }),
)
