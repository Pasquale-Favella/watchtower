import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Scope from 'effect/Scope'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DbWorkerClient } from '../src/platform/electron/workers/client.js'
import { openWorkerRpcTransport } from '../src/platform/electron/workers/rpc-transport.js'
import { acquireLedgerMcp } from '../src/platform/mcp/ledger-endpoint.js'
import { createLedgerMcpQueries } from '../src/platform/mcp/query-api.js'
import { WORKER_REQUEST_CAPACITY, type WorkerEvent, WorkerRpcError } from '../src/shared/rpc/worker.js'

let fixtureDir = ''
let runnerPath = ''

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(process.cwd(), 'node_modules', '.watchtower-worker-rpc-'))
  runnerPath = join(fixtureDir, 'typed-runner.mjs')
  await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/worker-rpc/typed-runner.ts', import.meta.url))],
    outfile: runnerPath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    logLevel: 'silent',
  })
})

afterAll(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
})

interface Fixture {
  readonly worker: Worker
  readonly counters: Int32Array
}

const makeFixture = (options: { readonly failReady?: boolean; readonly blockCommit?: boolean } = {}): Fixture => {
  const counters = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  const worker = new Worker(runnerPath, {
    workerData: { counters: counters.buffer, ...options },
  })
  return { worker, counters }
}

const waitForCounter = async (counter: Int32Array, expected: number, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Atomics.load(counter, 0) !== expected && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 5))
  expect(Atomics.load(counter, 0)).toBe(expected)
}

const waitForExit = (worker: Worker): Promise<void> =>
  worker.threadId === -1 ? Promise.resolve() : new Promise(resolve => worker.once('exit', () => resolve()))

describe('supervisor-owned worker RPC transport', () => {
  it('interrupts an admitted ledger query in the worker when its MCP endpoint closes', async () => {
    const counters = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    const worker = new DbWorkerClient(
      { dbPath: 'unused', dataDir: fixtureDir, cacheDir: fixtureDir },
      runnerPath,
      (script, data) => new Worker(script, { workerData: { ...data, counters: counters.buffer } }),
    )
    const scope = Scope.makeUnsafe()
    const client = new Client({ name: 'ledger-cancellation-test', version: '1.0.0' })
    try {
      await worker.ready
      const endpoint = await Effect.runPromise(
        Scope.provide(scope)(acquireLedgerMcp(createLedgerMcpQueries(worker), Effect.runPromise)),
      )
      await client.connect(
        new StreamableHTTPClientTransport(new URL(endpoint.url), {
          requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
        }),
      )
      const pending = client.callTool({ name: 'ledger_scope' })
      void pending.catch(() => {})
      await waitForCounter(counters, 1)

      await Effect.runPromise(Scope.close(scope, Exit.void))
      await waitForCounter(counters, 2)
      await expect(worker.request('scan:active')).resolves.toBe(false)
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
      await client.close()
      await worker.shutdown()
    }
  }, 10_000)

  it('waits for the event subscription barrier and applies event watermarks before returning unary results', async () => {
    const fixture = makeFixture()
    const events: Array<WorkerEvent> = []
    const transport = await openWorkerRpcTransport(fixture.worker, {
      onEvent: event => events.push(event),
      onFailure: () => {},
    })

    try {
      await transport.ready
      expect(events).toEqual([])

      let applied = false
      const transportWithObserver = await Effect.runPromise(
        transport.client['models:addAlias']({ model: 'friendly-name', aliasOf: 'provider/model' }).pipe(
          Effect.tap(() => Effect.sync(() => (applied = events.some(event => event.event === 'config:changed')))),
        ),
      )
      expect(transportWithObserver).toEqual({ ok: true })
      expect(applied).toBe(true)
      expect(events).toEqual([{ event: 'config:changed' }])
    } finally {
      if (fixture.worker.threadId !== -1) {
        await Effect.runPromise(transport.client['worker:shutdown'](undefined)).catch(() => {})
      }
      await transport.close()
      await waitForExit(fixture.worker)
    }
  }, 10_000)

  it('keeps a pending committed command failed after disconnect without replaying it or spawning a replacement', async () => {
    const fixture = makeFixture({ blockCommit: true })
    const failures: Array<WorkerRpcError> = []
    const transport = await openWorkerRpcTransport(fixture.worker, {
      onEvent: () => {},
      onFailure: error => failures.push(error),
    })
    await transport.ready

    const pending = Effect.runPromise(
      transport.client['models:addAlias']({ model: 'friendly-name', aliasOf: 'provider/model' }),
    ).then(
      () => 'success',
      () => 'failure',
    )

    try {
      await waitForCounter(fixture.counters, 1)
      await fixture.worker.terminate()
      await waitForExit(fixture.worker)
      await expect(pending).resolves.toBe('failure')
      await new Promise(resolve => setTimeout(resolve, 1_100))

      expect(Atomics.load(fixture.counters, 0)).toBe(1)
      expect(failures).toHaveLength(1)
      expect(failures[0]).toBeInstanceOf(WorkerRpcError)
      expect(failures[0]?.code).toBe('unavailable')
    } finally {
      await transport.close()
      if (fixture.worker.threadId !== -1) await fixture.worker.terminate()
    }
  }, 10_000)

  it('preserves a specific readiness error while its event consumer is interrupted', async () => {
    const fixture = makeFixture({ failReady: true })
    const failures: Array<WorkerRpcError> = []
    const transport = await openWorkerRpcTransport(fixture.worker, {
      onEvent: () => {},
      onFailure: error => failures.push(error),
    })

    try {
      await expect(transport.ready).rejects.toMatchObject({
        _tag: 'WorkerRpcError',
        code: 'unsupported-schema-version',
      })
      expect(failures).toHaveLength(1)
      expect(failures[0]?.code).toBe('unsupported-schema-version')
    } finally {
      await transport.close()
      await waitForExit(fixture.worker)
    }
  }, 10_000)

  it('keeps abort and shutdown control calls available at the ordinary request limit', async () => {
    const fixture = makeFixture({ blockCommit: true })
    const transport = await openWorkerRpcTransport(fixture.worker, {
      onEvent: () => {},
      onFailure: () => {},
    })
    const pending: Array<Fiber.Fiber<unknown, unknown>> = []

    try {
      await transport.ready
      for (let index = 0; index < WORKER_REQUEST_CAPACITY; index += 1) {
        pending.push(
          Effect.runFork(
            transport.client['models:addAlias']({ model: `name-${index}`, aliasOf: `provider/model-${index}` }),
          ),
        )
      }
      await waitForCounter(fixture.counters, WORKER_REQUEST_CAPACITY)

      await expect(Effect.runPromise(transport.client['scan:abort'](undefined))).resolves.toBeNull()
      await expect(Effect.runPromise(transport.client['worker:shutdown'](undefined))).resolves.toBeNull()
      expect(Atomics.load(fixture.counters, 0)).toBe(WORKER_REQUEST_CAPACITY)
    } finally {
      for (const fiber of pending) await Effect.runPromise(Fiber.interrupt(fiber))
      await transport.close()
      if (fixture.worker.threadId !== -1) await fixture.worker.terminate()
    }
  }, 15_000)
})
