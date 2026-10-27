import { parentPort, workerData } from 'node:worker_threads'

import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import { RpcServer, RpcWorker } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import { DbWorkerContext } from '../../src/main/db-worker/context.js'
import type { DbWorkerData } from '../../src/main/db-worker/protocol.js'
import { dbWorkerRpcServerLayer } from '../../src/main/db-worker/rpc-server.js'
import { LedgerIngest } from '../../src/main/store/ledger-repository.js'
import { LedgerViewReads } from '../../src/main/store/ledger-view-reads.js'
import { openWorkerRuntime } from '../../src/main/worker-runtime.js'
import { WorkerRpcGroup } from '../../src/shared/rpc/worker.js'
import { buildFixtureCachedFile, FIXTURE_SOURCE_PATH } from './cached-file.js'

const port = parentPort
if (!port) throw new Error('native read-ordering fixture must run on a worker thread')

const init = workerData as DbWorkerData
const snapshotGate = Deferred.makeUnsafe<undefined, never>()
const serverLayer = dbWorkerRpcServerLayer({
  createContext: async emit => {
    const runtime = openWorkerRuntime(init.dbPath)
    try {
      runtime.runSync(
        Effect.flatMap(LedgerIngest, ingest =>
          ingest.portIn({
            provider: 'opencode',
            envFingerprint: 'native-read-ordering',
            filePath: FIXTURE_SOURCE_PATH,
            verdict: 'new',
            cachedFile: buildFixtureCachedFile(),
          }),
        ),
      )

      const reads = runtime.runSync(LedgerViewReads)
      const getViewData = reads.getViewData.bind(reads)
      reads.getViewData = () =>
        getViewData().pipe(
          Effect.flatMap(data =>
            Effect.sync(() =>
              emit({
                event: 'scan:progress',
                manual: true,
                progress: { stage: 'parse', provider: 'native-read-ordering', total: data.overrides.length },
              }),
            ).pipe(Effect.andThen(Deferred.await(snapshotGate)), Effect.as(data)),
          ),
        )

      const context = new DbWorkerContext(init, emit, { runtime })
      return {
        dispatchEffect: (operation: string, args: unknown[]) =>
          context
            .dispatchEffect(operation, args)
            .pipe(
              Effect.tap(() =>
                operation === 'models:setPrice' ? Deferred.succeed(snapshotGate, undefined) : Effect.void,
              ),
            ),
        close: () => context.close(),
      }
    } catch (error) {
      try {
        Effect.runSync(runtime.disposeEffect)
      } catch {
        // Preserve the initialization failure.
      }
      throw error
    }
  },
  onFatal: () => port.close(),
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
