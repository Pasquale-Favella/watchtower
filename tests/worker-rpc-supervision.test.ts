import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import * as NodeWorkerPlatform from '@effect/platform-node/NodeWorker'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import { Rpc, RpcClient, RpcGroup, RpcWorker } from 'effect/rpc'
import type { RpcClientError } from 'effect/rpc/RpcClientError'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

const Ready = Schema.Struct({ incarnation: Schema.Int })
const Group = RpcGroup.make(
  Rpc.make('probe:commit', { success: Schema.Void }),
  Rpc.make('probe:ping', { success: Schema.Int }),
  Rpc.make('probe:shutdown', { success: Schema.Void }),
)
type Client = RpcClient.FromGroup<typeof Group, RpcClientError>

const runnerPath = fileURLToPath(new URL('./fixtures/worker-rpc/supervised-runner.mjs', import.meta.url))

interface Observation {
  attempts: number
  exits: number
  terminations: number
  active: number
  maxActive: number
  readonly spawnTimes: Array<number>
  readonly exitTimes: Array<number>
}

interface Incarnation {
  readonly client: Client
  readonly worker: Worker
  readonly counters: Int32Array
  readonly stop: () => Promise<void>
  readonly protocolSpawnAttempts: () => number
}

const waitForExit = (worker: Worker) =>
  worker.threadId === -1 ? Promise.resolve() : new Promise<void>(resolve => worker.once('exit', () => resolve()))

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

const makeIncarnation = async (
  incarnation: number,
  observation: Observation,
  failInitialization = false,
): Promise<Incarnation> => {
  const countersBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3)
  const counters = new Int32Array(countersBuffer)
  let resolveStop!: () => void
  const stopSignal = new Promise<void>(resolve => {
    resolveStop = resolve
  })
  const worker = new Worker(runnerPath, { workerData: { incarnation, failInitialization, counters: countersBuffer } })
  const terminate = worker.terminate.bind(worker)
  worker.terminate = () => {
    observation.terminations += 1
    return terminate()
  }
  observation.active += 1
  observation.maxActive = Math.max(observation.maxActive, observation.active)
  worker.once('exit', () => {
    observation.active -= 1
    observation.exits += 1
    observation.exitTimes.push(Date.now())
    resolveStop()
  })

  let protocolSpawnAttempts = 0
  const workerPlatform = NodeWorkerPlatform.layer(() => {
    protocolSpawnAttempts += 1
    observation.attempts += 1
    observation.spawnTimes.push(Date.now())
    if (protocolSpawnAttempts !== 1) throw new Error('one protocol scope owns one native worker')
    return worker
  })
  const protocolLayer = RpcClient.layerProtocolWorker({ size: 1 }).pipe(
    Layer.provide(Layer.merge(workerPlatform, RpcWorker.layerInitialMessage(Ready, Effect.succeed({ incarnation })))),
  )
  let resolveStartup!: (client: Client) => void
  let rejectStartup!: (cause: unknown) => void
  let startupSettled = false
  const startup = new Promise<Client>((resolve, reject) => {
    resolveStartup = resolve
    rejectStartup = reject
  })
  const program = Effect.scoped(
    Effect.gen(function* () {
      const protocol = yield* Layer.build(protocolLayer)
      const client = yield* RpcClient.make(Group).pipe(
        Effect.provideService(RpcClient.Protocol, Context.get(protocol, RpcClient.Protocol)),
      )
      startupSettled = true
      resolveStartup(client)
      yield* Effect.promise(() => stopSignal)
    }),
  )
  const fiber = Effect.runFork(program)
  fiber.addObserver(exit => {
    if (!startupSettled) rejectStartup(exit)
  })
  const client = await Promise.race([
    startup,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('worker RPC scope startup timed out')), 3_000)),
  ])

  return {
    client,
    worker,
    counters,
    protocolSpawnAttempts: () => protocolSpawnAttempts,
    stop: async () => {
      resolveStop()
      const closed = Effect.runPromise(Fiber.await(fiber))
      const outcome = await Promise.race([closed.then(() => 'closed'), delay(1_500).then(() => 'timeout')])
      if (outcome === 'timeout' && worker.threadId !== -1) {
        const exited = waitForExit(worker)
        void worker.terminate()
        await Promise.race([exited, delay(1_500)])
      }
      await Promise.race([closed, delay(1_500)])
      await Promise.race([waitForExit(worker), delay(1_500)])
    },
  }
}

const makeObservation = (): Observation => ({
  attempts: 0,
  exits: 0,
  terminations: 0,
  active: 0,
  maxActive: 0,
  spawnTimes: [],
  exitTimes: [],
})

const waitForCounter = async (counters: Int32Array, index: number, expected: number) => {
  const deadline = Date.now() + 2_000
  while (Atomics.load(counters, index) !== expected && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  expect(Atomics.load(counters, index)).toBe(expected)
}

describe('official worker RPC under incarnation supervision', () => {
  it('closes a failed initialization scope before the official retry can respawn', async () => {
    const observation = makeObservation()
    const incarnation = await makeIncarnation(1, observation, true)
    try {
      await waitForExit(incarnation.worker)
      await incarnation.stop()
      await new Promise(resolve => setTimeout(resolve, 1_100))

      expect(observation.attempts).toBe(1)
      expect(incarnation.protocolSpawnAttempts()).toBe(1)
      expect(observation.exits).toBe(1)
      expect(observation.maxActive).toBe(1)
    } finally {
      if (observation.active > 0) await incarnation.worker.terminate()
    }
  }, 8_000)

  it('fails one committed pending call, closes the old scope, then permits a replacement', async () => {
    const observation = makeObservation()
    const first = await makeIncarnation(1, observation)
    let replacement: Incarnation | undefined
    let phase = 'initial ping'
    try {
      await expect(Effect.runPromise(first.client['probe:ping'](undefined))).resolves.toBe(1)
      let settlements = 0
      phase = 'commit request'
      const pendingWrite = Effect.runPromise(first.client['probe:commit'](undefined)).then(
        () => {
          settlements += 1
          return 'success'
        },
        () => {
          settlements += 1
          return 'failure'
        },
      )
      await waitForCounter(first.counters, 0, 1)
      phase = 'native termination'
      const exited = waitForExit(first.worker)
      await first.worker.terminate()
      await exited

      phase = 'pending RPC failure'
      const result = await Promise.race([
        pendingWrite,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('pending RPC did not settle')), 800)),
      ])
      expect(result).toBe('failure')
      phase = 'old scope cleanup'
      const cleanupStarted = Date.now()
      await first.stop()
      expect(Date.now() - cleanupStarted).toBeLessThan(1_000)
      await delay(1_100)

      expect(settlements).toBe(1)
      expect(Atomics.load(first.counters, 0)).toBe(1)
      expect(observation.terminations).toBe(1)
      expect(first.protocolSpawnAttempts()).toBe(1)
      expect(observation.attempts).toBe(1)
      expect(observation.active).toBe(0)

      phase = 'replacement startup'
      replacement = await makeIncarnation(2, observation)
      phase = 'replacement request'
      const replacementPing = Effect.runPromise(replacement.client['probe:ping'](undefined))
      const replacementResult = await Promise.race([
        replacementPing,
        delay(2_000).then(() => {
          throw new Error('replacement RPC did not become ready')
        }),
      ])
      expect(replacementResult).toBe(2)
      expect(observation.spawnTimes).toHaveLength(2)
      const replacementSpawnTime = observation.spawnTimes[1]
      const firstExitTime = observation.exitTimes[0]
      expect(replacementSpawnTime).toBeDefined()
      expect(firstExitTime).toBeDefined()
      if (replacementSpawnTime === undefined || firstExitTime === undefined) {
        throw new Error('worker lifecycle timestamps were not recorded')
      }
      expect(firstExitTime).toBeLessThan(replacementSpawnTime)
      expect(Atomics.load(replacement.counters, 1)).toBe(1)
      expect(observation.maxActive).toBe(1)
      phase = 'replacement shutdown request'
      await Effect.runPromise(replacement.client['probe:shutdown'](undefined))
    } catch (error) {
      throw new Error(
        `worker supervision phase '${phase}' failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      await Promise.race([first.stop().catch(() => {}), delay(3_000)])
      if (replacement) await Promise.race([replacement.stop(), delay(3_000)])
    }
  }, 8_000)

  it('sends the application shutdown RPC before the official close handshake', async () => {
    const observation = makeObservation()
    const incarnation = await makeIncarnation(1, observation)
    try {
      await expect(Effect.runPromise(incarnation.client['probe:ping'](undefined))).resolves.toBe(1)
      await Effect.runPromise(incarnation.client['probe:shutdown'](undefined))
      expect(Atomics.load(incarnation.counters, 2)).toBe(1)
      await incarnation.stop()

      expect(observation.exits).toBe(1)
      expect(observation.terminations).toBe(0)
      expect(observation.attempts).toBe(1)
    } finally {
      if (observation.active > 0) await incarnation.worker.terminate()
    }
  }, 8_000)
})
