import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vitest'

import { ExecutionService, type ExecutionServiceOptions } from '@/core/application/commands/execution-service.js'
import {
  AgentDriver,
  type AgentDriverConnection,
  AgentDriverError,
  type AgentDriverSession,
  type AgentSessionContext,
} from '@/core/ports/agent-driver.js'
import { AgentDriverRegistry } from '@/core/ports/agent-driver-registry.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import type { AgentCapabilities, AgentDriverEvent } from '@/shared/schemas/execution.js'
import { type BeginRunCommand, WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

type RunEffect = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
type DriverConnect = AgentDriver['Service']['connect']

const project = {
  id: 'project-1' as never,
  name: 'Project',
  repositoryIdentity: 'repo:one',
  createdAt: '2026-10-29T10:00:00Z',
  updatedAt: '2026-10-29T10:00:00Z',
}
const checkout = {
  id: 'checkout-1' as never,
  kind: 'main' as const,
  path: 'C:/repo',
  createdAt: '2026-10-29T10:00:00Z',
}
const task = {
  id: 'task-1' as never,
  projectId: project.id,
  title: 'Task',
  description: '',
  createdAt: '2026-10-29T10:00:00Z',
}
const conversation = { id: 'conversation-1' as never, title: 'Conversation', createdAt: '2026-10-29T10:00:00Z' }
const command: BeginRunCommand = {
  commandId: 'command-1',
  issuedAt: '2026-10-29T10:00:01Z',
  runId: 'run-1' as never,
  taskId: task.id,
  conversationId: conversation.id,
  checkoutId: checkout.id,
  provisionalAgentSessionId: 'session-1',
  generation: 1,
  driverId: 'test-driver',
  connectionId: 'connection-1',
  prompt: 'Fix the bug',
}

const supported = { support: 'supported' as const, restrictions: [], evidence: [{ source: 'driver' as const }] }
const capabilities: AgentCapabilities = {
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

const makeSession = (overrides: Partial<AgentDriverSession> = {}): AgentDriverSession => ({
  identity: { nativeSessionId: 'native-session', generation: 1 },
  capabilities,
  events: () => Stream.empty,
  submit: () => Effect.succeed({ nativeSessionId: 'native-session', nativeTurnId: 'native-turn', generation: 1 }),
  interrupt: () => Effect.succeed({ acknowledged: true, termination: 'stillRunning' }),
  steer: () => Effect.succeed({ outcome: 'accepted' as const }),
  respond: () => Effect.succeed({ outcome: 'accepted' as const }),
  reconcile: () => Stream.empty,
  ...overrides,
})

const makeConnection = (
  session: AgentDriverSession,
  overrides: Partial<AgentDriverConnection> = {},
): AgentDriverConnection => ({
  identity: { id: 'connection-1', driverId: 'test-driver', authentication: 'authenticated' },
  discover: () => Effect.succeed(capabilities),
  openSession: () => Effect.succeed(session),
  loadSession: () => Effect.succeed(session),
  close: () => Effect.void,
  ...overrides,
})

const makeRuntime = (
  connect: DriverConnect,
  options: Partial<ExecutionServiceOptions> = {},
  storeService?: WorkspaceStore['Service'],
  additionalDrivers: ReadonlyArray<AgentDriver['Service']> = [],
) =>
  ManagedRuntime.make(
    Layer.provideMerge(
      ExecutionService.layer({ ownerEpoch: 7, ...options }),
      Layer.merge(
        storeService ? Layer.succeed(WorkspaceStore, storeService) : WorkspaceStoreLive({ filename: ':memory:' }),
        Layer.succeed(
          AgentDriverRegistry,
          AgentDriverRegistry.fromDrivers([AgentDriver.of({ driverId: 'test-driver', connect }), ...additionalDrivers]),
        ),
      ),
    ),
  )

const setup = async (store: WorkspaceStore['Service'], run: RunEffect) => {
  await run(store.registerProject({ project, mainCheckout: checkout }))
  await run(store.createTask({ task, conversation }))
}

describe('ExecutionService', () => {
  it('routes runs to their own drivers and isolates cancellation and connection cleanup', async () => {
    const firstStarted = await Effect.runPromise(Deferred.make<undefined>())
    const secondStarted = await Effect.runPromise(Deferred.make<undefined>())
    const firstTerminal = await Effect.runPromise(Deferred.make<undefined>())
    const secondTerminal = await Effect.runPromise(Deferred.make<undefined>())
    const firstClosed = await Effect.runPromise(Deferred.make<undefined>())
    const firstSubmitted: string[] = []
    const secondSubmitted: string[] = []
    const firstConnections: string[] = []
    const secondConnections: string[] = []
    const closed: string[] = []
    let secondInterrupts = 0
    const firstSession = makeSession({
      submit: input => {
        firstSubmitted.push(input.runId)
        return Effect.succeed({ nativeSessionId: 'native-session', nativeTurnId: 'native-turn', generation: 1 })
      },
      events: () =>
        Stream.fromEffect(
          Effect.gen(function* () {
            yield* Deferred.succeed(firstStarted, undefined)
            yield* Deferred.await(firstTerminal)
            return { kind: 'turnInterrupted', nativeTurnId: 'native-turn' } as const
          }),
        ),
      interrupt: () =>
        Effect.as(Deferred.succeed(firstTerminal, undefined), {
          acknowledged: true,
          termination: 'stillRunning' as const,
        }),
    })
    const secondSession = makeSession({
      submit: input => {
        secondSubmitted.push(input.runId)
        return Effect.succeed({ nativeSessionId: 'native-session', nativeTurnId: 'native-turn', generation: 1 })
      },
      events: () =>
        Stream.fromEffect(
          Effect.gen(function* () {
            yield* Deferred.succeed(secondStarted, undefined)
            yield* Deferred.await(secondTerminal)
            return { kind: 'turnCompleted', nativeTurnId: 'native-turn' } as const
          }),
        ),
      interrupt: () => {
        secondInterrupts += 1
        return Effect.succeed({ acknowledged: true, termination: 'stillRunning' as const })
      },
    })
    const secondDriver = AgentDriver.of({
      driverId: 'other-driver',
      connect: options =>
        Effect.sync(() => {
          secondConnections.push(options.connectionId)
          return makeConnection(secondSession, {
            identity: { id: options.connectionId, driverId: 'other-driver', authentication: 'authenticated' },
            close: () => Effect.sync(() => void closed.push('other-driver')),
          })
        }),
    })
    const runtime = makeRuntime(
      options =>
        Effect.sync(() => {
          firstConnections.push(options.connectionId)
          return makeConnection(firstSession, {
            close: () =>
              Effect.gen(function* () {
                closed.push('test-driver')
                yield* Deferred.succeed(firstClosed, undefined)
              }),
          })
        }),
      {},
      undefined,
      [secondDriver],
    )
    const otherProject = { ...project, id: 'project-2' as never, repositoryIdentity: 'repo:two' }
    const otherCheckout = { ...checkout, id: 'checkout-2' as never, path: 'C:/other-repo' }
    const otherTask = { ...task, id: 'task-2' as never, projectId: otherProject.id }
    const otherConversation = { ...conversation, id: 'conversation-2' as never }
    const otherCommand = {
      ...command,
      commandId: 'other-command',
      runId: 'other-run' as never,
      taskId: otherTask.id,
      conversationId: otherConversation.id,
      checkoutId: otherCheckout.id,
      provisionalAgentSessionId: 'other-session',
      driverId: 'other-driver',
      connectionId: 'connection-2',
    }

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      await run(store.registerProject({ project: otherProject, mainCheckout: otherCheckout }))
      await run(store.createTask({ task: otherTask, conversation: otherConversation }))
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start(command))
      await run(service.start(otherCommand))
      await run(Deferred.await(firstStarted))
      await run(Deferred.await(secondStarted))

      expect([firstSubmitted, secondSubmitted]).toEqual([['run-1'], ['other-run']])
      expect([firstConnections, secondConnections]).toEqual([['connection-1'], ['connection-2']])
      await run(service.interrupt(command.runId))
      await run(Deferred.await(firstClosed))

      expect(secondInterrupts).toBe(0)
      expect(closed).toEqual(['test-driver'])
      expect((await run(store.readTaskSnapshot(task.id, 10))).runs[0]?.status).toBe('interrupted')
      expect((await run(store.readTaskSnapshot(otherTask.id, 10))).runs[0]?.status).toBe('running')
      await run(Deferred.succeed(secondTerminal, undefined))
      await run(service.stopAll())
      expect(closed).toEqual(['test-driver', 'other-driver'])
      expect((await run(store.readTaskSnapshot(otherTask.id, 10))).runs[0]?.status).toBe('completed')
    } finally {
      await Effect.runPromise(Deferred.succeed(firstTerminal, undefined))
      await Effect.runPromise(Deferred.succeed(secondTerminal, undefined))
      await runtime.dispose()
    }
  })

  it.each([
    { mismatch: 'driver' as const, expectedConnects: 0 },
    { mismatch: 'connection' as const, expectedConnects: 1 },
  ])('rejects a $mismatch identity mismatch before native dispatch', async ({ mismatch, expectedConnects }) => {
    let connectCalls = 0
    let openCalls = 0
    let loadCalls = 0
    let submitCalls = 0
    const session = makeSession({
      submit: () => {
        submitCalls += 1
        return Effect.succeed({ nativeSessionId: 'native-session', nativeTurnId: 'native-turn', generation: 1 })
      },
    })
    const connection = makeConnection(session, {
      identity:
        mismatch === 'connection'
          ? { id: 'wrong-connection', driverId: 'wrong-driver', authentication: 'authenticated' }
          : { id: 'connection-1', driverId: 'test-driver', authentication: 'authenticated' },
      openSession: () => {
        openCalls += 1
        return Effect.succeed(session)
      },
      loadSession: () => {
        loadCalls += 1
        return Effect.succeed(session)
      },
    })
    const runtime = makeRuntime(() => {
      connectCalls += 1
      return Effect.succeed(connection)
    })

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(
        service.start({
          ...command,
          commandId: `identity-${mismatch}`,
          runId: `identity-${mismatch}-run` as never,
          ...(mismatch === 'driver' ? { driverId: 'wrong-driver' } : {}),
        }),
      )
      await run(service.stopAll())

      expect(connectCalls).toBe(expectedConnects)
      expect(openCalls).toBe(0)
      expect(loadCalls).toBe(0)
      expect(submitCalls).toBe(0)
      expect((await run(store.readTaskSnapshot(task.id, 10))).runs[0]).toMatchObject({
        status: 'failed',
        failure: 'launch-failed',
      })
    } finally {
      await runtime.dispose()
    }
  })

  it('settles an unregistered driver before native calls so it leaves no recoverable dispatch', async () => {
    let connectCalls = 0
    let submitCalls = 0
    const session = makeSession({
      submit: () => {
        submitCalls += 1
        return Effect.die(new Error('An unregistered driver must not submit'))
      },
    })
    const runtime = makeRuntime(() => {
      connectCalls += 1
      return Effect.succeed(makeConnection(session))
    })

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start({ ...command, driverId: 'unregistered-driver' }))
      await run(service.stopAll())

      expect(connectCalls).toBe(0)
      expect(submitCalls).toBe(0)
      expect((await run(store.readTaskSnapshot(task.id, 10))).runs[0]).toMatchObject({
        status: 'failed',
        failure: 'launch-failed',
      })
      expect(await run(store.recoverWorker(7, '2026-10-29T10:00:02Z'))).toBe(0)
      expect(
        await run(
          store.beginRun({
            ...command,
            commandId: 'after-unregistered',
            runId: 'after-unregistered-run' as never,
            provisionalAgentSessionId: 'after-unregistered-session',
          }),
        ),
      ).toMatchObject({ replayed: false })
    } finally {
      await runtime.dispose()
    }
  })

  it('returns an exact replay while the concurrency limit is exhausted', async () => {
    const streamStarted = await Effect.runPromise(Deferred.make<undefined>())
    const releaseStream = await Effect.runPromise(Deferred.make<undefined>())
    const session = makeSession({
      events: () =>
        Stream.fromEffect(
          Effect.gen(function* () {
            yield* Deferred.succeed(streamStarted, undefined)
            yield* Deferred.await(releaseStream)
            return { kind: 'turnCompleted', nativeTurnId: 'native-turn' } as const
          }),
        ),
    })
    const runtime = makeRuntime(() => Effect.succeed(makeConnection(session)), { maxConcurrentRuns: 1 })
    let replay: Promise<Awaited<ReturnType<RunEffect>>> | undefined

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start(command))
      await run(Deferred.await(streamStarted))

      replay = runtime.runPromise(service.start(command))
      const returnedBeforeRelease = await Promise.race([
        replay.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50)),
      ])
      expect(returnedBeforeRelease).toBe(true)
      await run(Deferred.succeed(releaseStream, undefined))
      expect(await replay).toMatchObject({ replayed: true, runId: command.runId })
      await run(service.stopAll())
    } finally {
      await Effect.runPromise(Deferred.succeed(releaseStream, undefined))
      await runtime.dispose()
    }
  })

  it('settles a committed run when claiming fails before native dispatch', async () => {
    const storeRuntime = ManagedRuntime.make(WorkspaceStoreLive({ filename: ':memory:' }))
    const baseStore = await storeRuntime.runPromise(WorkspaceStore)
    const claimError = new WorkspaceStoreError({ code: 'database-unavailable', message: 'claim failed' })
    const failureCalls: Array<unknown> = []
    const storeService = WorkspaceStore.of({
      ...baseStore,
      claimDispatch: () => Effect.fail(claimError),
      failDispatch: (runId, failure) =>
        Effect.gen(function* () {
          failureCalls.push({ runId, failure })
          yield* baseStore.failDispatch(runId, failure)
        }),
    })
    let connectCalls = 0
    const runtime = makeRuntime(
      () => {
        connectCalls += 1
        return Effect.die(new Error('Claim failure must not connect'))
      },
      {},
      storeService,
    )

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)

      await expect(run(service.start({ ...command, commandId: 'claim-failure' }))).rejects.toBe(claimError)

      expect(connectCalls).toBe(0)
      expect(failureCalls).toEqual([
        {
          runId: command.runId,
          failure: expect.objectContaining({
            ownerEpoch: 7,
            outcome: 'failed',
            reason: 'launch-failed',
          }),
        },
      ])
      expect((await run(store.readTaskSnapshot(task.id, 10))).runs[0]).toMatchObject({
        status: 'failed',
        failure: 'launch-failed',
      })
    } finally {
      await runtime.dispose()
      await storeRuntime.dispose()
    }
  })

  it('preserves both claim and settlement failures when the compensation write fails', async () => {
    const storeRuntime = ManagedRuntime.make(WorkspaceStoreLive({ filename: ':memory:' }))
    const baseStore = await storeRuntime.runPromise(WorkspaceStore)
    const claimError = new WorkspaceStoreError({ code: 'database-unavailable', message: 'claim failed' })
    const settlementError = new WorkspaceStoreError({ code: 'database-unavailable', message: 'settlement failed' })
    let settlementCalls = 0
    const storeService = WorkspaceStore.of({
      ...baseStore,
      claimDispatch: () => Effect.fail(claimError),
      failDispatch: () =>
        Effect.gen(function* () {
          settlementCalls += 1
          return yield* Effect.fail(settlementError)
        }),
    })
    let connectCalls = 0
    const runtime = makeRuntime(
      () => {
        connectCalls += 1
        return Effect.die(new Error('Claim failure must not connect'))
      },
      {},
      storeService,
    )

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      const result = await run(Effect.exit(service.start({ ...command, commandId: 'claim-and-settlement-failure' })))

      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const failures = result.cause.reasons.filter(Cause.isFailReason).map(reason => reason.error)
        expect(failures).toEqual(expect.arrayContaining([claimError, settlementError]))
      }
      expect(settlementCalls).toBe(1)
      expect(connectCalls).toBe(0)
    } finally {
      await runtime.dispose()
      await storeRuntime.dispose()
    }
  })

  it('reports unresolved cleanup at the shutdown deadline without waiting for close', async () => {
    const streamStarted = await Effect.runPromise(Deferred.make<undefined>())
    const releaseStream = await Effect.runPromise(Deferred.make<undefined>())
    const closeStarted = await Effect.runPromise(Deferred.make<undefined>())
    const releaseClose = await Effect.runPromise(Deferred.make<undefined>())
    const closeFinished = await Effect.runPromise(Deferred.make<undefined>())
    const session = makeSession({
      events: () =>
        Stream.fromEffect(
          Effect.gen(function* () {
            yield* Deferred.succeed(streamStarted, undefined)
            yield* Deferred.await(releaseStream)
            return { kind: 'turnCompleted', nativeTurnId: 'native-turn' } as const
          }),
        ),
    })
    const connection = makeConnection(session, {
      close: () =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* Deferred.succeed(closeStarted, undefined)
            yield* Deferred.await(releaseClose)
            yield* Deferred.succeed(closeFinished, undefined)
          }),
        ),
    })
    const runtime = makeRuntime(() => Effect.succeed(connection), { closeDeadlineMs: 20 })
    let stopping: Promise<void> | undefined
    let disposing: Promise<void> | undefined

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start({ ...command, commandId: 'hanging-close' }))
      await run(Deferred.await(streamStarted))

      stopping = run(service.stopAll())
      await run(Deferred.await(closeStarted))
      const returnedBeforeClose = await Promise.race([
        stopping.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 80)),
      ])

      expect(returnedBeforeClose).toBe(true)
      await expect(stopping).rejects.toMatchObject({
        _tag: 'ExecutionServiceError',
        reason: 'background-failure',
        message: expect.stringContaining('deadline'),
      })
      expect((await run(store.readTaskSnapshot(task.id, 10))).runs[0]).toMatchObject({
        status: 'uncertain',
        failure: 'shutdown',
      })

      disposing = runtime.dispose()
      const disposedBeforeClose = await Promise.race([
        disposing.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 150)),
      ])
      expect(disposedBeforeClose).toBe(true)
    } finally {
      await Effect.runPromise(Deferred.succeed(releaseStream, undefined))
      await Effect.runPromise(Deferred.succeed(releaseClose, undefined))
      await stopping?.catch(() => undefined)
      await Effect.runPromise(Deferred.await(closeFinished))
      if (disposing) await disposing.catch(() => undefined)
      else await runtime.dispose()
    }
  })

  it('retries a failed native interrupt with the same turn fence and preserves event ingestion', async () => {
    const streamStarted = await Effect.runPromise(Deferred.make<undefined>())
    const releaseTerminal = await Effect.runPromise(Deferred.make<undefined>())
    const interruptFailure = new AgentDriverError({ code: 'disconnected', message: 'interrupt disconnected' })
    const expectedTurnIds: Array<string | undefined> = []
    let interruptCalls = 0
    const session = makeSession({
      events: () =>
        Stream.fromEffect(
          Effect.gen(function* () {
            yield* Deferred.succeed(streamStarted, undefined)
            yield* Deferred.await(releaseTerminal)
            return { kind: 'turnInterrupted', nativeTurnId: 'native-turn' } as const
          }),
        ),
      interrupt: (_runId, expectedNativeTurnId) => {
        interruptCalls += 1
        expectedTurnIds.push(expectedNativeTurnId)
        return interruptCalls === 1
          ? Effect.fail(interruptFailure)
          : Effect.succeed({ acknowledged: true, termination: 'stillRunning' as const })
      },
    })
    const runtime = makeRuntime(() => Effect.succeed(makeConnection(session)))

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start({ ...command, commandId: 'interrupt-retry' }))
      await run(Deferred.await(streamStarted))

      await expect(run(service.interrupt(command.runId))).rejects.toBe(interruptFailure)
      await run(service.interrupt(command.runId))
      expect(interruptCalls).toBe(2)
      expect(expectedTurnIds).toEqual(['native-turn', 'native-turn'])

      await run(Deferred.succeed(releaseTerminal, undefined))
      await run(service.stopAll())
      expect((await run(store.readTaskSnapshot(task.id, 10))).runs[0]?.status).toBe('interrupted')
    } finally {
      await Effect.runPromise(Deferred.succeed(releaseTerminal, undefined))
      await runtime.dispose()
    }
  })

  it.each(['test-driver', 'unregistered-driver'])(
    'does not dispatch a replayed durable beginRun receipt for %s',
    async driverId => {
      let connectCalls = 0
      const runtime = makeRuntime(() =>
        Effect.sync(() => {
          connectCalls += 1
          throw new Error('A replayed command must not connect to a driver')
        }),
      )

      try {
        const store = await runtime.runPromise(WorkspaceStore)
        const run: RunEffect = effect => runtime.runPromise(effect)
        await setup(store, run)
        const originalCommand = { ...command, driverId }
        await runtime.runPromise(store.beginRun(originalCommand))

        const service = await runtime.runPromise(ExecutionService)
        const receipt = await runtime.runPromise(service.start(originalCommand))

        expect(receipt).toMatchObject({ commandId: 'command-1', runId: 'run-1', replayed: true })
        expect(connectCalls).toBe(0)
      } finally {
        await runtime.dispose()
      }
    },
  )

  it('claims before native dispatch and commits terminal events before publishing them', async () => {
    const order: string[] = []
    let store!: WorkspaceStore['Service']
    let openedContext: AgentSessionContext | undefined
    const queuedEvents: AgentDriverEvent[] = []
    const published = await Effect.runPromise(Deferred.make<undefined>())
    const session = makeSession({
      events: () =>
        Stream.fromEffect(
          store
            .readTaskSnapshot(task.id, 10)
            .pipe(Effect.mapError(error => new AgentDriverError({ code: 'protocol-error', message: error.message }))),
        ).pipe(
          Stream.map(snapshot => {
            order.push(`consume:${snapshot.runs[0]?.status}`)
            return queuedEvents.shift() as AgentDriverEvent
          }),
        ),
      submit: () =>
        Effect.sync(() => {
          order.push('submit')
          queuedEvents.push({ kind: 'turnCompleted', nativeTurnId: 'native-turn' })
          return { nativeSessionId: 'native-session', nativeTurnId: 'native-turn', generation: 1 }
        }),
    })
    const connection = makeConnection(session, {
      openSession: context =>
        Effect.sync(() => {
          order.push('open')
          openedContext = context
          return session
        }),
      close: () => Effect.sync(() => void order.push('close')),
    })
    const runtime = makeRuntime(
      () =>
        Effect.gen(function* () {
          const snapshot = yield* store
            .readTaskSnapshot(task.id, 10)
            .pipe(Effect.mapError(error => new AgentDriverError({ code: 'protocol-error', message: error.message })))
          order.push(`connect:${snapshot.runs[0]?.status}`)
          return connection
        }),
      {
        publishCommittedEvent: event =>
          Effect.gen(function* () {
            const page = yield* store.pageEvents(0, 20)
            expect(page.events.some(item => item.sequence === event.sequence)).toBe(true)
            order.push(`publish:${event.kind}`)
            yield* Deferred.succeed(published, undefined)
          }),
      },
    )

    try {
      store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      const receipt = await run(
        service.start({
          ...command,
          commandId: 'ordered-command',
        }),
      )
      await run(Deferred.await(published))
      await run(service.stopAll())

      expect(receipt.replayed).toBe(false)
      expect(openedContext).toMatchObject({ projectId: 'project-1', workspacePath: 'C:/repo' })
      expect(order).toEqual(['connect:starting', 'open', 'submit', 'consume:running', 'publish:driverEvent', 'close'])
      const events = await run(store.pageEvents(0, 20))
      expect(events.events.map(event => event.kind)).toContain('driverEvent')
      const snapshot = await run(store.readTaskSnapshot(task.id, 10))
      expect(snapshot.runs[0]).toMatchObject({ status: 'completed', nativeTurnId: 'native-turn' })
    } finally {
      await runtime.dispose()
    }
  })

  it('loads the exact native session on resume and never falls back to opening a fresh one', async () => {
    const submitStarted = await Effect.runPromise(Deferred.make<undefined>())
    let openCalls = 0
    let loaded: { readonly nativeSessionId: string; readonly generation: number } | undefined
    const session = makeSession({
      identity: { nativeSessionId: 'native-existing', generation: 1 },
      submit: () =>
        Effect.andThen(
          Deferred.succeed(submitStarted, undefined),
          Effect.succeed({ nativeSessionId: 'native-existing', nativeTurnId: 'turn-resumed', generation: 1 }),
        ),
      events: () => Stream.fromIterable([{ kind: 'turnCompleted', nativeTurnId: 'turn-resumed' } as const]),
    })
    const connection = makeConnection(session, {
      openSession: () => {
        openCalls += 1
        return Effect.die(new Error('resume must not open a fresh session'))
      },
      loadSession: (_context, native) =>
        Effect.sync(() => {
          loaded = native
          return session
        }),
    })
    const runtime = makeRuntime(() => Effect.succeed(connection))

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(
        service.start({
          ...command,
          commandId: 'resume-command',
          runId: 'resume-run' as never,
          provisionalAgentSessionId: 'resume-session',
          nativeSessionId: 'native-existing',
        }),
      )
      await run(Deferred.await(submitStarted))
      await run(service.stopAll())

      expect(loaded).toEqual({ nativeSessionId: 'native-existing', generation: 1 })
      expect(openCalls).toBe(0)
      expect((await run(store.readTaskSnapshot(task.id, 10))).runs[0]?.status).toBe('completed')
    } finally {
      await runtime.dispose()
    }
  })

  it.each([
    { phase: 'connect' as const, expectedStatus: 'failed' as const, expectedSubmits: 0 },
    { phase: 'submit' as const, expectedStatus: 'uncertain' as const, expectedSubmits: 1 },
  ])(
    'classifies a $phase failure conservatively without retrying',
    async ({ phase, expectedStatus, expectedSubmits }) => {
      const attempted = await Effect.runPromise(Deferred.make<undefined>())
      let submitCalls = 0
      const failure = new AgentDriverError({ code: 'disconnected', message: `${phase} disconnected` })
      const session = makeSession({
        submit: () => {
          submitCalls += 1
          return Effect.andThen(Deferred.succeed(attempted, undefined), Effect.fail(failure))
        },
      })
      const connection = makeConnection(session)
      const connect: DriverConnect = () =>
        phase === 'connect'
          ? Effect.andThen(Deferred.succeed(attempted, undefined), Effect.fail(failure))
          : Effect.succeed(connection)
      const runtime = makeRuntime(connect)

      try {
        const store = await runtime.runPromise(WorkspaceStore)
        const run: RunEffect = effect => runtime.runPromise(effect)
        await setup(store, run)
        const service = await runtime.runPromise(ExecutionService)
        await run(service.start({ ...command, commandId: `${phase}-failure` }))
        await run(Deferred.await(attempted))
        await run(service.stopAll())

        expect(submitCalls).toBe(expectedSubmits)
        const snapshot = await run(store.readTaskSnapshot(task.id, 10))
        expect(snapshot.runs[0]).toMatchObject({ status: expectedStatus })
      } finally {
        await runtime.dispose()
      }
    },
  )

  it('marks a stream that ends without a terminal event uncertain', async () => {
    const streamStarted = await Effect.runPromise(Deferred.make<undefined>())
    const session = makeSession({
      events: () =>
        Stream.fromEffect(
          Effect.as(Deferred.succeed(streamStarted, undefined), { kind: 'textDelta', text: 'partial' } as const),
        ),
    })
    const runtime = makeRuntime(() => Effect.succeed(makeConnection(session)))

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start({ ...command, commandId: 'ended-stream' }))
      await run(Deferred.await(streamStarted))
      await run(service.stopAll())

      const snapshot = await run(store.readTaskSnapshot(task.id, 10))
      expect(snapshot.runs[0]).toMatchObject({ status: 'uncertain', failure: 'event-stream-ended' })
    } finally {
      await runtime.dispose()
    }
  })

  it('persists an interrupt requested during submit and ingests a terminal event after the native ack', async () => {
    const submitStarted = await Effect.runPromise(Deferred.make<undefined>())
    const releaseSubmit = await Effect.runPromise(Deferred.make<undefined>())
    const nativeInterruptSent = await Effect.runPromise(Deferred.make<undefined>())
    const releaseTerminal = await Effect.runPromise(Deferred.make<undefined>())
    let store!: WorkspaceStore['Service']
    let statusAtNativeInterrupt: string | undefined
    let interruptCalls = 0
    const session = makeSession({
      submit: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(submitStarted, undefined)
          yield* Deferred.await(releaseSubmit)
          return { nativeSessionId: 'native-session', nativeTurnId: 'native-turn', generation: 1 }
        }),
      interrupt: () =>
        Effect.gen(function* () {
          interruptCalls += 1
          statusAtNativeInterrupt = (yield* store
            .readTaskSnapshot(task.id, 10)
            .pipe(Effect.mapError(error => new AgentDriverError({ code: 'protocol-error', message: error.message }))))
            .runs[0]?.status
          yield* Deferred.succeed(nativeInterruptSent, undefined)
          return { acknowledged: true, termination: 'stillRunning' as const }
        }),
      events: () =>
        Stream.fromEffect(Deferred.await(releaseTerminal)).pipe(
          Stream.map(() => ({ kind: 'turnInterrupted', nativeTurnId: 'native-turn' }) as const),
        ),
    })
    const runtime = makeRuntime(() => Effect.succeed(makeConnection(session)))

    try {
      store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start({ ...command, commandId: 'interrupt-during-submit' }))
      await run(Deferred.await(submitStarted))
      await run(service.interrupt(command.runId))

      expect((await run(store.readTaskSnapshot(task.id, 10))).runs[0]?.status).toBe('interruptRequested')
      expect(interruptCalls).toBe(0)
      await run(Deferred.succeed(releaseSubmit, undefined))
      await run(Deferred.await(nativeInterruptSent))
      expect(statusAtNativeInterrupt).toBe('interruptRequested')
      expect((await run(store.readTaskSnapshot(task.id, 10))).runs[0]?.status).toBe('interruptRequested')

      await run(Deferred.succeed(releaseTerminal, undefined))
      await run(service.stopAll())
      expect((await run(store.readTaskSnapshot(task.id, 10))).runs[0]?.status).toBe('interrupted')
    } finally {
      await runtime.dispose()
    }
  })
})
