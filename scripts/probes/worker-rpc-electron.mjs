import { writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import * as NodeWorkerPlatform from '@effect/platform-node/NodeWorker'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import { RpcClient, RpcWorker } from 'effect/rpc'
import * as Schema from 'effect/Schema'
import { app } from 'electron'

import { ProbeGroup } from '../../tests/fixtures/worker-rpc/group.mjs'

const runnerPath =
  process.env.WATCHTOWER_WORKER_RPC_FIXTURE ??
  fileURLToPath(new URL('../../tests/fixtures/worker-rpc/runner.mjs', import.meta.url))
const outputPath = process.env.WATCHTOWER_WORKER_RPC_LOG
const report = stage => {
  if (outputPath) writeFileSync(outputPath, JSON.stringify({ stage }))
}
report('loaded')
const observation = { workers: [], spawnCount: 0, exitCount: 0 }
const workerPlatform = NodeWorkerPlatform.layer(id => {
  observation.spawnCount += 1
  const worker = new Worker(runnerPath, { workerData: { id, failInitialization: false } })
  observation.workers.push(worker)
  worker.on('exit', () => {
    observation.exitCount += 1
  })
  return worker
})
const dependencies = Layer.merge(
  workerPlatform,
  RpcWorker.layerInitialMessage(Schema.String, Effect.succeed('ledger-ready')),
)
const workerProtocol = RpcClient.layerProtocolWorker({ size: 1 }).pipe(Layer.provide(dependencies))

async function runProbe() {
  const startedAt = Date.now()
  await app.whenReady()
  report('ready')
  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* Layer.build(workerProtocol)
          report('protocol')
          const client = yield* RpcClient.make(ProbeGroup).pipe(
            Effect.provideService(RpcClient.Protocol, Context.get(protocol, RpcClient.Protocol)),
          )
          const echo = yield* client['probe:echo']({ value: 'electron-worker-thread' })
          report('echo')
          const error = yield* Effect.result(client['probe:fail'](undefined))
          const waiting = yield* Effect.forkChild(client['probe:wait'](undefined))
          yield* Effect.sleep('40 millis')
          yield* Fiber.interrupt(waiting)
          const stats = yield* client['probe:stats'](undefined)
          return { echo, error: error._tag, stats }
        }),
      ).pipe(Effect.timeout('20 seconds')),
    )

    const observationResult = {
      electron: process.versions.electron,
      node: process.versions.node,
      elapsedMs: Date.now() - startedAt,
      result,
      spawnCount: observation.spawnCount,
      exitCount: observation.exitCount,
    }
    console.log(JSON.stringify(observationResult))
    if (outputPath) await writeFile(outputPath, JSON.stringify(observationResult))
    app.exit(0)
  } catch (error) {
    if (outputPath) await writeFile(outputPath, JSON.stringify({ error: String(error) }))
    app.exit(1)
  }
}
void runProbe().catch(async error => {
  if (outputPath) await writeFile(outputPath, JSON.stringify({ error: String(error) }))
  app.exit(1)
})
