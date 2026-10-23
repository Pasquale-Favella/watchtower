import process from 'node:process'
import { parentPort, workerData } from 'node:worker_threads'

import * as Effect from 'effect/Effect'
import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner'
import { Rpc, RpcGroup, RpcServer, RpcWorker } from 'effect/rpc'
import * as Schema from 'effect/Schema'

const Ready = Schema.Struct({ incarnation: Schema.Int })
const Commit = Rpc.make('probe:commit', { success: Schema.Void })
const Ping = Rpc.make('probe:ping', { success: Schema.Int })
const Shutdown = Rpc.make('probe:shutdown', { success: Schema.Void })
const Group = RpcGroup.make(Commit, Ping, Shutdown)
const counters = new Int32Array(workerData.counters)

if (!parentPort) throw new Error('supervised fixture must run in a worker thread')

if (workerData.failInitialization) {
  process.exit(41)
} else {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const protocol = yield* RpcServer.makeProtocolWorkerRunner.pipe(Effect.provide(NodeWorkerRunner.layer))
      const ready = yield* RpcWorker.initialMessage(Ready).pipe(Effect.provideService(RpcServer.Protocol, protocol))
      if (ready.incarnation !== workerData.incarnation) {
        process.exit(42)
        return
      }
      Atomics.add(counters, 1, 1)
      const handlers = Group.toLayer({
        'probe:commit': () => Effect.sync(() => Atomics.add(counters, 0, 1)).pipe(Effect.andThen(Effect.never)),
        'probe:ping': () => Effect.succeed(workerData.incarnation),
        'probe:shutdown': () => Effect.sync(() => Atomics.add(counters, 2, 1)).pipe(Effect.asVoid),
      })
      yield* RpcServer.make(Group, { disableTracing: true }).pipe(
        Effect.provideService(RpcServer.Protocol, protocol),
        Effect.provide(handlers),
      )
    }),
  )

  Effect.runPromise(program).catch(() => {
    process.exitCode = 42
  })
}
