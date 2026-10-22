import * as Schema from 'effect/Schema'

/** Safe failures from the fixed preload RPC capability. */
export class RpcBridgeError extends Schema.TaggedError<RpcBridgeError>()('RpcBridgeError', {
  code: Schema.Literals(['unavailable', 'closed', 'send-failed', 'protocol'] as const),
}) {}

export const RpcConnectionRequestSchema = Schema.Struct({
  version: Schema.Int,
  requestId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type RpcConnectionRequest = Schema.Schema.Type<typeof RpcConnectionRequestSchema>

export const RpcConnectionResponseSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('Ready'),
    version: Schema.Literal(1),
    requestId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  Schema.Struct({
    _tag: Schema.Literal('Rejected'),
    version: Schema.Literal(1),
    requestId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    code: Schema.Literals(['unavailable', 'protocol'] as const),
  }),
])

export type RpcConnectionResult =
  | { readonly _tag: 'Connected'; readonly generation: number }
  | { readonly _tag: 'Failed'; readonly code: 'unavailable' | 'closed' | 'protocol' }

/** The only RPC capability exposed to the isolated renderer world. */
export interface RpcBridge {
  readonly connect: () => Promise<RpcConnectionResult>
  readonly send: (frame: string) => Promise<void>
  readonly onMessage: (listener: (frame: unknown) => void) => () => void
  readonly onClose: (listener: () => void) => () => void
  readonly disconnect: () => void
}
