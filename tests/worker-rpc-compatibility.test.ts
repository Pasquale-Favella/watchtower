import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import * as NodeWorkerPlatform from '@effect/platform-node/NodeWorker'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import { Rpc, RpcClient, RpcGroup, RpcWorker } from 'effect/rpc'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

class ProbeFailure extends Schema.TaggedError<ProbeFailure>()('ProbeFailure', { message: Schema.String }) {}
const ProbeGroup = RpcGroup.make(
  Rpc.make('probe:echo', { payload: { value: Schema.String }, success: Schema.Struct({ value: Schema.String }) }),
  Rpc.make('probe:fail', { error: ProbeFailure }),
  Rpc.make('probe:wait', { success: Schema.String }),
  Rpc.make('probe:stats', {
    success: Schema.Struct({ initialized: Schema.String, cancelled: Schema.Number }),
  }),
)

const runnerPath = fileURLToPath(new URL('./fixtures/worker-rpc/runner.mjs', import.meta.url))

interface SpawnObservation {
  readonly failInitialization?: boolean | 'first'
  readonly workers: Array<Worker>
  spawnCount: number
  exitCount: number
}

const protocolLayer = (observation: SpawnObservation, startupValue = 'ledger-ready') => {
  const workerPlatform = NodeWorkerPlatform.layer(id => {
    observation.spawnCount += 1
    const worker = new Worker(runnerPath, {
      workerData: {
        id,
        failInitialization:
          observation.failInitialization === true || (observation.failInitialization === 'first' && id === 0),
      },
    })
    observation.workers.push(worker)
    worker.on('exit', () => {
      observation.exitCount += 1
    })
    return worker
  })
  const dependencies = Layer.merge(
    workerPlatform,
    RpcWorker.layerInitialMessage(Schema.String, Effect.succeed(startupValue)),
  )
  return RpcClient.layerProtocolWorker({ size: 1 }).pipe(Layer.provide(dependencies))
}

describe('official Effect RPC worker transport compatibility', () => {
  it('round-trips typed RPC values/errors, interrupts work, owns one worker, and closes it normally', async () => {
    const observation: SpawnObservation = { workers: [], spawnCount: 0, exitCount: 0 }
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* Layer.build(protocolLayer(observation))
          const client = yield* RpcClient.make(ProbeGroup).pipe(
            Effect.provideService(RpcClient.Protocol, Context.get(protocol, RpcClient.Protocol)),
          )

          const echoed = yield* client['probe:echo']({ value: 'structured-clone-safe' })
          const failure = yield* Effect.result(client['probe:fail'](undefined))

          const pending = yield* Effect.forkChild(client['probe:wait'](undefined))
          yield* Effect.sleep('40 millis')
          yield* Fiber.interrupt(pending)

          let stats = yield* client['probe:stats'](undefined)
          for (let attempt = 0; stats.cancelled === 0 && attempt < 30; attempt += 1) {
            yield* Effect.sleep('10 millis')
            stats = yield* client['probe:stats'](undefined)
          }

          return { echoed, failure, stats }
        }),
      ),
    )

    expect(result.echoed).toEqual({ value: 'structured-clone-safe' })
    expect(result.failure).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ProbeFailure', message: 'typed probe failure' },
    })
    expect(result.stats).toEqual({ initialized: 'ledger-ready', cancelled: 1 })
    expect(observation.spawnCount).toBe(1)
    expect(observation.exitCount).toBe(1)
  }, 10_000)

  it('reports a pre-readiness exit to pending calls without spawning overlapping replacements', async () => {
    const observation: SpawnObservation = { failInitialization: true, workers: [], spawnCount: 0, exitCount: 0 }
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* Layer.build(protocolLayer(observation))
          const client = yield* RpcClient.make(ProbeGroup).pipe(
            Effect.provideService(RpcClient.Protocol, Context.get(protocol, RpcClient.Protocol)),
          )
          return yield* Effect.result(
            client['probe:echo']({ value: 'never-accepted' }).pipe(Effect.timeout('3 seconds')),
          )
        }),
      ),
    )

    expect(result._tag).toBe('Failure')
    expect(observation.spawnCount).toBe(1)
    expect(observation.exitCount).toBe(1)
    if (result._tag === 'Failure')
      expect(result.failure).toMatchObject({ _tag: 'RpcClientError', reason: { _tag: 'WorkerReceiveError' } })
  }, 10_000)

  it('surfaces a failed ledger-ready initialization acknowledgement', async () => {
    const observation: SpawnObservation = { workers: [], spawnCount: 0, exitCount: 0 }
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* Layer.build(protocolLayer(observation, 'invalid-init'))
          const client = yield* RpcClient.make(ProbeGroup).pipe(
            Effect.provideService(RpcClient.Protocol, Context.get(protocol, RpcClient.Protocol)),
          )
          return yield* Effect.result(
            client['probe:echo']({ value: 'must-fail-init' }).pipe(Effect.timeout('3 seconds')),
          )
        }),
      ),
    )

    expect(result._tag).toBe('Failure')
    expect(observation.spawnCount).toBe(1)
    expect(observation.exitCount).toBe(1)
    if (result._tag === 'Failure')
      expect(result.failure).toMatchObject({ _tag: 'RpcClientError', reason: { _tag: 'WorkerReceiveError' } })
  }, 10_000)
})
