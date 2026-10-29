import { parentPort, workerData } from 'node:worker_threads'

import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner'
import * as Effect from 'effect/Effect'
import * as Queue from 'effect/Queue'
import { RpcServer, RpcWorker } from 'effect/rpc'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import { type SequencedWorkerEvent, WorkerRpcError, WorkerRpcGroup } from '../../../src/shared/rpc/worker.js'

if (!parentPort) throw new Error('typed RPC fixture must run in a worker thread')

const program = Effect.scoped(
  Effect.gen(function* () {
    const protocol = yield* RpcServer.makeProtocolWorkerRunner.pipe(Effect.provide(NodeWorkerRunner.layer))
    yield* RpcWorker.initialMessage(Schema.Void).pipe(Effect.provideService(RpcServer.Protocol, protocol))

    const events = yield* Queue.unbounded<SequencedWorkerEvent>()
    let eventSequence = 0

    const handlers = new Proxy({} as Record<string, (request: unknown) => unknown>, {
      get(_target, tag: string) {
        switch (tag) {
          case 'worker:ready':
            return () => {
              return workerData.failReady
                ? Effect.fail(
                    new WorkerRpcError({
                      code: 'unsupported-schema-version',
                      message: 'The database worker operation failed.',
                    }),
                  )
                : Effect.succeed({ value: true, eventSequence })
            }
          case 'worker:events':
            return () => {
              return Stream.concat(
                Stream.make({ sequence: 0, event: { event: 'worker:events-ready' } }),
                Stream.fromQueue(events),
              )
            }
          case 'worker:shutdown':
            return () => Effect.succeed({ value: null, eventSequence })
          case 'scan:abort':
            return () => Effect.succeed({ value: null, eventSequence })
          case 'models:addAlias':
            return () => {
              const count = new Int32Array(workerData.counters)
              Atomics.add(count, 0, 1)
              if (workerData.blockCommit) return Effect.never
              eventSequence += 1
              Queue.offerUnsafe(events, {
                sequence: eventSequence,
                event: { event: 'config:changed' },
              } as SequencedWorkerEvent)
              return Effect.succeed({ value: { ok: true }, eventSequence })
            }
          default:
            return () =>
              Effect.fail(
                new WorkerRpcError({
                  code: 'invalid-request',
                  message: 'The database worker operation failed.',
                }),
              )
        }
      },
    })

    return yield* RpcServer.make(WorkerRpcGroup, { disableTracing: true }).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provide(WorkerRpcGroup.toLayer(handlers as never)),
    )
  }),
)

Effect.runPromise(program).catch(() => {
  process.exitCode = 1
})
