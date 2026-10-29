import { Effect, Fiber, Queue, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  JsonRpcClient,
  jsonRpcLimits,
  type JsonRpcTransport,
} from '@/infrastructure/agent-harnesses/drivers/json-rpc.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function fakeTransport() {
  const incoming = Effect.runSync(Queue.unbounded<Uint8Array>())
  const outgoing = Effect.runSync(Queue.unbounded<Uint8Array>())
  let closed = false
  const transport: JsonRpcTransport = {
    input: Stream.fromQueue(incoming),
    write: bytes => Queue.offer(outgoing, bytes).pipe(Effect.asVoid),
    close: () =>
      Effect.sync(() => {
        closed = true
      }),
  }
  return {
    transport,
    incoming,
    outgoing,
    isClosed: () => closed,
    send: (message: unknown) => Queue.offer(incoming, encoder.encode(`${JSON.stringify(message)}\n`)),
    read: Effect.map(Queue.take(outgoing), bytes => JSON.parse(decoder.decode(bytes)) as Record<string, unknown>),
  }
}

describe('JSON-RPC client', () => {
  it('matches out-of-order responses to their original requests', async () => {
    const fake = fakeTransport()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* JsonRpcClient.make(fake.transport)
          const first = yield* Effect.forkScoped(client.request('first', { value: 1 }))
          const second = yield* Effect.forkScoped(client.request('second', { value: 2 }))
          const requestA = yield* fake.read
          const requestB = yield* fake.read
          const idA = requestA.id as number
          const idB = requestB.id as number
          yield* fake.send({ id: idB, result: { answer: 'second' } })
          yield* fake.send({ id: idA, result: { answer: 'first' } })
          return [yield* Fiber.join(first), yield* Fiber.join(second)]
        }),
      ),
    )

    expect(result).toEqual([{ answer: 'first' }, { answer: 'second' }])
  })

  it('holds native requests until the caller sends a decision response', async () => {
    const fake = fakeTransport()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* JsonRpcClient.make(fake.transport)
          const iterable = yield* Stream.toAsyncIterableEffect(client.incoming)
          const iterator = iterable[Symbol.asyncIterator]()
          yield* fake.send({ id: 'approval-7', method: 'execCommandApproval', params: { threadId: 'thread-1' } })
          const event = yield* Effect.tryPromise({
            try: () => iterator.next(),
            catch: () => new Error('stream failed'),
          })
          const beforeDecision = yield* Queue.size(fake.outgoing)
          yield* client.respond('approval-7', { decision: 'decline' })
          const response = yield* fake.read
          yield* Effect.tryPromise({ try: () => Promise.resolve(iterator.return?.()), catch: () => undefined }).pipe(
            Effect.ignore,
          )
          return { event: event.value, beforeDecision, response }
        }),
      ),
    )

    expect(result.event).toMatchObject({ _tag: 'Request', id: 'approval-7', method: 'execCommandApproval' })
    expect(result.beforeDecision).toBe(0)
    expect(result.response).toEqual({ id: 'approval-7', result: { decision: 'decline' } })
  })

  it('bounds incoming events consumed without acknowledgement', async () => {
    const fake = fakeTransport()
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* JsonRpcClient.make(fake.transport)
          const iterable = yield* Stream.toAsyncIterableEffect(client.incoming)
          const iterator = iterable[Symbol.asyncIterator]()
          for (let sequence = 0; sequence < jsonRpcLimits.maxIncomingMessages; sequence += 1) {
            yield* fake.send({ method: 'notice', params: { sequence } })
            yield* Effect.tryPromise({
              try: () => iterator.next(),
              catch: () => new Error('event stream failed early'),
            })
          }
          yield* fake.send({ method: 'one-too-many', params: {} })
          const result = yield* Effect.exit(
            Effect.tryPromise({ try: () => iterator.next(), catch: () => new Error('event stream failed') }),
          )
          return result._tag
        }),
      ),
    )

    expect(failure).toBe('Failure')
  })

  it('rejects malformed and oversized frames without exposing the payload', async () => {
    const fake = fakeTransport()
    const reason = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* JsonRpcClient.make(fake.transport)
          const iterable = yield* Stream.toAsyncIterableEffect(client.incoming)
          const iterator = iterable[Symbol.asyncIterator]()
          yield* fake.send({ id: 3, result: 'x'.repeat(jsonRpcLimits.maxLineBytes + 1) })
          const result = yield* Effect.exit(
            Effect.tryPromise({ try: () => iterator.next(), catch: () => new Error('stream failed') }),
          )
          yield* Effect.tryPromise({ try: () => Promise.resolve(iterator.return?.()), catch: () => undefined }).pipe(
            Effect.ignore,
          )
          return result._tag
        }),
      ),
    )

    expect(reason).toBe('Failure')
  })

  it('fails outstanding requests on disconnect and closes the owned transport with its Scope', async () => {
    const fake = fakeTransport()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* JsonRpcClient.make(fake.transport)
          const pending = yield* Effect.forkScoped(client.request('never-resolves'))
          yield* fake.read
          yield* fake.send({ id: 999, result: 'unrelated' })
          yield* Queue.shutdown(fake.incoming)
          const exit = yield* Fiber.await(pending)
          return exit._tag
        }),
      ),
    )

    expect(result).toBe('Failure')
    expect(fake.isClosed()).toBe(true)
  })
})
