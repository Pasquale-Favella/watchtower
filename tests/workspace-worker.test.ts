import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import * as Effect from 'effect/Effect'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { WorkspaceWorkerStoreLive } from '@/platform/electron/workers/workspace/client.js'
import { type BeginRunCommand, WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

const timestamp = '2026-10-29T10:00:00Z'
const project = {
  id: 'project-worker' as never,
  name: 'Worker project',
  repositoryIdentity: 'repo:workspace-worker',
  createdAt: timestamp,
  updatedAt: timestamp,
}
const checkout = {
  id: 'checkout-worker' as never,
  kind: 'main' as const,
  path: 'C:/workspace-worker',
  createdAt: timestamp,
}
const task = {
  id: 'task-worker' as never,
  projectId: project.id,
  title: 'Workspace worker integration',
  description: '',
  createdAt: timestamp,
}
const conversation = { id: 'conversation-worker' as never, title: 'Integration', createdAt: timestamp }
const beginRun: BeginRunCommand = {
  commandId: 'command-worker',
  issuedAt: '2026-10-29T10:00:01Z',
  runId: 'run-worker' as never,
  taskId: task.id,
  conversationId: conversation.id,
  checkoutId: checkout.id,
  provisionalAgentSessionId: 'agent-session-worker',
  generation: 1,
  driverId: 'test-driver',
  connectionId: 'test-connection',
  prompt: 'Complete the controlled integration task',
}

let fixtureDirectory = ''
let workerPath = ''
let shutdownIgnoringWorkerPath = ''

interface RuntimeFixture {
  readonly runtime: ManagedRuntime.ManagedRuntime<WorkspaceStore, WorkspaceStoreError>
  readonly workers: Array<Worker>
}

const makeRuntime = (
  filename: string,
  options: {
    readonly workerPath?: string
    readonly initializationTimeoutMs?: number
    readonly closeTimeoutMs?: number
    readonly workerFactory?: (workerPath: string | URL, workerData: { readonly filename: string }) => Worker
  } = {},
): RuntimeFixture => {
  const workers: Array<Worker> = []
  const runtime = ManagedRuntime.make(
    WorkspaceWorkerStoreLive({
      filename,
      workerPath: options.workerPath ?? workerPath,
      ...(options.initializationTimeoutMs === undefined
        ? {}
        : { initializationTimeoutMs: options.initializationTimeoutMs }),
      ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
      workerFactory: (path, data) => {
        const worker = options.workerFactory
          ? options.workerFactory(path, data)
          : new Worker(path, { workerData: data })
        workers.push(worker)
        return worker
      },
    }),
  )
  return { runtime, workers }
}

const withStore = async (filename: string, use: (store: WorkspaceStore['Service']) => Promise<void>): Promise<void> => {
  const { runtime } = makeRuntime(filename)
  try {
    const store = await runtime.runPromise(WorkspaceStore)
    await use(store)
  } finally {
    await runtime.dispose()
  }
}

const setup = async (store: WorkspaceStore['Service']): Promise<void> => {
  await Effect.runPromise(store.registerProject({ project, mainCheckout: checkout }))
  await Effect.runPromise(store.createTask({ task, conversation }))
}

beforeAll(async () => {
  const buildCache = resolve('node_modules/.cache')
  await mkdir(buildCache, { recursive: true })
  fixtureDirectory = await mkdtemp(join(buildCache, 'watchtower-workspace-worker-'))
  workerPath = join(fixtureDirectory, 'workspace-worker.mjs')
  shutdownIgnoringWorkerPath = join(fixtureDirectory, 'shutdown-ignoring-worker.mjs')
  await build({
    entryPoints: [resolve('src/platform/electron/workers/workspace/entry.ts')],
    outfile: workerPath,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  })
  await build({
    stdin: {
      resolveDir: process.cwd(),
      sourcefile: 'shutdown-ignoring-worker.mjs',
      contents: `
import { parentPort } from 'node:worker_threads'
import * as NodeRuntime from '@effect/platform-node/NodeRuntime'
import * as NodeWorkerRunner from '@effect/platform-node/NodeWorkerRunner'
import * as Effect from 'effect/Effect'
import { Rpc, RpcGroup, RpcServer, RpcWorker } from 'effect/rpc'
import * as Schema from 'effect/Schema'

if (!parentPort) throw new Error('test worker must run on a worker thread')
const on = parentPort.on.bind(parentPort)
parentPort.on = (event, listener) => on(event, event === 'message'
  ? message => { if (!Array.isArray(message) || message[0] !== 1) listener(message) }
  : listener)

const group = RpcGroup.make(
  Rpc.make('workspace-worker:ready', { success: Schema.Struct({ protocolVersion: Schema.Literal(1) }) }),
  Rpc.make('workspace-worker:shutdown', { success: Schema.Void }),
)
const handlers = group.toLayer({
  'workspace-worker:ready': () => Effect.succeed({ protocolVersion: 1 }),
  'workspace-worker:shutdown': () => Effect.succeed(undefined),
})
const program = Effect.scoped(Effect.gen(function* () {
  const protocol = yield* RpcServer.makeProtocolWorkerRunner.pipe(Effect.provide(NodeWorkerRunner.layer))
  yield* RpcWorker.initialMessage(Schema.Void).pipe(Effect.provideService(RpcServer.Protocol, protocol))
  return yield* RpcServer.make(group, { disableTracing: true }).pipe(
    Effect.provideService(RpcServer.Protocol, protocol),
    Effect.provide(handlers),
  )
}))
NodeRuntime.runMain(program, { disableErrorReporting: true })
`,
    },
    outfile: shutdownIgnoringWorkerPath,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  })
})

afterAll(async () => {
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true })
})

describe('workspace worker RPC client', () => {
  it('runs the durable WorkspaceStore lifecycle through one bundled worker', async () => {
    const filename = join(fixtureDirectory, 'lifecycle.db')
    await withStore(filename, async store => {
      await setup(store)

      await expect(Effect.runPromise(store.beginRun(beginRun))).resolves.toMatchObject({ replayed: false })
      await expect(Effect.runPromise(store.beginRun(beginRun))).resolves.toMatchObject({ replayed: true })
      const claim = await Effect.runPromise(store.claimDispatch(beginRun.runId, 7, '2026-10-29T10:00:02Z'))
      expect(claim).toMatchObject({ runId: beginRun.runId, ownerEpoch: 7, workspacePath: checkout.path })
      await Effect.runPromise(
        store.acknowledgeDispatch(beginRun.runId, {
          ownerEpoch: 7,
          nativeSessionId: 'native-session-worker',
          nativeTurnId: 'native-turn-worker',
          acknowledgedAt: '2026-10-29T10:00:03Z',
        }),
      )
      const event = await Effect.runPromise(
        store.recordDriverEvent(beginRun.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'event-complete-worker',
          occurredAt: '2026-10-29T10:00:04Z',
          event: { kind: 'turnCompleted', nativeTurnId: 'native-turn-worker' },
        }),
      )
      expect(event.kind).toBe('driverEvent')
      await expect(
        Effect.runPromise(store.beginRun({ ...beginRun, prompt: 'conflicting prompt' })),
      ).rejects.toMatchObject({
        _tag: 'WorkspaceStoreError',
        code: 'command-conflict',
        message: 'Workspace command conflicts with a prior operation.',
      })

      const page = await Effect.runPromise(store.pageEvents(0, 20))
      const snapshot = await Effect.runPromise(store.readTaskSnapshot(task.id, 10))
      expect(page.events.map(entry => entry.kind)).toEqual([
        'runQueued',
        'dispatchClaimed',
        'runStarted',
        'driverEvent',
      ])
      expect(snapshot.runs).toMatchObject([expect.objectContaining({ id: beginRun.runId, status: 'completed' })])
    })
  }, 20_000)

  it('requires explicit replacement and recovers an unresolved epoch-7 dispatch without re-dispatch', async () => {
    const filename = join(fixtureDirectory, 'recovery.db')
    const first = makeRuntime(filename)
    try {
      const store = await first.runtime.runPromise(WorkspaceStore)
      await setup(store)
      await Effect.runPromise(store.beginRun(beginRun))
      await Effect.runPromise(store.claimDispatch(beginRun.runId, 7, '2026-10-29T10:00:02Z'))
      expect(first.workers).toHaveLength(1)
      const firstWorker = first.workers[0]
      if (!firstWorker) throw new Error('workspace worker was not created')
      await firstWorker.terminate()
      await first.runtime.dispose()

      const replacement = makeRuntime(filename)
      try {
        const recoveredStore = await replacement.runtime.runPromise(WorkspaceStore)
        expect(replacement.workers).toHaveLength(1)
        await expect(Effect.runPromise(recoveredStore.recoverWorker(7, '2026-10-29T10:00:03Z'))).resolves.toBe(1)
        const snapshot = await Effect.runPromise(recoveredStore.readTaskSnapshot(task.id, 10))
        expect(snapshot.runs).toMatchObject([expect.objectContaining({ id: beginRun.runId, status: 'uncertain' })])
        expect(replacement.workers).toHaveLength(1)
      } finally {
        await replacement.runtime.dispose()
      }
    } finally {
      await first.runtime.dispose()
    }
  }, 20_000)

  it('bounds startup failure and exposes only a sanitized transport error', async () => {
    const missingWorkerPath = join(fixtureDirectory, 'missing-workspace-worker.mjs')
    const { runtime } = makeRuntime(join(fixtureDirectory, 'boot-failure.db'), {
      workerPath: missingWorkerPath,
      initializationTimeoutMs: 1_000,
    })
    const startedAt = Date.now()
    try {
      await expect(runtime.runPromise(WorkspaceStore)).rejects.toMatchObject({
        _tag: 'WorkspaceStoreError',
        code: 'database-unavailable',
        message: 'Workspace storage is unavailable.',
      })
      expect(Date.now() - startedAt).toBeLessThan(5_000)
    } finally {
      await runtime.dispose()
    }
  }, 10_000)

  it('bounds the full acquisition when a live worker never completes its protocol handshake', async () => {
    const { runtime, workers } = makeRuntime(join(fixtureDirectory, 'silent-startup.db'), {
      initializationTimeoutMs: 100,
      workerFactory: () => new Worker('setInterval(() => {}, 1_000)', { eval: true }),
    })
    const startedAt = Date.now()
    const opening = runtime.runPromise(WorkspaceStore)
    try {
      const outcome = await Promise.race([
        opening.then(
          () => ({ status: 'resolved' as const }),
          error => ({ status: 'rejected' as const, error }),
        ),
        new Promise<{ readonly status: 'guard-timeout' }>(resolve =>
          setTimeout(() => resolve({ status: 'guard-timeout' }), 1_500),
        ),
      ])
      expect(outcome.status).toBe('rejected')
      if (outcome.status === 'rejected') {
        expect(outcome.error).toMatchObject({
          _tag: 'WorkspaceStoreError',
          code: 'database-unavailable',
          message: 'Workspace storage is unavailable.',
        })
      }
      expect(Date.now() - startedAt).toBeLessThan(1_000)
      expect(workers[0]?.threadId).toBe(-1)
    } finally {
      const worker = workers[0]
      if (worker && worker.threadId !== -1) await worker.terminate()
      await opening.catch(() => {})
      await runtime.dispose()
    }
  }, 5_000)

  it('forces termination within the close deadline when the worker ignores protocol close', async () => {
    const { runtime, workers } = makeRuntime(join(fixtureDirectory, 'ignored-close.db'), {
      workerPath: shutdownIgnoringWorkerPath,
      closeTimeoutMs: 100,
    })
    await runtime.runPromise(WorkspaceStore)
    const worker = workers[0]
    if (!worker) throw new Error('workspace worker was not created')

    const startedAt = Date.now()
    const closing = runtime.dispose()
    try {
      const outcome = await Promise.race([
        closing.then(
          () => ({ status: 'resolved' as const }),
          error => ({ status: 'rejected' as const, error }),
        ),
        new Promise<{ readonly status: 'guard-timeout' }>(resolve =>
          setTimeout(() => resolve({ status: 'guard-timeout' }), 1_500),
        ),
      ])
      expect(outcome.status).toBe('resolved')
      expect(Date.now() - startedAt).toBeLessThan(600)
      expect(worker.threadId).toBe(-1)
    } finally {
      if (worker.threadId !== -1) await worker.terminate()
      await closing.catch(() => {})
    }
  }, 5_000)

  it('reports a typed cleanup error when forced native termination cannot be confirmed', async () => {
    const terminateNative: Array<() => Promise<number>> = []
    const { runtime, workers } = makeRuntime(join(fixtureDirectory, 'unresolved-close.db'), {
      workerPath: shutdownIgnoringWorkerPath,
      closeTimeoutMs: 100,
      workerFactory: path => {
        const worker = new Worker(path)
        terminateNative.push(worker.terminate.bind(worker))
        worker.terminate = () => new Promise<number>(() => {})
        return worker
      },
    })
    await runtime.runPromise(WorkspaceStore)
    const worker = workers[0]
    if (!worker) throw new Error('workspace worker was not created')

    const startedAt = Date.now()
    const closing = runtime.dispose()
    try {
      const outcome = await Promise.race([
        closing.then(
          () => ({ status: 'resolved' as const }),
          error => ({ status: 'rejected' as const, error }),
        ),
        new Promise<{ readonly status: 'guard-timeout' }>(resolve =>
          setTimeout(() => resolve({ status: 'guard-timeout' }), 1_500),
        ),
      ])
      expect(outcome.status).toBe('rejected')
      if (outcome.status === 'rejected') {
        expect(outcome.error).toMatchObject({
          _tag: 'WorkspaceStoreError',
          code: 'database-unavailable',
          message: 'Workspace worker cleanup did not complete.',
        })
      }
      expect(Date.now() - startedAt).toBeLessThan(600)
    } finally {
      if (worker.threadId !== -1) await terminateNative[0]?.()
      await closing.catch(() => {})
    }
  }, 5_000)

  it('rejects invalid and oversized requests, bounds concurrency, and keeps the worker usable', async () => {
    const { runtime } = makeRuntime(join(fixtureDirectory, 'limits.db'))
    try {
      const store = await runtime.runPromise(WorkspaceStore)
      await setup(store)

      await expect(Effect.runPromise(store.pageEvents(-1, 20))).rejects.toMatchObject({
        _tag: 'WorkspaceStoreError',
        code: 'invalid-data',
      })
      await expect(
        Effect.runPromise(store.beginRun({ ...beginRun, prompt: 'x'.repeat(1_100_000) })),
      ).rejects.toMatchObject({
        _tag: 'WorkspaceStoreError',
        code: 'database-unavailable',
        message: 'Workspace worker request limit exceeded.',
      })

      const requests = Array.from({ length: 65 }, () => Effect.runPromise(store.pageEvents(0, 500)))
      const results = await Promise.allSettled(requests)
      expect(
        results.some(
          result =>
            result.status === 'rejected' &&
            result.reason instanceof Error &&
            'message' in result.reason &&
            result.reason.message === 'Workspace worker request limit exceeded.',
        ),
      ).toBe(true)
      await expect(Effect.runPromise(store.readTaskSnapshot(task.id, 10))).resolves.toMatchObject({
        task: { id: task.id },
      })
    } finally {
      await runtime.dispose()
    }
  }, 20_000)
})
