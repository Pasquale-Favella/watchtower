import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import { platformSpawnCommand, which } from '@/infrastructure/process/executable.js'

const MAX_LINE_BYTES = 1024 * 1024
const MAX_PENDING_REQUESTS = 128
const MAX_INCOMING_MESSAGES = 256

export class JsonRpcFailure extends Schema.TaggedError<JsonRpcFailure>()('JsonRpcFailure', {
  reason: Schema.Literals([
    'closed',
    'frame-too-large',
    'invalid-frame',
    'write-failed',
    'request-failed',
    'too-many-pending',
  ]),
}) {}

export type JsonRpcId = number | string
export type JsonRpcMessage =
  | { readonly id: JsonRpcId; readonly method: string; readonly params?: unknown }
  | { readonly method: string; readonly params?: unknown }
  | { readonly id: JsonRpcId; readonly result: unknown }
  | {
      readonly id: JsonRpcId
      readonly error: { readonly code: number; readonly message: string; readonly data?: unknown }
    }

const JsonRpcEnvelope = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.Number,
      message: Schema.String,
      data: Schema.optional(Schema.Unknown),
    }),
  ),
})

export type JsonRpcEvent =
  | { readonly _tag: 'Notification'; readonly sequence: number; readonly method: string; readonly params: unknown }
  | {
      readonly _tag: 'Request'
      readonly sequence: number
      readonly id: JsonRpcId
      readonly method: string
      readonly params: unknown
    }

export interface JsonRpcTransport {
  readonly input: Stream.Stream<Uint8Array, unknown>
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, unknown>
  readonly close: (deadlineMs?: number) => Effect.Effect<void>
}

/** Spawn a long-lived stdio peer using Effect's managed process handle. stderr is drained and discarded. */
export const spawnJsonRpcStdio = Effect.fn('spawnJsonRpcStdio')(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: Record<string, string>; readonly extendEnv?: boolean } = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const spawn = platformSpawnCommand(which(command) ?? command, [...args], process.platform)
  const input = yield* Queue.bounded<Uint8Array>(32)
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(spawn.command, [...spawn.args], {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.extendEnv !== undefined ? { extendEnv: options.extendEnv } : {}),
        stdin: { stream: Stream.fromQueue(input), endOnDone: true },
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
        forceKillAfter: '1 second',
      }),
    )
    .pipe(Effect.mapError(() => new JsonRpcFailure({ reason: 'closed' })))
  yield* Effect.forkScoped(Stream.runDrain(handle.stderr).pipe(Effect.ignore))
  return {
    input: handle.stdout,
    write: (bytes: Uint8Array) =>
      Queue.offer(input, bytes).pipe(
        Effect.asVoid,
        Effect.mapError(() => new JsonRpcFailure({ reason: 'write-failed' })),
      ),
    close: (deadlineMs = 1000) =>
      Effect.gen(function* () {
        yield* Queue.shutdown(input)
        yield* handle.kill().pipe(Effect.ignore)
        yield* handle.exitCode.pipe(Effect.timeoutOption(`${deadlineMs} millis`), Effect.ignore)
      }),
  } satisfies JsonRpcTransport
})

interface Pending {
  readonly reply: Deferred.Deferred<unknown, JsonRpcFailure>
  readonly drainIncoming: boolean
  incomingSequence?: number
}

const encode = (message: object): Uint8Array => new TextEncoder().encode(`${JSON.stringify(message)}\n`)

function decodeFrame(line: string): JsonRpcMessage | undefined {
  const value = Schema.decodeUnknownSync(JsonRpcEnvelope)(JSON.parse(line))
  if (value.method !== undefined) {
    return value.id !== undefined
      ? { id: value.id, method: value.method, params: value.params }
      : { method: value.method, params: value.params }
  }
  if (value.id !== undefined && value.result !== undefined) return { id: value.id, result: value.result }
  if (value.id !== undefined && value.error !== undefined) return { id: value.id, error: value.error }
  return undefined
}

/** A bounded, scoped JSON-RPC 2.0 client for transports such as Codex's JSONL stdio protocol. */
export class JsonRpcClient {
  private readonly pending = new Map<JsonRpcId, Pending>()
  private nextId = 1
  private nextIncomingSequence = 1
  private acknowledgedIncomingSequence = 0
  private readonly incomingAcks = new Map<number, Deferred.Deferred<undefined, JsonRpcFailure>>()
  private readonly incomingBarriers = new Map<number, Deferred.Deferred<undefined, JsonRpcFailure>>()
  private closed = false
  private shutdownStarted = false

  private constructor(
    private readonly transport: JsonRpcTransport,
    private readonly events: Queue.Queue<JsonRpcEvent, JsonRpcFailure>,
  ) {}

  static make(transport: JsonRpcTransport): Effect.Effect<JsonRpcClient, never, import('effect/Scope').Scope> {
    return Effect.gen(function* () {
      const events = yield* Queue.bounded<JsonRpcEvent, JsonRpcFailure>(MAX_INCOMING_MESSAGES)
      const client = new JsonRpcClient(transport, events)
      yield* Effect.addFinalizer(() => client.shutdown())
      yield* Effect.forkScoped(client.readLoop())
      return client
    })
  }

  /** Consumers must call acknowledge(event) after handling each event; requestAfterIncoming waits for that work. */
  get incoming(): Stream.Stream<JsonRpcEvent, JsonRpcFailure> {
    return Stream.fromQueue(this.events)
  }

  request(method: string, params: unknown = {}): Effect.Effect<unknown, JsonRpcFailure> {
    return this.requestInternal(method, params, false)
  }

  requestAfterIncoming(method: string, params: unknown = {}): Effect.Effect<unknown, JsonRpcFailure> {
    return this.requestInternal(method, params, true)
  }

  private requestInternal(
    method: string,
    params: unknown,
    drainIncoming: boolean,
  ): Effect.Effect<unknown, JsonRpcFailure> {
    return Effect.gen({ self: this }, function* () {
      if (this.closed) return yield* new JsonRpcFailure({ reason: 'closed' })
      if (this.pending.size >= MAX_PENDING_REQUESTS) return yield* new JsonRpcFailure({ reason: 'too-many-pending' })
      const id = this.nextId++
      const reply = yield* Deferred.make<unknown, JsonRpcFailure>()
      const pending: Pending = { reply, drainIncoming }
      this.pending.set(id, pending)
      const result = yield* this.send({ id, method, params }).pipe(
        Effect.flatMap(() => Deferred.await(reply)),
        Effect.ensuring(Effect.sync(() => this.pending.delete(id))),
      )
      if (drainIncoming && pending.incomingSequence !== undefined)
        yield* this.awaitIncomingThrough(pending.incomingSequence)
      return result
    })
  }

  acknowledge(event: JsonRpcEvent): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const ack = this.incomingAcks.get(event.sequence)
      if (!ack) return
      this.incomingAcks.delete(event.sequence)
      yield* Deferred.succeed(ack, undefined)
      while (
        this.acknowledgedIncomingSequence + 1 < this.nextIncomingSequence &&
        !this.incomingAcks.has(this.acknowledgedIncomingSequence + 1)
      )
        this.acknowledgedIncomingSequence += 1
      for (const [sequence, barrier] of this.incomingBarriers) {
        if (sequence <= this.acknowledgedIncomingSequence) {
          this.incomingBarriers.delete(sequence)
          yield* Deferred.succeed(barrier, undefined)
        }
      }
    })
  }

  private awaitIncomingThrough(sequence: number): Effect.Effect<void, JsonRpcFailure> {
    return Effect.gen({ self: this }, function* () {
      if (sequence <= this.acknowledgedIncomingSequence) return
      const existing = this.incomingBarriers.get(sequence)
      const barrier = existing ?? (yield* Deferred.make<undefined, JsonRpcFailure>())
      if (!existing) this.incomingBarriers.set(sequence, barrier)
      yield* Deferred.await(barrier)
    })
  }

  notify(method: string, params: unknown = {}): Effect.Effect<void, JsonRpcFailure> {
    return Effect.gen({ self: this }, function* () {
      if (this.closed) return yield* new JsonRpcFailure({ reason: 'closed' })
      yield* this.send({ method, params })
    })
  }

  respond(id: JsonRpcId, result: unknown): Effect.Effect<void, JsonRpcFailure> {
    return this.send({ id, result })
  }

  respondError(id: JsonRpcId, code: number, message: string): Effect.Effect<void, JsonRpcFailure> {
    return this.send({ id, error: { code, message } })
  }

  close(deadlineMs = 1000): Effect.Effect<void> {
    return this.shutdown(deadlineMs)
  }

  private send(message: object): Effect.Effect<void, JsonRpcFailure> {
    return this.transport
      .write(encode(message))
      .pipe(Effect.mapError(() => new JsonRpcFailure({ reason: 'write-failed' })))
  }

  private readLoop(): Effect.Effect<void, JsonRpcFailure> {
    return Effect.gen({ self: this }, function* () {
      const iterable = yield* Stream.toAsyncIterableEffect(this.transport.input)
      const iterator = iterable[Symbol.asyncIterator]()
      const decoder = new TextDecoder()
      let buffered = ''
      try {
        for (;;) {
          const next = yield* Effect.tryPromise({
            try: () => iterator.next(),
            catch: () => new JsonRpcFailure({ reason: 'closed' }),
          })
          if (next.done) break
          buffered += decoder.decode(next.value, { stream: true })
          if (new TextEncoder().encode(buffered).byteLength > MAX_LINE_BYTES && !buffered.includes('\n')) {
            return yield* new JsonRpcFailure({ reason: 'frame-too-large' })
          }
          let newline = buffered.indexOf('\n')
          while (newline >= 0) {
            const line = buffered.slice(0, newline).replace(/\r$/, '')
            buffered = buffered.slice(newline + 1)
            if (new TextEncoder().encode(line).byteLength > MAX_LINE_BYTES)
              return yield* new JsonRpcFailure({ reason: 'frame-too-large' })
            if (line.length > 0) yield* this.accept(line)
            newline = buffered.indexOf('\n')
          }
        }
        if (buffered.length > 0) yield* this.accept(buffered)
        return yield* new JsonRpcFailure({ reason: 'closed' })
      } finally {
        yield* Effect.tryPromise({ try: () => Promise.resolve(iterator.return?.()), catch: () => undefined }).pipe(
          Effect.ignore,
        )
      }
    }).pipe(
      Effect.catch(error =>
        Effect.gen({ self: this }, function* () {
          const reason = error instanceof JsonRpcFailure ? error.reason : 'invalid-frame'
          yield* this.failPending(reason === 'closed' ? 'closed' : 'request-failed')
          yield* Queue.fail(this.events, new JsonRpcFailure({ reason }))
        }),
      ),
    )
  }

  private accept(line: string): Effect.Effect<void, JsonRpcFailure> {
    return Effect.gen({ self: this }, function* () {
      let message: JsonRpcMessage | undefined
      try {
        message = decodeFrame(line)
      } catch {
        return yield* new JsonRpcFailure({ reason: 'invalid-frame' })
      }
      if (!message) return yield* new JsonRpcFailure({ reason: 'invalid-frame' })
      if ('result' in message || 'error' in message) {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        pending.incomingSequence = this.nextIncomingSequence - 1
        if ('result' in message) yield* Deferred.succeed(pending.reply, message.result)
        else yield* Deferred.fail(pending.reply, new JsonRpcFailure({ reason: 'request-failed' }))
      } else if ('id' in message) {
        const size = yield* Queue.size(this.events)
        if (size >= MAX_INCOMING_MESSAGES || this.incomingAcks.size >= MAX_INCOMING_MESSAGES)
          return yield* new JsonRpcFailure({ reason: 'too-many-pending' })
        const sequence = this.nextIncomingSequence++
        this.incomingAcks.set(sequence, yield* Deferred.make<undefined, JsonRpcFailure>())
        yield* Queue.offer(this.events, {
          _tag: 'Request',
          sequence,
          id: message.id,
          method: message.method,
          params: message.params,
        })
      } else {
        const size = yield* Queue.size(this.events)
        if (size >= MAX_INCOMING_MESSAGES || this.incomingAcks.size >= MAX_INCOMING_MESSAGES)
          return yield* new JsonRpcFailure({ reason: 'too-many-pending' })
        const sequence = this.nextIncomingSequence++
        this.incomingAcks.set(sequence, yield* Deferred.make<undefined, JsonRpcFailure>())
        yield* Queue.offer(this.events, {
          _tag: 'Notification',
          sequence,
          method: message.method,
          params: message.params,
        })
      }
    })
  }

  private failPending(reason: JsonRpcFailure['reason']): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      this.closed = true
      for (const pending of this.pending.values()) yield* Deferred.fail(pending.reply, new JsonRpcFailure({ reason }))
      this.pending.clear()
      for (const barrier of this.incomingBarriers.values())
        yield* Deferred.fail(barrier, new JsonRpcFailure({ reason }))
      this.incomingBarriers.clear()
    })
  }

  private shutdown(deadlineMs = 1000): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.shutdownStarted) return
      this.shutdownStarted = true
      this.closed = true
      for (const pending of this.pending.values())
        yield* Deferred.fail(pending.reply, new JsonRpcFailure({ reason: 'closed' }))
      this.pending.clear()
      for (const barrier of this.incomingBarriers.values())
        yield* Deferred.fail(barrier, new JsonRpcFailure({ reason: 'closed' }))
      this.incomingBarriers.clear()
      yield* Queue.shutdown(this.events)
      yield* this.transport.close(deadlineMs)
    })
  }
}

export const jsonRpcLimits = {
  maxLineBytes: MAX_LINE_BYTES,
  maxPendingRequests: MAX_PENDING_REQUESTS,
  maxIncomingMessages: MAX_INCOMING_MESSAGES,
} as const
