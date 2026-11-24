import { MessageChannel } from 'node:worker_threads'

import * as BrowserWorkerRunner from '@effect/platform-browser/BrowserWorkerRunner'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import { describe, expect, it, vi } from 'vitest'

import {
  makeWorkerClient,
  type MethodContracts,
  serveWorker,
  type WorkerClient,
} from '../src/renderer/features/workspace/right-panel/file-previews/office/worker-rpc.js'

type TestMethods = {
  echo: { input: string; output: string }
  bytes: { input: ArrayBuffer; output: number }
  wait: { input: string; output: string }
}
const testContracts = {
  echo: { input: Schema.String, output: Schema.String },
  bytes: { input: Schema.instanceOf(ArrayBuffer), output: Schema.Number },
  wait: { input: Schema.String, output: Schema.String },
} satisfies MethodContracts<TestMethods>
const permissiveContracts = {
  echo: { input: Schema.Any, output: Schema.Any },
  bytes: { input: Schema.Any, output: Schema.Any },
  wait: { input: Schema.Any, output: Schema.Any },
} satisfies MethodContracts<TestMethods>

interface Harness {
  readonly client: WorkerClient<TestMethods>
  readonly worker: Worker
  readonly terminate: ReturnType<typeof vi.fn>
  readonly received: string[]
  readonly release: () => void
}

function harness(
  invalidEcho = false,
  clientContracts: MethodContracts<TestMethods> = testContracts,
  serverContracts: MethodContracts<TestMethods> = testContracts,
) {
  return Effect.gen(function* () {
    const channel = new MessageChannel()
    const terminate = vi.fn(() => channel.port1.close())
    const worker = Object.assign(channel.port1, { terminate }) as unknown as Worker
    const received: string[] = []
    let release = () => {}
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        channel.port1.close()
        channel.port2.close()
      }),
    )
    yield* serveWorker<TestMethods>(
      serverContracts,
      {
        echo: input => (invalidEcho ? (1 as unknown as string) : input.toUpperCase()),
        bytes: input => input.byteLength,
        wait: (input, signal) =>
          new Promise<string>((resolve, reject) => {
            received.push(input)
            release = () => resolve(input)
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          }),
      },
      BrowserWorkerRunner.layerMessagePort(channel.port2 as unknown as MessagePort),
    ).pipe(Effect.forkScoped)
    const client = yield* makeWorkerClient<TestMethods>(worker, clientContracts)
    return { client, worker, terminate, received, release: () => release() } satisfies Harness
  })
}

describe('Effect preview worker lifecycle', () => {
  it('runs the official worker protocol and transfers input buffers', async () => {
    let stopped: ReturnType<typeof vi.fn> | undefined
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { client, terminate } = yield* harness()
          stopped = terminate
          expect(yield* client.call('echo', 'ready')).toBe('READY')
          const bytes = new ArrayBuffer(16)
          expect(yield* client.call('bytes', bytes, { transfer: [bytes] })).toBe(16)
          expect(bytes.byteLength).toBe(0)
        }),
      ),
    )
    expect(stopped).toHaveBeenCalled()
  })

  it('replaces queued requests sharing a key and preserves the running request', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* harness()
          const first = yield* test.client.call('wait', 'running').pipe(Effect.forkScoped)
          yield* Effect.promise(() => vi.waitFor(() => expect(test.received).toEqual(['running'])))
          const older = yield* test.client
            .call('echo', 'older', { key: 'viewport' })
            .pipe(Effect.exit, Effect.forkScoped)
          yield* Effect.yieldNow
          const latest = yield* test.client.call('echo', 'latest', { key: 'viewport' }).pipe(Effect.forkScoped)
          yield* Effect.yieldNow
          const oldExit = yield* Fiber.join(older)
          expect(oldExit._tag).toBe('Failure')
          test.release()
          expect(yield* Fiber.join(first)).toBe('running')
          expect(yield* Fiber.join(latest)).toBe('LATEST')
        }),
      ),
    )
  })

  it('releases a superseded queue slot before checking capacity', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* harness()
          const running = yield* test.client.call('wait', 'running').pipe(Effect.forkScoped)
          yield* Effect.promise(() => vi.waitFor(() => expect(test.received).toEqual(['running'])))
          const older = yield* test.client
            .call('echo', 'older', { key: 'viewport' })
            .pipe(Effect.exit, Effect.forkScoped)
          const queued = yield* Effect.forEach(
            Array.from({ length: 30 }, (_, index) => index),
            index => test.client.call('echo', `queued-${index}`).pipe(Effect.forkScoped),
          )
          yield* Effect.yieldNow
          const latest = yield* test.client.call('echo', 'latest', { key: 'viewport' }).pipe(Effect.forkScoped)
          yield* Effect.yieldNow
          expect((yield* Fiber.join(older))._tag).toBe('Failure')
          test.release()
          expect(yield* Fiber.join(running)).toBe('running')
          expect(yield* Fiber.join(latest)).toBe('LATEST')
          expect(yield* Effect.forEach(queued, Fiber.join)).toHaveLength(30)
        }),
      ),
    )
  })

  it('validates method input and output at the client boundary', async () => {
    const invalidInput = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* harness()
          return yield* test.client.call('echo', 42 as never).pipe(Effect.exit)
        }),
      ),
    )
    expect(invalidInput._tag).toBe('Failure')

    const invalidServerInput = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* harness(false, permissiveContracts)
          const exit = yield* test.client.call('echo', 42 as never).pipe(Effect.exit)
          expect(test.received).toEqual([])
          return exit
        }),
      ),
    )
    expect(invalidServerInput._tag).toBe('Failure')

    const invalidOutput = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* harness(true, testContracts, permissiveContracts)
          return yield* test.client.call('echo', 'input').pipe(Effect.exit)
        }),
      ),
    )
    expect(invalidOutput._tag).toBe('Failure')

    const invalidMethod = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* harness()
          return yield* test.client.call('constructor' as never, undefined as never).pipe(Effect.exit)
        }),
      ),
    )
    expect(invalidMethod._tag).toBe('Failure')
  })

  it('cancels a queued request without terminating the active worker', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* harness()
          const running = yield* test.client.call('wait', 'active').pipe(Effect.forkScoped)
          yield* Effect.promise(() => vi.waitFor(() => expect(test.received).toEqual(['active'])))
          const abort = new AbortController()
          const queued = yield* test.client
            .call('echo', 'canceled', { signal: abort.signal })
            .pipe(Effect.exit, Effect.forkScoped)
          yield* Effect.yieldNow
          abort.abort()
          expect((yield* Fiber.join(queued))._tag).toBe('Failure')
          expect(test.terminate).not.toHaveBeenCalled()
          test.release()
          expect(yield* Fiber.join(running)).toBe('active')
          expect(yield* test.client.call('echo', 'still ready')).toBe('STILL READY')
        }),
      ),
    )
  })

  it('rejects active and queued requests when the native worker fails', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* harness()
          const active = yield* test.client.call('wait', 'active').pipe(Effect.exit, Effect.forkScoped)
          yield* Effect.promise(() => vi.waitFor(() => expect(test.received).toEqual(['active'])))
          const queued = yield* test.client.call('echo', 'queued').pipe(Effect.exit, Effect.forkScoped)
          yield* Effect.yieldNow
          test.worker.dispatchEvent(new Event('messageerror'))
          expect((yield* Fiber.join(active))._tag).toBe('Failure')
          expect((yield* Fiber.join(queued))._tag).toBe('Failure')
          expect(test.terminate).toHaveBeenCalled()
        }),
      ),
    )
  })

  it('terminates a timed-out worker and rejects subsequent requests', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const test = yield* harness()
          const exit = yield* test.client.call('wait', 'stalled', { timeoutMs: 100 }).pipe(Effect.exit)
          expect(exit._tag).toBe('Failure')
          expect(test.terminate).toHaveBeenCalled()
          expect((yield* test.client.call('echo', 'after timeout').pipe(Effect.exit))._tag).toBe('Failure')
        }),
      ),
    )
  })
})
