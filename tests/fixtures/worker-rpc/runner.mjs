import { workerData } from 'node:worker_threads'
import process from 'node:process'
import * as Effect from 'effect/Effect'
import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner'
import { RpcServer, RpcWorker } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import { ProbeFailure, ProbeGroup } from './group.mjs'

if (workerData?.failInitialization) {
  process.exit(41)
} else {
  let cancelled = 0

  const program = Effect.scoped(
    Effect.gen(function* () {
      const protocol = yield* RpcServer.makeProtocolWorkerRunner.pipe(Effect.provide(NodeWorkerRunner.layer))
      const initialized = yield* RpcWorker.initialMessage(Schema.String).pipe(
        Effect.provideService(RpcServer.Protocol, protocol),
      )
      if (initialized !== 'ledger-ready') {
        process.exit(42)
        return
      }
      const handlers = ProbeGroup.toLayer({
        'probe:echo': ({ value }) => Effect.succeed({ value }),
        'probe:fail': () => Effect.fail(new ProbeFailure({ message: 'typed probe failure' })),
        'probe:wait': () =>
          Effect.never.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                cancelled += 1
              }),
            ),
          ),
        'probe:stats': () => Effect.succeed({ initialized, cancelled }),
      })

      yield* RpcServer.make(ProbeGroup, { disableTracing: true }).pipe(
        Effect.provideService(RpcServer.Protocol, protocol),
        Effect.provide(handlers),
      )
    }),
  )

  Effect.runPromise(program).catch(() => {
    process.exitCode = 42
  })
}
