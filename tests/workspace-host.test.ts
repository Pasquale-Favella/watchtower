import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Stream from 'effect/Stream'
import * as SubscriptionRef from 'effect/SubscriptionRef'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  AgentDriver,
  type AgentDriverConnection,
  AgentDriverError,
  type AgentDriverSession,
} from '@/core/ports/agent-driver.js'
import { AgentDriverRegistry } from '@/core/ports/agent-driver-registry.js'
import { CheckoutResolver } from '@/core/ports/checkout-resolver.js'
import { NodePlatformLive } from '@/infrastructure/platform/platform-live.js'
import type { WorkspaceHostOptions } from '@/platform/electron/main/workspace/host.js'
import { WorkspaceHost, WorkspaceHostLive } from '@/platform/electron/main/workspace/host.js'
import type { WorkspaceWorkerSupervisorOptions } from '@/platform/electron/main/workspace/supervisor.js'

let directory = ''
let workerPath = ''

beforeAll(async () => {
  const cache = resolve('node_modules/.cache')
  await mkdir(cache, { recursive: true })
  directory = await mkdtemp(join(cache, 'workspace-host-'))
  workerPath = join(directory, 'workspace-worker.mjs')
  await build({
    entryPoints: [resolve('src/platform/electron/workers/workspace/entry.ts')],
    outfile: workerPath,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  })
})

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

const fixture = (
  name: string,
  workerFactory?: WorkspaceWorkerSupervisorOptions['workerFactory'],
  driverRegistry = AgentDriverRegistry.fromDrivers([]),
  closeOrder?: Array<string>,
  options: Partial<WorkspaceHostOptions> = {},
) => {
  const workers: Array<Worker> = []
  const runtime = ManagedRuntime.make(
    Layer.merge(
      WorkspaceHostLive({
        closeDeadlineMs: 180,
        initializationTimeoutMs: 5_000,
        filename: join(directory, `${name}.db`),
        workerPath,
        loadConnections: () =>
          Effect.succeed([{ id: 'test-connection', driverId: 'acp', command: 'fake-agent', args: [] }]),
        loadDrivers: () => Effect.succeed(driverRegistry),
        loadCheckoutResolver: () =>
          Effect.succeed(
            CheckoutResolver.of({
              resolve: path =>
                Effect.succeed({
                  canonicalPath: path,
                  kind: 'main',
                  repositoryIdentity: `repo:${path.slice('C:/repo-'.length)}`,
                  mainCheckoutPath: path,
                  branch: null,
                  headRevision: null,
                  dirty: { trackedChanges: 0, untrackedCount: 0, ignoredCount: 0 },
                }),
              createIsolatedWorktree: () => Effect.die('Unexpected worktree creation'),
              removeWorktree: () => Effect.die('Unexpected worktree removal'),
            }),
          ),
        ...options,
        workerFactory: (path, data) => {
          const worker = workerFactory ? workerFactory(path, data) : new Worker(path, { workerData: data })
          if (closeOrder) {
            closeOrder.push('worker-start')
            worker.once('exit', () => closeOrder.push('worker-close'))
          }
          workers.push(worker)
          return worker
        },
      }),
      NodePlatformLive,
    ),
  )
  return { runtime, workers }
}

const supported = { support: 'supported' as const, restrictions: [], evidence: [{ source: 'driver' as const }] }
const capabilities = {
  openSession: supported,
  loadSession: supported,
  submit: supported,
  interrupt: supported,
  steer: supported,
  respond: supported,
  reconcile: supported,
  models: [],
  modes: [],
}

const workspace = (suffix: string) => ({
  project: {
    id: `project-${suffix}` as never,
    name: `Project ${suffix}`,
    repositoryIdentity: `repo:${suffix}`,
    createdAt: '2026-10-29T10:00:00Z',
    updatedAt: '2026-10-29T10:00:00Z',
  },
  checkout: {
    id: `checkout-${suffix}` as never,
    kind: 'main' as const,
    path: `C:/repo-${suffix}`,
    createdAt: '2026-10-29T10:00:00Z',
  },
  task: {
    id: `task-${suffix}` as never,
    projectId: `project-${suffix}` as never,
    title: `Task ${suffix}`,
    description: '',
    createdAt: '2026-10-29T10:00:00Z',
  },
  conversation: {
    id: `conversation-${suffix}` as never,
    title: `Conversation ${suffix}`,
    createdAt: '2026-10-29T10:00:00Z',
  },
})

const beginCommand = (suffix: string) => ({
  commandId: `command-${suffix}`,
  issuedAt: '2026-10-29T10:00:01Z',
  runId: `run-${suffix}` as never,
  taskId: `task-${suffix}` as never,
  conversationId: `conversation-${suffix}` as never,
  checkoutId: `checkout-${suffix}` as never,
  provisionalAgentSessionId: `session-${suffix}`,
  generation: 1,
  driverId: 'acp',
  connectionId: 'test-connection',
  prompt: `Do work ${suffix}`,
})

const fakeRegistry = (
  submissions: Array<string>,
  closes: Array<string>,
  nativeClose: Effect.Effect<void, AgentDriverError>,
  sessionOverrides: Partial<AgentDriverSession> = {},
) =>
  AgentDriverRegistry.fromDrivers([
    AgentDriver.of({
      driverId: 'acp',
      connect: () => {
        const nativeSessionId = `native-host-session-${submissions.length + 1}`
        let closed = false
        const interrupted = Deferred.makeUnsafe<undefined>()
        const session: AgentDriverSession = {
          identity: { nativeSessionId: nativeSessionId, generation: 1 },
          capabilities,
          events: () =>
            Stream.fromEffect(Deferred.await(interrupted)).pipe(Stream.as({ kind: 'turnInterrupted' as const })),
          submit: input =>
            Effect.sync(() => {
              submissions.push(input.runId)
              return { nativeSessionId: nativeSessionId, generation: 1 }
            }),
          interrupt: () =>
            Effect.as(Deferred.succeed(interrupted, undefined), {
              acknowledged: true,
              termination: 'stillRunning' as const,
            }),
          steer: () => Effect.succeed({ outcome: 'accepted' }),
          respond: () => Effect.succeed({ outcome: 'accepted' }),
          reconcile: () => Stream.empty,
          ...sessionOverrides,
        }
        const connection: AgentDriverConnection = {
          identity: { id: 'test-connection', driverId: 'acp', authentication: 'authenticated' },
          discover: () => Effect.succeed(capabilities),
          openSession: () => Effect.succeed(session),
          loadSession: () => Effect.succeed(session),
          close: () =>
            Effect.suspend(() => {
              if (closed) return Effect.void
              closed = true
              return Effect.andThen(
                Effect.sync(() => closes.push('native-close')),
                nativeClose,
              )
            }),
        }
        return Effect.acquireRelease(Effect.succeed(connection), value => value.close(1_000).pipe(Effect.orDie))
      },
    }),
  ])

describe('lazy application WorkspaceHost', () => {
  it('does not start the SQLite worker during layer acquisition', async () => {
    const { runtime, workers } = fixture('lazy')
    try {
      const host = await runtime.runPromise(WorkspaceHost)
      expect(workers).toHaveLength(0)
      expect(await Effect.runPromise(SubscriptionRef.get(host.status))).toEqual({
        state: 'not-started',
        ownerEpoch: undefined,
      })
    } finally {
      await runtime.dispose()
    }
  })

  it('provides the real checkout resolver and refuses a repository deleted after registration', async () => {
    const repositoryPath = join(directory, 'deleted-checkout')
    await mkdir(repositoryPath)
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repositoryPath, windowsHide: true })
    const registered = workspace('deleted-checkout')
    const nativeCalls: string[] = []
    const drivers = AgentDriverRegistry.fromDrivers([
      AgentDriver.of({
        driverId: 'acp',
        connect: () => {
          nativeCalls.push('connect')
          return Effect.die('Deleted checkout must never connect')
        },
      }),
    ])
    const { runtime } = fixture('deleted-checkout', undefined, drivers, undefined, { loadCheckoutResolver: undefined })
    try {
      const host = await runtime.runPromise(WorkspaceHost)
      await runtime.runPromise(
        host.store.registerProject({
          project: { ...registered.project, repositoryIdentity: realpathSync.native(join(repositoryPath, '.git')) },
          mainCheckout: { ...registered.checkout, path: realpathSync.native(repositoryPath) },
        }),
      )
      await runtime.runPromise(host.store.createTask({ task: registered.task, conversation: registered.conversation }))
      await rm(repositoryPath, { recursive: true, force: true })
      await runtime.runPromise(host.withExecution(service => service.start(beginCommand('deleted-checkout'))))
      await expect
        .poll(
          async () => (await runtime.runPromise(host.store.readTaskSnapshot(registered.task.id, 10))).runs[0]?.status,
        )
        .toBe('failed')
      expect(nativeCalls).toEqual([])
      expect((await runtime.runPromise(host.store.readTaskSnapshot(registered.task.id, 10))).runs).toEqual([
        expect.objectContaining({ id: 'run-deleted-checkout', status: 'failed', failure: 'launch-failed' }),
      ])
      await expect(runtime.dispose()).rejects.toMatchObject({
        _tag: 'ExecutionServiceError',
        nativeCleanup: 'confirmed',
      })
    } finally {
      await runtime.dispose().catch(() => {})
    }
  }, 15_000)

  it('does not expose thenable or symbol properties on its store', async () => {
    const { runtime, workers } = fixture('not-thenable')
    try {
      const host = await runtime.runPromise(WorkspaceHost)
      expect(Reflect.get(host.store, 'then')).toBeUndefined()
      expect(Reflect.get(host.store, Symbol.iterator)).toBeUndefined()
      expect(await Promise.resolve(host.store)).toBe(host.store)
      expect(workers).toHaveLength(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('keeps an initial open failure sticky until a new application host is created', async () => {
    let attempts = 0
    const { runtime } = fixture('sticky-open', () => {
      attempts += 1
      throw new Error('worker acquisition failed')
    })
    try {
      const host = await runtime.runPromise(WorkspaceHost)
      await expect(runtime.runPromise(host.ensureOpen)).rejects.toMatchObject({ _tag: 'WorkspaceStoreError' })
      await expect(runtime.runPromise(host.ensureOpen)).rejects.toMatchObject({ _tag: 'WorkspaceStoreError' })
      await expect(runtime.runPromise(host.store.pageEvents(0, 1))).rejects.toMatchObject({
        _tag: 'WorkspaceStoreError',
      })
      expect(attempts).toBe(1)
      expect(await Effect.runPromise(SubscriptionRef.get(host.status))).toMatchObject({ state: 'unavailable' })
    } finally {
      await runtime.dispose()
    }
  })

  it('shares concurrent first operations through one real SQLite worker and closes it with the app scope', async () => {
    const { runtime, workers } = fixture('shared-open')
    const host = await runtime.runPromise(WorkspaceHost)
    try {
      await Promise.all([
        runtime.runPromise(host.store.pageEvents(0, 10)),
        runtime.runPromise(host.store.pageEvents(0, 10)),
        runtime.runPromise(host.ensureOpen),
      ])
      expect(workers).toHaveLength(1)
      expect(await Effect.runPromise(SubscriptionRef.get(host.status))).toMatchObject({ state: 'ready', ownerEpoch: 1 })
    } finally {
      await runtime.dispose()
    }
    expect(workers[0]?.threadId).toBe(-1)
  }, 15_000)

  it('keeps the application-owned opening alive when its first caller is cancelled', async () => {
    let workerStarted!: () => void
    const started = new Promise<void>(resolveStarted => {
      workerStarted = resolveStarted
    })
    const { runtime, workers } = fixture('cancelled-open', (path, data) => {
      const worker = new Worker(path, { workerData: data })
      workerStarted()
      return worker
    })
    const host = await runtime.runPromise(WorkspaceHost)
    const fiber = runtime.runFork(host.store.pageEvents(0, 10))
    await started
    await runtime.runPromise(Fiber.interrupt(fiber))
    await runtime.runPromise(host.store.pageEvents(0, 10))
    expect(workers).toHaveLength(1)
    await runtime.dispose()
    expect(workers[0]?.threadId).toBe(-1)
  }, 15_000)

  it('does not block unrelated execution calls behind a stalled caller', async () => {
    const entered = Deferred.makeUnsafe<undefined>()
    const { runtime } = fixture('independent-leases')
    let stalled: Fiber.Fiber<unknown, unknown> | undefined
    try {
      const host = await runtime.runPromise(WorkspaceHost)
      stalled = runtime.runFork(
        host.withExecution(() => Effect.andThen(Deferred.succeed(entered, undefined), Effect.never)),
      )
      await Effect.runPromise(Deferred.await(entered))
      const epoch = await runtime.runPromise(
        host.withExecution((_service, ownerEpoch) => Effect.succeed(ownerEpoch)).pipe(Effect.timeout(250)),
      )
      expect(epoch).toBe(1)
    } finally {
      if (stalled) await Effect.runPromise(Fiber.interrupt(stalled))
      await runtime.dispose()
    }
  }, 15_000)

  it('bounds replacement and application disposal when a caller cannot acknowledge interruption', async () => {
    const entered = Deferred.makeUnsafe<undefined>()
    const release = Deferred.makeUnsafe<undefined>()
    const { runtime, workers } = fixture('uninterruptible-lease', undefined, undefined, undefined, {
      closeDeadlineMs: 20,
    })
    let caller: Promise<unknown> | undefined
    try {
      const host = await runtime.runPromise(WorkspaceHost)
      caller = runtime
        .runPromise(
          Effect.exit(
            host.withExecution(() =>
              Effect.uninterruptible(Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release))),
            ),
          ),
        )
        .catch(error => error)
      await Effect.runPromise(Deferred.await(entered))
      const worker = workers[0]
      if (!worker) throw new Error('worker missing')
      worker.emit('error', new Error('injected blocked lease failure'))
      await expect
        .poll(() => Effect.runPromise(SubscriptionRef.get(host.status)), { timeout: 500 })
        .toMatchObject({ state: 'unavailable' })
      expect(workers).toHaveLength(1)
      await expect(
        Effect.runPromise(
          Effect.tryPromise({ try: () => runtime.dispose(), catch: error => error }).pipe(Effect.timeout(500)),
        ),
      ).rejects.toMatchObject({
        _tag: 'ExecutionServiceError',
        nativeCleanup: 'unconfirmed',
      })
      expect(workers[0]?.threadId).toBe(-1)
      await Effect.runPromise(Deferred.succeed(release, undefined))
      await caller
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined))
      await caller
      await runtime.dispose().catch(() => {})
    }
  }, 15_000)

  it('retires the prior execution service when the supervisor rolls to a new owner epoch', async () => {
    const { runtime, workers } = fixture('retired-service')
    try {
      const host = await runtime.runPromise(WorkspaceHost)
      const previous = await runtime.runPromise(host.withExecution(service => Effect.succeed(service)))
      const worker = workers[0]
      if (!worker) throw new Error('worker missing')
      worker.emit('error', new Error('injected epoch rollover'))
      await expect
        .poll(() => Effect.runPromise(SubscriptionRef.get(host.status)), { timeout: 12_000 })
        .toMatchObject({ state: 'ready', ownerEpoch: 2 })
      await expect(runtime.runPromise(previous.start(beginCommand('retired')))).rejects.toMatchObject({
        _tag: 'ExecutionServiceError',
        reason: 'service-stopped',
      })
      const current = await runtime.runPromise(
        host.withExecution((service, epoch) => Effect.succeed({ service, epoch })),
      )
      expect(current.epoch).toBe(2)
      expect(current.service).not.toBe(previous)
    } finally {
      await runtime.dispose()
    }
  }, 20_000)

  it('rejects concurrent callers whose connection load crosses a generation replacement', async () => {
    const loading = Deferred.makeUnsafe<undefined>()
    const resume = Deferred.makeUnsafe<undefined>()
    let loads = 0
    const observedEpochs: Array<number> = []
    const { runtime, workers } = fixture('concurrent-replacement', undefined, undefined, undefined, {
      loadConnections: () =>
        Effect.gen(function* () {
          loads += 1
          if (loads === 1) {
            yield* Deferred.succeed(loading, undefined)
            yield* Deferred.await(resume)
          }
          return []
        }),
    })
    try {
      const host = await runtime.runPromise(WorkspaceHost)
      await runtime.runPromise(host.ensureOpen)
      const use = (_service: unknown, epoch: number) =>
        Effect.sync(() => {
          observedEpochs.push(epoch)
        })
      const first = runtime.runPromise(Effect.exit(host.withExecution(use)))
      await Effect.runPromise(Deferred.await(loading))
      const worker = workers[0]
      if (!worker) throw new Error('worker missing')
      worker.emit('error', new Error('injected concurrent replacement'))
      await expect
        .poll(() => Effect.runPromise(SubscriptionRef.get(host.status)), { timeout: 12_000 })
        .toMatchObject({ state: 'replacing' })
      const second = runtime.runPromise(Effect.exit(host.withExecution(use)))
      await Effect.runPromise(Deferred.succeed(resume, undefined))
      const results = await Promise.all([first, second])
      expect(results.map(result => result._tag)).toEqual(['Failure', 'Failure'])
      expect(observedEpochs).toEqual([])
      await expect
        .poll(() => Effect.runPromise(SubscriptionRef.get(host.status)), { timeout: 12_000 })
        .toMatchObject({ state: 'ready', ownerEpoch: 2 })
      await runtime.runPromise(host.withExecution(use))
      expect(observedEpochs).toEqual([2])
    } finally {
      await Effect.runPromise(Deferred.succeed(resume, undefined))
      await runtime.dispose()
    }
  }, 20_000)

  it('retires unresolved native steering within the cleanup budget and never resends its uncertain delivery', async () => {
    const entered = Deferred.makeUnsafe<undefined>()
    const retired = Deferred.makeUnsafe<undefined>()
    const submissions: Array<string> = []
    const closes: Array<string> = []
    let nativeSteers = 0
    const registry = fakeRegistry(submissions, closes, Effect.void, {
      steer: () =>
        Effect.gen(function* () {
          nativeSteers += 1
          yield* Deferred.succeed(entered, undefined)
          return yield* Effect.never
        }),
    })
    const { runtime, workers } = fixture('pending-control-replacement', undefined, registry, undefined, {
      closeDeadlineMs: 60,
      beforeReplace: () => Effect.asVoid(Deferred.succeed(retired, undefined)),
    })
    let caller: Fiber.Fiber<unknown, unknown> | undefined
    try {
      const host = await runtime.runPromise(WorkspaceHost)
      const input = workspace('pending-control')
      await runtime.runPromise(host.store.registerProject({ project: input.project, mainCheckout: input.checkout }))
      await runtime.runPromise(host.store.createTask({ task: input.task, conversation: input.conversation }))
      await runtime.runPromise(host.withExecution(service => service.start(beginCommand('pending-control'))))
      await expect
        .poll(async () => (await runtime.runPromise(host.store.readTaskSnapshot(input.task.id, 10))).runs[0]?.status)
        .toBe('running')
      const operation = runtime.runFork(
        host.withExecution((service, ownerEpoch) =>
          service.steer({
            commandId: 'stalled-steer',
            issuedAt: '2026-10-29T10:00:02Z',
            runId: beginCommand('pending-control').runId,
            ownerEpoch,
            generation: 1,
            message: 'Keep going',
          }),
        ),
      )
      caller = operation
      await Effect.runPromise(Deferred.await(entered))
      const otherEpoch = await runtime.runPromise(
        host.withExecution((_service, ownerEpoch) => Effect.succeed(ownerEpoch)).pipe(Effect.timeout(250)),
      )
      expect(otherEpoch).toBe(1)
      const worker = workers[0]
      if (!worker) throw new Error('worker missing')
      const failedAt = Date.now()
      worker.emit('error', new Error('injected unresolved native control failure'))
      await Effect.runPromise(Deferred.await(retired).pipe(Effect.timeout(500)))
      expect(Date.now() - failedAt).toBeLessThan(250)
      const outcome = await Effect.runPromise(Fiber.await(operation))
      expect(Exit.isFailure(outcome)).toBe(true)
      if (Exit.isFailure(outcome)) {
        expect(outcome.cause.reasons.filter(Cause.isFailReason).map(reason => reason.error)).toContainEqual(
          expect.objectContaining({ _tag: 'WorkspaceStoreError', code: 'database-unavailable' }),
        )
      }
      await expect
        .poll(() => Effect.runPromise(SubscriptionRef.get(host.status)), { timeout: 12_000 })
        .toMatchObject({ state: 'ready', ownerEpoch: 2 })
      const recovered = await runtime.runPromise(host.store.listSteerIntents(input.task.id))
      expect(recovered.items).toMatchObject([
        { commandId: 'stalled-steer', state: 'uncertain', recoveryReason: 'worker-replaced' },
      ])
      expect(nativeSteers).toBe(1)
      expect(submissions).toEqual(['run-pending-control'])
      expect(closes).toEqual(['native-close'])
    } finally {
      if (caller) await Effect.runPromise(Fiber.interrupt(caller))
      await runtime.dispose().catch(() => {})
    }
  }, 20_000)

  it('closes the old native run before advancing the epoch, then runs an independent task without replay', async () => {
    const submissions: Array<string> = []
    const closeOrder: Array<string> = []
    const closes = closeOrder
    const registry = fakeRegistry(submissions, closes, Effect.void)
    const { runtime, workers } = fixture('active-replacement', undefined, registry, closeOrder)
    const host = await runtime.runPromise(WorkspaceHost)
    const first = workspace('first')
    const second = workspace('second')
    try {
      await runtime.runPromise(host.store.registerProject({ project: first.project, mainCheckout: first.checkout }))
      await runtime.runPromise(host.store.createTask({ task: first.task, conversation: first.conversation }))
      await runtime.runPromise(host.store.registerProject({ project: second.project, mainCheckout: second.checkout }))
      await runtime.runPromise(host.store.createTask({ task: second.task, conversation: second.conversation }))
      await runtime.runPromise(host.withExecution(service => service.start(beginCommand('first'))))
      await expect.poll(() => submissions).toEqual(['run-first'])
      await expect
        .poll(async () => (await runtime.runPromise(host.store.pageEvents(0, 20))).events.map(event => event.kind))
        .toContain('runStarted')
      const failedWorker = workers[0]
      if (!failedWorker) throw new Error('worker missing')
      closeOrder.length = 0
      failedWorker.emit('error', new Error('injected worker fault'))
      await expect
        .poll(() => Effect.runPromise(SubscriptionRef.get(host.status)), { timeout: 12_000 })
        .toMatchObject({ state: 'ready', ownerEpoch: 2 })
      const page = await runtime.runPromise(host.store.pageEvents(0, 100))
      await expect.poll(() => Effect.runPromise(SubscriptionRef.get(host.eventHighWatermark))).toBe(page.highWatermark)
      expect(closes).toContain('native-close')
      expect(closeOrder).toEqual(['native-close', 'worker-close', 'worker-start'])
      const recovered = await runtime.runPromise(host.store.readTaskSnapshot(first.task.id, 10))
      expect(recovered.runs).toMatchObject([{ id: 'run-first', status: 'recoveryRequired' }])
      expect(submissions).toEqual(['run-first'])

      closeOrder.length = 0
      await runtime.runPromise(host.withExecution(service => service.start(beginCommand('second'))))
      await expect.poll(() => submissions).toEqual(['run-first', 'run-second'])
      await runtime.dispose()
      expect(closeOrder).toEqual(['native-close', 'worker-close'])
      expect(submissions).toEqual(['run-first', 'run-second'])
    } finally {
      await runtime.dispose().catch(() => {})
    }
  }, 20_000)

  it('reports unconfirmed native cleanup on application close while still shutting down its worker', async () => {
    const submissions: Array<string> = []
    const order: Array<string> = []
    const releaseNativeClose = Deferred.makeUnsafe<undefined>()
    const registry = fakeRegistry(submissions, order, Deferred.await(releaseNativeClose))
    const { runtime, workers } = fixture('unconfirmed-shutdown', undefined, registry, order)
    try {
      const host = await runtime.runPromise(WorkspaceHost)
      const input = workspace('shutdown')
      await runtime.runPromise(host.store.registerProject({ project: input.project, mainCheckout: input.checkout }))
      await runtime.runPromise(host.store.createTask({ task: input.task, conversation: input.conversation }))
      await runtime.runPromise(host.withExecution(service => service.start(beginCommand('shutdown'))))
      await expect.poll(() => submissions).toEqual(['run-shutdown'])
      order.length = 0
      await expect(runtime.dispose()).rejects.toMatchObject({
        _tag: 'ExecutionServiceError',
        nativeCleanup: 'unconfirmed',
      })
      expect(order).toEqual(['native-close', 'worker-close'])
      expect(workers[0]?.threadId).toBe(-1)
    } finally {
      await Effect.runPromise(Deferred.succeed(releaseNativeClose, undefined))
      await runtime.dispose().catch(() => {})
    }
  }, 15_000)

  it('blocks a replacement execution when native cleanup remains unconfirmed', async () => {
    const submissions: Array<string> = []
    const closes: Array<string> = []
    const releaseNativeClose = Deferred.makeUnsafe<undefined>()
    const registry = fakeRegistry(submissions, closes, Deferred.await(releaseNativeClose))
    const { runtime, workers } = fixture('active-replacement-unknown', undefined, registry, undefined)
    const host = await runtime.runPromise(WorkspaceHost)
    const first = workspace('unknown-first')
    const second = workspace('unknown-second')
    try {
      await runtime.runPromise(host.store.registerProject({ project: first.project, mainCheckout: first.checkout }))
      await runtime.runPromise(host.store.createTask({ task: first.task, conversation: first.conversation }))
      await runtime.runPromise(host.store.registerProject({ project: second.project, mainCheckout: second.checkout }))
      await runtime.runPromise(host.store.createTask({ task: second.task, conversation: second.conversation }))
      await runtime.runPromise(host.withExecution(service => service.start(beginCommand('unknown-first'))))
      await expect.poll(() => submissions).toEqual(['run-unknown-first'])
      await expect
        .poll(async () => (await runtime.runPromise(host.store.pageEvents(0, 20))).events.map(event => event.kind))
        .toContain('runStarted')
      const failedWorker = workers[0]
      if (!failedWorker) throw new Error('worker missing')
      await failedWorker.terminate()
      await expect
        .poll(() => Effect.runPromise(SubscriptionRef.get(host.status)), { timeout: 12_000 })
        .toMatchObject({ state: 'unavailable' })
      expect(workers).toHaveLength(1)
      await expect(
        runtime.runPromise(host.withExecution(service => service.start(beginCommand('unknown-second')))),
      ).rejects.toMatchObject({ _tag: 'ExecutionServiceError', nativeCleanup: 'unconfirmed' })
      expect(submissions).toEqual(['run-unknown-first'])
      await expect(runtime.dispose()).rejects.toMatchObject({
        _tag: 'ExecutionServiceError',
        nativeCleanup: 'unconfirmed',
      })
      expect(workers[0]?.threadId).toBe(-1)
    } finally {
      await Effect.runPromise(Deferred.succeed(releaseNativeClose, undefined))
      await runtime.dispose().catch(() => {})
    }
  }, 20_000)
})
