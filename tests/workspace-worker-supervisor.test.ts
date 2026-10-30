import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import * as Effect from 'effect/Effect'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as SubscriptionRef from 'effect/SubscriptionRef'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  WorkspaceWorkerSupervisor,
  WorkspaceWorkerSupervisorLive,
  type WorkspaceWorkerSupervisorOptions,
} from '@/platform/electron/main/workspace/supervisor.js'

const timestamp = '2026-10-29T10:00:00Z'
const project = {
  id: 'supervised-project' as never,
  name: 'Supervised',
  repositoryIdentity: 'repo:supervised',
  createdAt: timestamp,
  updatedAt: timestamp,
}
const checkout = {
  id: 'supervised-checkout' as never,
  kind: 'main' as const,
  path: 'C:/supervised',
  createdAt: timestamp,
}
let directory = ''
let workerPath = ''

beforeAll(async () => {
  const cache = resolve('node_modules/.cache')
  await mkdir(cache, { recursive: true })
  directory = await mkdtemp(join(cache, 'workspace-supervisor-'))
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

const fixture = (name: string, options: Partial<WorkspaceWorkerSupervisorOptions> = {}) => {
  const workers: Array<Worker> = []
  const runtime = ManagedRuntime.make(
    WorkspaceWorkerSupervisorLive({
      filename: join(directory, `${name}.db`),
      workerPath,
      ...options,
      workerFactory: (path, data) => {
        const worker = options.workerFactory
          ? options.workerFactory(path, data)
          : new Worker(path, { workerData: data })
        workers.push(worker)
        return worker
      },
      restartBackoffMs: options.restartBackoffMs ?? 20,
    }),
  )
  return { runtime, workers }
}

describe('workspace worker supervisor', () => {
  it('advances its durable owner epoch across a complete application runtime restart', async () => {
    const first = fixture('application-restart')
    await first.runtime.runPromise(WorkspaceWorkerSupervisor)
    await first.runtime.dispose()

    const restarted = fixture('application-restart')
    try {
      const supervisor = await restarted.runtime.runPromise(WorkspaceWorkerSupervisor)
      expect(await Effect.runPromise(SubscriptionRef.get(supervisor.ownerEpoch))).toBe(2)
      expect(restarted.workers).toHaveLength(1)
    } finally {
      await restarted.runtime.dispose()
    }
  }, 15_000)

  it('starts one scoped worker and exposes a stable usable store with its durable owner epoch', async () => {
    const { runtime, workers } = fixture('start')
    try {
      const supervisor = await runtime.runPromise(WorkspaceWorkerSupervisor)
      expect(await Effect.runPromise(SubscriptionRef.get(supervisor.status))).toEqual({
        state: 'ready',
        lastFailure: null,
      })
      expect(await Effect.runPromise(SubscriptionRef.get(supervisor.ownerEpoch))).toBe(1)
      await Effect.runPromise(supervisor.store.registerProject({ project, mainCheckout: checkout }))
      expect(workers).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
    expect(workers[0]?.threadId).toBe(-1)
    expect(workers).toHaveLength(1)
  }, 15_000)
  it.each(['claimed', 'accepted'] as const)(
    'replaces a dead owner once and recovers its %s dispatch without redispatch',
    async delivery => {
      const { runtime, workers } = fixture(`recovery-${delivery}`)
      try {
        const supervisor = await runtime.runPromise(WorkspaceWorkerSupervisor)
        const store = supervisor.store
        const task = {
          id: 'recovery-task' as never,
          projectId: project.id,
          title: 'Recover',
          description: '',
          createdAt: timestamp,
        }
        const conversation = { id: 'recovery-conversation' as never, title: 'Recovery', createdAt: timestamp }
        const runId = 'recovery-run' as never
        await Effect.runPromise(store.registerProject({ project, mainCheckout: checkout }))
        await Effect.runPromise(store.createTask({ task, conversation }))
        await Effect.runPromise(
          store.beginRun({
            commandId: 'recovery-command',
            issuedAt: timestamp,
            runId,
            taskId: task.id,
            conversationId: conversation.id,
            checkoutId: checkout.id,
            provisionalAgentSessionId: 'recovery-session',
            generation: 1,
            driverId: 'test-driver',
            connectionId: 'test-connection',
            prompt: 'Recover safely',
          }),
        )
        await Effect.runPromise(store.claimDispatch(runId, 1, timestamp))
        if (delivery === 'accepted')
          await Effect.runPromise(
            store.acknowledgeDispatch(runId, {
              ownerEpoch: 1,
              nativeSessionId: 'native-recovery',
              acknowledgedAt: timestamp,
            }),
          )
        const worker = workers[0]
        if (!worker) throw new Error('worker missing')
        await worker.terminate()
        await expect
          .poll(() => Effect.runPromise(SubscriptionRef.get(supervisor.ownerEpoch)), { timeout: 5_000 })
          .toBe(2)
        expect(supervisor.store).toBe(store)
        expect(workers).toHaveLength(2)
        const snapshot = await Effect.runPromise(store.readTaskSnapshot(task.id, 10))
        expect(snapshot.runs).toMatchObject([
          { id: runId, status: delivery === 'accepted' ? 'recoveryRequired' : 'uncertain' },
        ])
        const events = await Effect.runPromise(store.pageEvents(0, 100))
        expect(
          events.events.filter(
            event => event.kind === (delivery === 'accepted' ? 'runRecoveryRequired' : 'runUncertain'),
          ),
        ).toMatchObject([{ data: { replacedEpoch: 1 } }])
        expect(events.events.filter(event => event.kind === 'dispatchClaimed')).toHaveLength(1)
      } finally {
        await runtime.dispose()
      }
    },
    15_000,
  )

  it('exhausts its bounded replacement budget and fails calls with a typed sanitized error', async () => {
    const { runtime, workers } = fixture('budget', { maxReplacements: 1, restartWindowMs: 60_000 })
    try {
      const supervisor = await runtime.runPromise(WorkspaceWorkerSupervisor)
      const first = workers[0]
      if (!first) throw new Error('worker missing')
      await first.terminate()
      await expect.poll(() => Effect.runPromise(SubscriptionRef.get(supervisor.ownerEpoch)), { timeout: 5_000 }).toBe(2)
      const second = workers[1]
      if (!second) throw new Error('replacement missing')
      await second.terminate()
      await expect
        .poll(() => Effect.runPromise(SubscriptionRef.get(supervisor.status)), { timeout: 5_000 })
        .toMatchObject({ state: 'unavailable', lastFailure: 'Workspace storage is unavailable.' })
      await expect(Effect.runPromise(supervisor.store.pageEvents(0, 10))).rejects.toMatchObject({
        _tag: 'WorkspaceStoreError',
        code: 'database-unavailable',
        message: 'Workspace storage is unavailable.',
      })
      expect(workers).toHaveLength(2)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)
  it('fails an in-flight committed mutation on death without ever resending it', async () => {
    let mutationMessages = 0
    const { runtime, workers } = fixture('in-flight', {
      workerFactory: (path, data) => {
        const worker = new Worker(path, { workerData: data })
        const postMessage = worker.postMessage.bind(worker)
        worker.postMessage = (...args: Parameters<Worker['postMessage']>) => {
          if (JSON.stringify(args[0]).includes('flight-command')) mutationMessages += 1
          postMessage(...args)
        }
        return worker
      },
    })
    try {
      const supervisor = await runtime.runPromise(WorkspaceWorkerSupervisor)
      const store = supervisor.store
      const task = {
        id: 'flight-task' as never,
        projectId: project.id,
        title: 'Flight',
        description: '',
        createdAt: timestamp,
      }
      const conversation = { id: 'flight-conversation' as never, title: 'Flight', createdAt: timestamp }
      await Effect.runPromise(store.registerProject({ project, mainCheckout: checkout }))
      await Effect.runPromise(store.createTask({ task, conversation }))
      const worker = workers[0]
      if (!worker) throw new Error('worker missing')
      let responseArrived!: () => void
      const response = new Promise<void>(resolve => {
        responseArrived = resolve
      })
      const emit = worker.emit.bind(worker)
      // Cut the transport after the real worker committed, before the client receives its reply.
      worker.emit = (event: string | symbol, ...args: Array<unknown>): boolean => {
        if (event === 'message') {
          responseArrived()
          return true
        }
        return Reflect.apply(emit, worker, [event, ...args]) as boolean
      }
      const pending = Effect.runPromise(
        store.beginRun({
          commandId: 'flight-command',
          issuedAt: timestamp,
          runId: 'flight-run' as never,
          taskId: task.id,
          conversationId: conversation.id,
          checkoutId: checkout.id,
          provisionalAgentSessionId: 'flight-session',
          generation: 1,
          driverId: 'test-driver',
          connectionId: 'test-connection',
          prompt: 'Do not resend',
        }),
      )
      const rejected = expect(pending).rejects.toMatchObject({
        _tag: 'WorkspaceStoreError',
        code: 'database-unavailable',
      })
      await response
      await worker.terminate()
      await rejected
      await expect.poll(() => Effect.runPromise(SubscriptionRef.get(supervisor.ownerEpoch)), { timeout: 5_000 }).toBe(2)
      const snapshot = await Effect.runPromise(store.readTaskSnapshot(task.id, 10))
      expect(snapshot.runs).toMatchObject([{ id: 'flight-run', status: 'queued' }])
      const page = await Effect.runPromise(store.pageEvents(0, 100))
      expect(page.events.map(event => event.kind)).toEqual(['runQueued'])
      expect(mutationMessages).toBe(1)
      expect(workers).toHaveLength(2)
    } finally {
      await runtime.dispose()
    }
  }, 15_000)

  it('reports unconfirmed native cleanup and never replaces an intentionally closing worker', async () => {
    const { runtime, workers } = fixture('cleanup-failure', { closeTimeoutMs: 100 })
    const supervisor = await runtime.runPromise(WorkspaceWorkerSupervisor)
    const worker = workers[0]
    if (!worker) throw new Error('worker missing')
    const terminate = worker.terminate.bind(worker)
    worker.postMessage = () => {}
    worker.terminate = () => new Promise<number>(() => {})
    try {
      await expect(runtime.dispose()).rejects.toMatchObject({
        _tag: 'WorkspaceStoreError',
        code: 'database-unavailable',
        message: 'Workspace worker cleanup did not complete.',
      })
      expect(await Effect.runPromise(SubscriptionRef.get(supervisor.status))).toEqual({
        state: 'stopped',
        lastFailure: 'Workspace worker cleanup did not complete.',
      })
      expect(workers).toHaveLength(1)
    } finally {
      await terminate()
      await runtime.dispose().catch(() => {})
    }
  }, 5_000)
  it('retains failed replacement-cleanup uncertainty through final scope disposal', async () => {
    const { runtime, workers } = fixture('replacement-cleanup', { closeTimeoutMs: 100 })
    const supervisor = await runtime.runPromise(WorkspaceWorkerSupervisor)
    const worker = workers[0]
    if (!worker) throw new Error('worker missing')
    const terminate = worker.terminate.bind(worker)
    worker.postMessage = () => {}
    worker.terminate = () => new Promise<number>(() => {})
    try {
      worker.emit('error', new Error('private worker failure details'))
      await expect
        .poll(() => Effect.runPromise(SubscriptionRef.get(supervisor.status)), { timeout: 3_000 })
        .toEqual({ state: 'unavailable', lastFailure: 'Workspace worker cleanup did not complete.' })
      await expect(runtime.dispose()).rejects.toMatchObject({
        _tag: 'WorkspaceStoreError',
        code: 'database-unavailable',
        message: 'Workspace worker cleanup did not complete.',
      })
      expect(workers).toHaveLength(1)
    } finally {
      await terminate()
      await runtime.dispose().catch(() => {})
    }
  }, 5_000)

  it('backs off failed real-thread replacement attempts before entering terminal unavailability', async () => {
    const starts: Array<number> = []
    const { runtime, workers } = fixture('failed-restarts', {
      maxReplacements: 2,
      restartBackoffMs: 40,
      workerFactory: (path, data) => {
        starts.push(Date.now())
        return starts.length === 1
          ? new Worker(path, { workerData: data })
          : new Worker('throw new Error("private startup details")', { eval: true })
      },
    })
    try {
      const supervisor = await runtime.runPromise(WorkspaceWorkerSupervisor)
      const worker = workers[0]
      if (!worker) throw new Error('worker missing')
      await worker.terminate()
      await expect
        .poll(() => Effect.runPromise(SubscriptionRef.get(supervisor.status)), { timeout: 5_000 })
        .toEqual({ state: 'unavailable', lastFailure: 'Workspace storage is unavailable.' })
      expect(workers).toHaveLength(3)
      const [, firstReplacement, secondReplacement] = starts
      expect(firstReplacement).toBeDefined()
      expect(secondReplacement).toBeDefined()
      expect(Number(secondReplacement) - Number(firstReplacement)).toBeGreaterThanOrEqual(35)
      expect(await Effect.runPromise(SubscriptionRef.get(supervisor.ownerEpoch))).toBe(1)
      await expect(Effect.runPromise(supervisor.store.pageEvents(0, 10))).rejects.toMatchObject({
        code: 'database-unavailable',
      })
    } finally {
      await runtime.dispose()
    }
  }, 10_000)

  it('cancels replacement backoff during scoped shutdown without starting another worker', async () => {
    const { runtime, workers } = fixture('close-backoff', { restartBackoffMs: 2_000 })
    const supervisor = await runtime.runPromise(WorkspaceWorkerSupervisor)
    try {
      const worker = workers[0]
      if (!worker) throw new Error('worker missing')
      await worker.terminate()
      await expect
        .poll(() => Effect.runPromise(SubscriptionRef.get(supervisor.status)), { timeout: 1_000 })
        .toMatchObject({ state: 'replacing' })
      await runtime.dispose()
      expect(await Effect.runPromise(SubscriptionRef.get(supervisor.status))).toMatchObject({ state: 'stopped' })
      expect(workers).toHaveLength(1)
      await expect(Effect.runPromise(supervisor.store.pageEvents(0, 10))).rejects.toMatchObject({
        code: 'database-unavailable',
      })
    } finally {
      await runtime.dispose()
    }
  }, 5_000)
  it.each(['initial', 'replacement'] as const)(
    'blocks another writer after %s acquisition cannot confirm cleanup and retains the cause through disposal',
    async phase => {
      let starts = 0
      const terminateUnconfirmed: Array<() => Promise<number>> = []
      const { runtime, workers } = fixture(`acquisition-unconfirmed-${phase}`, {
        initializationTimeoutMs: 5_000,
        workerFactory: (path, data) => {
          starts += 1
          if (phase === 'replacement' && starts === 1) return new Worker(path, { workerData: data })
          const worker = new Worker('setInterval(() => {}, 1_000)', { eval: true })
          terminateUnconfirmed.push(worker.terminate.bind(worker))
          worker.terminate = () => new Promise<number>(() => {})
          return worker
        },
      })
      try {
        const supervisor = await runtime.runPromise(WorkspaceWorkerSupervisor)
        if (phase === 'replacement') {
          const worker = workers[0]
          if (!worker) throw new Error('worker missing')
          await worker.terminate()
        }
        await expect
          .poll(() => Effect.runPromise(SubscriptionRef.get(supervisor.status)), { timeout: 12_000 })
          .toEqual({ state: 'unavailable', lastFailure: 'Workspace worker cleanup did not complete.' })
        expect(workers).toHaveLength(phase === 'initial' ? 1 : 2)
        const unconfirmed = workers.at(-1)
        expect(unconfirmed?.threadId).not.toBe(-1)
        await expect(Effect.runPromise(supervisor.store.pageEvents(0, 10))).rejects.toMatchObject({
          code: 'database-unavailable',
        })
        await expect(runtime.dispose()).rejects.toMatchObject({
          _tag: 'WorkspaceStoreError',
          code: 'database-unavailable',
          message: 'Workspace worker cleanup did not complete.',
        })
        expect(await Effect.runPromise(SubscriptionRef.get(supervisor.status))).toMatchObject({
          state: 'stopped',
          lastFailure: 'Workspace worker cleanup did not complete.',
        })
        expect(workers).toHaveLength(phase === 'initial' ? 1 : 2)
      } finally {
        await Promise.all(terminateUnconfirmed.map(terminate => terminate()))
        await runtime.dispose().catch(() => {})
      }
    },
    25_000,
  )

  it('continues within budget after a failed startup confirms native cleanup', async () => {
    let starts = 0
    const { runtime, workers } = fixture('acquisition-confirmed', {
      initializationTimeoutMs: 5_000,
      maxReplacements: 2,
      workerFactory: (path, data) => {
        starts += 1
        if (starts !== 2) return new Worker(path, { workerData: data })
        const worker = new Worker('setInterval(() => {}, 1_000)', { eval: true })
        return worker
      },
    })
    try {
      const supervisor = await runtime.runPromise(WorkspaceWorkerSupervisor)
      await Effect.runPromise(supervisor.store.registerProject({ project, mainCheckout: checkout }))
      const initial = workers[0]
      if (!initial) throw new Error('worker missing')
      await initial.terminate()
      await expect
        .poll(() => Effect.runPromise(SubscriptionRef.get(supervisor.ownerEpoch)), { timeout: 12_000 })
        .toBe(2)
      expect(await Effect.runPromise(SubscriptionRef.get(supervisor.status))).toEqual({
        state: 'ready',
        lastFailure: null,
      })
      expect(workers).toHaveLength(3)
      expect(workers[1]?.threadId).toBe(-1)
      await expect(Effect.runPromise(supervisor.store.pageEvents(0, 10))).resolves.toMatchObject({ events: [] })
      await runtime.dispose()
      expect(workers.every(worker => worker.threadId === -1)).toBe(true)
    } finally {
      await runtime.dispose()
    }
  }, 25_000)
})
