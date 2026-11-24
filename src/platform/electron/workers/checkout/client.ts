import { Worker } from 'node:worker_threads'

import * as NodeWorker from '@effect/platform-node/NodeWorker'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as RpcClient from 'effect/rpc/RpcClient'
import type { RpcClientError } from 'effect/rpc/RpcClientError'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'

import { CheckoutInspection, CheckoutInspectionError } from '@/core/ports/checkout-inspection.js'

import { CheckoutWorkerRpc } from './protocol.js'

/** Lazily starts one scoped inspection worker; Git, encoding and filesystem work leave Electron main responsive. */
export function checkoutInspectionWorkerLayer(
  workerPath: string | URL,
  workerFactory: () => Worker = () => new Worker(workerPath, { execArgv: [] }),
) {
  return Layer.effect(
    CheckoutInspection,
    Effect.gen(function* () {
      const lifetime = yield* Effect.scope
      const gate = yield* Semaphore.make(4)
      let pending = 0
      // Keep the successful worker for the app lifetime, but allow a later checkout
      // request to retry if startup failed transiently. Checkout inspection is
      // optional and must not turn one worker spawn failure into a permanent outage.
      const acquire = yield* Effect.cachedWithTTL(
        Effect.gen(function* () {
          const workerScope = yield* Scope.fork(lifetime)
          const protocol = RpcClient.layerProtocolWorker({ size: 1, concurrency: 4 }).pipe(
            Layer.provide(NodeWorker.layer(workerFactory)),
          )
          return yield* Effect.gen(function* () {
            const services = yield* Layer.buildWithScope(protocol, workerScope)
            return yield* RpcClient.make(CheckoutWorkerRpc).pipe(
              Effect.provideContext(services),
              Effect.provideService(Scope.Scope, workerScope),
            )
          }).pipe(Effect.onExit(exit => (Exit.isFailure(exit) ? Scope.close(workerScope, exit) : Effect.void)))
        }),
        exit => (Exit.isSuccess(exit) ? 'Infinity' : 0),
      )

      function request<Value>(
        operation: (
          client: RpcClient.FromGroup<typeof CheckoutWorkerRpc, RpcClientError>,
        ) => Effect.Effect<Value, unknown>,
      ): Effect.Effect<Value, CheckoutInspectionError> {
        return Effect.suspend(() => {
          if (pending >= 32)
            return Effect.fail(
              new CheckoutInspectionError({ code: 'unavailable', message: 'Checkout request queue is full' }),
            )
          pending++
          return gate.withPermit(Effect.flatMap(acquire, operation)).pipe(
            Effect.timeout('30 seconds'),
            Effect.mapError(cause =>
              Schema.is(CheckoutInspectionError)(cause)
                ? cause
                : new CheckoutInspectionError({ code: 'unavailable', message: 'Checkout worker is unavailable' }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                pending--
              }),
            ),
          )
        })
      }
      return CheckoutInspection.of({
        diffPreview: (root, source) => request(client => client['inspect:diff']({ root, source })),
        filePatch: (root, patch) => request(client => client['inspect:patch']({ root, request: patch })),
        branches: root => request(client => client['inspect:branches']({ root })),
        commits: root => request(client => client['inspect:commits']({ root })),
        listEntries: (root, path, options) => request(client => client['inspect:entries']({ root, path, ...options })),
        readFile: (root, path, options) => request(client => client['inspect:read']({ root, path, ...options })),
        writeFile: (root, write) => request(client => client['inspect:write']({ root, ...write })),
      })
    }),
  )
}
