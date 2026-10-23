import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import { RpcClient, RpcMessage, RpcSerialization, RpcServer } from 'effect/rpc'
import { RpcClientDefect, RpcClientError } from 'effect/rpc/RpcClientError'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'

/** A transport-neutral endpoint for a single bidirectional RPC connection.
 * `send` transfers one JSON-encoded frame. Closing the remote endpoint calls
 * `subscribeClose` without requiring polling. */
export interface RpcMessagePort {
  readonly send: (frame: string) => Effect.Effect<void, RpcPortError>
  readonly subscribe: (receive: (frame: unknown) => void) => Effect.Effect<() => void>
  readonly subscribeClose: (onClose: () => void) => Effect.Effect<() => void>
  readonly close: () => Effect.Effect<void>
}

export class RpcPortError extends Schema.TaggedError<RpcPortError>()('RpcPortError', {
  code: Schema.Literals(['closed', 'send-failed']),
}) {}

const requestIdSchema = Schema.Union([Schema.String, Schema.Finite])
const requestFrameSchema = Schema.Struct({
  _tag: Schema.Literal('Request'),
  id: requestIdSchema,
  tag: Schema.String,
  payload: Schema.Unknown,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  isNotification: Schema.optional(Schema.Literal(true)),
  traceId: Schema.optional(Schema.String),
  spanId: Schema.optional(Schema.String),
  sampled: Schema.optional(Schema.Boolean),
})
const clientFrameSchema = Schema.Union([
  requestFrameSchema,
  Schema.Struct({ _tag: Schema.Literal('Ack'), requestId: requestIdSchema }),
  Schema.Struct({ _tag: Schema.Literal('Interrupt'), requestId: requestIdSchema }),
  Schema.Struct({ _tag: Schema.Literal('Ping') }),
  Schema.Struct({ _tag: Schema.Literal('Eof') }),
])
const serverFrameSchema = Schema.Union([
  requestFrameSchema,
  Schema.Struct({
    _tag: Schema.Literal('Chunk'),
    requestId: requestIdSchema,
    values: Schema.NonEmptyArray(Schema.Unknown),
  }),
  Schema.Struct({
    _tag: Schema.Literal('Exit'),
    requestId: requestIdSchema,
    exit: Schema.Union([
      Schema.Struct({ _tag: Schema.Literal('Success'), value: Schema.Unknown }),
      Schema.Struct({
        _tag: Schema.Literal('Failure'),
        cause: Schema.Array(
          Schema.Union([
            Schema.Struct({ _tag: Schema.Literal('Fail'), error: Schema.Unknown }),
            Schema.Struct({ _tag: Schema.Literal('Die'), defect: Schema.Unknown }),
            Schema.Struct({
              _tag: Schema.Literal('Interrupt'),
              fiberId: Schema.optional(Schema.NullOr(Schema.Finite)),
            }),
          ]),
        ),
      }),
    ]),
  }),
  Schema.Struct({ _tag: Schema.Literal('Defect'), defect: Schema.Unknown }),
  Schema.Struct({ _tag: Schema.Literal('Pong') }),
])

const MAX_FRAME_CHARS = 16 * 1024 * 1024
const INBOX_CAPACITY = 64
const json = RpcSerialization.json

type ClientFrame = Schema.Schema.Type<typeof clientFrameSchema>
type ServerFrame = Schema.Schema.Type<typeof serverFrameSchema>

const protocolError = (code: 'closed' | 'send-failed' | 'invalid-frame' = 'closed'): RpcClientError =>
  new RpcClientError({
    reason: new RpcClientDefect({
      message:
        code === 'closed'
          ? 'RPC port disconnected'
          : code === 'invalid-frame'
            ? 'Invalid RPC frame received'
            : 'RPC port send failed',
      cause: code,
    }),
  })

const encodeFrame = (frame: unknown): string => {
  const encoded = json.makeUnsafe().encode(frame)
  if (typeof encoded !== 'string' || encoded.length > MAX_FRAME_CHARS) {
    throw new Error('RPC frame exceeds the size limit')
  }
  return encoded
}

const decodeFrame = <S extends Schema.ConstraintDecoder<unknown>>(raw: unknown, schema: S): Schema.Schema.Type<S> => {
  if (typeof raw !== 'string' || raw.length > MAX_FRAME_CHARS) {
    throw new Error('Invalid RPC frame')
  }
  const frames = json.makeUnsafe().decode(raw)
  if (frames.length !== 1) throw new Error('Invalid RPC frame count')
  return Schema.decodeUnknownSync(schema)(frames[0]) as Schema.Schema.Type<S>
}

const closeQuietly = (port: RpcMessagePort): Effect.Effect<void> =>
  Effect.ignoreCause(port.close().pipe(Effect.catchDefect(() => Effect.void)))

const sanitizeServerResponse = (response: RpcMessage.FromServerEncoded): RpcMessage.FromServerEncoded => {
  if (response._tag === 'Defect') return { ...response, defect: 'RPC server failure' }
  if (response._tag !== 'Exit' || response.exit._tag !== 'Failure') return response
  return {
    ...response,
    exit: {
      ...response.exit,
      cause: response.exit.cause.map(entry =>
        entry._tag === 'Die' ? { ...entry, defect: 'RPC operation failed' } : entry,
      ),
    },
  }
}

/** Creates the client-side Effect RPC protocol for one injected port. */
export const clientProtocolLayer = (port: RpcMessagePort): Layer.Layer<RpcClient.Protocol> => {
  const protocol: Effect.Effect<RpcClient.Protocol['Service'], never, Scope.Scope> = RpcClient.Protocol.make(
    (writeResponse, clientIds) =>
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        const inbox = yield* Queue.bounded<unknown, RpcPortError>(INBOX_CAPACITY)
        const requestClients = new Map<string | number, number>()
        let failure: RpcClientError | undefined
        const reportFailure = (error: RpcClientError) => {
          failure = error
          requestClients.clear()
          return Effect.forEach(
            clientIds,
            clientId => writeResponse(clientId, { _tag: 'ClientProtocolError', error }),
            { discard: true },
          )
        }
        const onFrame = (raw: unknown) => {
          if (!Queue.offerUnsafe(inbox, raw)) {
            Queue.failCauseUnsafe(inbox, Cause.fail(new RpcPortError({ code: 'send-failed' })))
          }
        }
        const onClose = () => {
          Queue.failCauseUnsafe(inbox, Cause.fail(new RpcPortError({ code: 'closed' })))
        }
        const unsubscribe = yield* port.subscribe(onFrame)
        const unsubscribeClose = yield* port.subscribeClose(onClose)
        yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe))
        yield* Scope.addFinalizer(scope, Effect.sync(unsubscribeClose))
        yield* Scope.addFinalizer(scope, closeQuietly(port))
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            while (true) {
              const raw = yield* Queue.take(inbox).pipe(
                Effect.catchCause(() =>
                  Effect.andThen(
                    reportFailure(protocolError('closed')),
                    Effect.andThen(closeQuietly(port), Effect.fail(protocolError('closed'))),
                  ),
                ),
              )
              let frame: ServerFrame
              try {
                frame = decodeFrame(raw, serverFrameSchema)
              } catch {
                yield* reportFailure(protocolError('invalid-frame'))
                yield* closeQuietly(port)
                return
              }
              if (frame._tag === 'Pong') continue
              const requestId = 'requestId' in frame ? frame.requestId : undefined
              const clientId = requestId === undefined ? undefined : requestClients.get(requestId)
              if (clientId !== undefined) {
                if (frame._tag === 'Exit') requestClients.delete(frame.requestId)
                yield* writeResponse(clientId, frame as RpcMessage.FromServerEncoded)
                continue
              }
              yield* Effect.forEach(clientIds, id => writeResponse(id, frame as RpcMessage.FromServerEncoded), {
                discard: true,
              })
            }
          }).pipe(Effect.catchCause(() => Effect.void)),
        )
        return {
          send(clientId, request) {
            if (failure) return Effect.fail(failure)
            let frame: string
            try {
              frame = encodeFrame(request)
            } catch {
              return Effect.fail(protocolError('send-failed'))
            }
            if (request._tag === 'Request') requestClients.set(request.id, clientId)
            return port.send(frame).pipe(
              Effect.catchCause(() => {
                if (request._tag === 'Request') requestClients.delete(request.id)
                const error = protocolError('send-failed')
                return Effect.andThen(reportFailure(error), Effect.andThen(closeQuietly(port), Effect.fail(error)))
              }),
            )
          },
          supportsAck: true,
          supportsTransferables: false,
          codecFor: json.codecFor,
        }
      }),
  )
  return Layer.effect(RpcClient.Protocol, protocol)
}

/** Creates the server-side Effect RPC protocol for one injected port. */
export const serverProtocolLayer = (port: RpcMessagePort): Layer.Layer<RpcServer.Protocol> => {
  const protocol: Effect.Effect<RpcServer.Protocol['Service'], never, Scope.Scope> = RpcServer.Protocol.make(
    writeRequest =>
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        const inbox = yield* Queue.bounded<unknown, RpcPortError>(INBOX_CAPACITY)
        const disconnects = yield* Queue.unbounded<number>()
        const clientIds = new Set<number>([0])
        let closed = false
        const disconnect = () => {
          if (closed) return
          closed = true
          clientIds.delete(0)
          Queue.failCauseUnsafe(inbox, Cause.fail(new RpcPortError({ code: 'closed' })))
          Queue.offerUnsafe(disconnects, 0)
        }
        const closeConnection = Effect.andThen(Effect.sync(disconnect), closeQuietly(port))
        const onFrame = (frame: unknown) => {
          if (!Queue.offerUnsafe(inbox, frame)) {
            Queue.failCauseUnsafe(inbox, Cause.fail(new RpcPortError({ code: 'send-failed' })))
          }
        }
        const onClose = disconnect
        const unsubscribe = yield* port.subscribe(onFrame)
        const unsubscribeClose = yield* port.subscribeClose(onClose)
        yield* Scope.addFinalizer(scope, Effect.sync(unsubscribe))
        yield* Scope.addFinalizer(scope, Effect.sync(unsubscribeClose))
        yield* Scope.addFinalizer(scope, closeConnection)
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            while (true) {
              const raw = yield* Queue.take(inbox).pipe(Effect.catchCause(() => closeConnection))
              let frame: ClientFrame
              try {
                frame = decodeFrame(raw, clientFrameSchema)
              } catch {
                yield* closeConnection
                return
              }
              yield* writeRequest(0, frame as RpcMessage.FromClientEncoded)
            }
          }).pipe(Effect.catchCause(() => closeConnection)),
        )

        return {
          disconnects,
          send(_clientId, response) {
            if (closed) return Effect.void
            let frame: string
            try {
              frame = encodeFrame(sanitizeServerResponse(response))
            } catch {
              return closeConnection
            }
            return port.send(frame).pipe(Effect.catchCause(() => closeConnection))
          },
          end() {
            return closeConnection
          },
          clientIds: Effect.sync(() => clientIds),
          initialMessage: Effect.succeedNone,
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: true,
          supportsNotifications: false,
          codecFor: json.codecFor,
        }
      }),
  )
  return Layer.effect(RpcServer.Protocol, protocol)
}
