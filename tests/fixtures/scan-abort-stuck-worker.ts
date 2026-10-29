import { appendFileSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'

import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner'
import * as Effect from 'effect/Effect'
import { RpcServer, RpcWorker } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import type { DbWorkerEmit } from '../../src/main/db-worker/context.js'
import type { DbWorkerData } from '../../src/main/db-worker/protocol.js'
import { dbWorkerRpcServerLayer } from '../../src/main/db-worker/rpc-server.js'
import { WorkerRpcGroup } from '../../src/shared/rpc/worker.js'

interface FixtureData extends DbWorkerData {
  readonly markerPath: string
  readonly lateWriteDelayMs: number
}

const port = parentPort
if (!port) throw new Error('abort recovery fixture requires a worker thread')

const init = workerData as FixtureData
const serverLayer = dbWorkerRpcServerLayer({
  createContext: async (emit: DbWorkerEmit) => ({
    dispatchEffect: (operation: string) =>
      Effect.suspend(() => {
        if (operation === 'scan:start') {
          emit({ event: 'scan:progress', manual: true, progress: { stage: 'parse' } })
          setTimeout(() => {
            appendFileSync(init.markerPath, 'late-write\n')
            emit({ event: 'scan:progress', manual: true, progress: { stage: 'parse' } })
          }, init.lateWriteDelayMs)
          return Effect.never
        }
        if (operation === 'scan:abort') return Effect.never
        if (operation === 'shutdown') return Effect.succeed(null)
        return Effect.fail(new Error('unexpected fixture operation'))
      }),
    close: async () => {},
  }),
  onFatal: () => {
    port.close()
  },
})

const program = Effect.scoped(
  Effect.gen(function* () {
    const protocol = yield* RpcServer.makeProtocolWorkerRunner.pipe(Effect.provide(NodeWorkerRunner.layer))
    yield* RpcWorker.initialMessage(Schema.Void).pipe(Effect.provideService(RpcServer.Protocol, protocol))
    return yield* RpcServer.make(WorkerRpcGroup, { disableTracing: true }).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provide(serverLayer),
    )
  }),
)

Effect.runPromise(program).catch(() => {
  process.exitCode = 1
})
