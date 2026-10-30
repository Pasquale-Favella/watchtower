import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
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
import { CheckoutResolver, CheckoutResolverError } from '@/core/ports/checkout-resolver.js'
import { HarnessConnectionResolutionError, HarnessConnectionResolver } from '@/core/ports/harness-connections.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import type { ResolvedCheckout } from '@/shared/schemas/checkout.js'
import type { AgentCapabilities, AgentDriverEvent } from '@/shared/schemas/execution.js'
import type { AgentSessionId } from '@/shared/schemas/workspace.js'
import { type BeginRunCommand, WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

type RunEffect = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
type DriverConnect = AgentDriver['Service']['connect']

const fakeResolverLayer = (
  service: HarnessConnectionResolver['Service'] = HarnessConnectionResolver.of({
    resolve: connectionId => Effect.succeed({ connectionId }),
  }),
) => Layer.succeed(HarnessConnectionResolver, service)

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

const resolvedCheckout: ResolvedCheckout = {
  canonicalPath: checkout.path,
  kind: 'main',
  repositoryIdentity: project.repositoryIdentity,
  mainCheckoutPath: checkout.path,
  branch: 'main',
  headRevision: null,
  dirty: { trackedChanges: 0, untrackedCount: 0, ignoredCount: 0 },
}
const checkoutResolverLayer = (
  resolve: CheckoutResolver['Service']['resolve'] = path =>
    Effect.succeed(
      path === 'C:/other-repo'
        ? { ...resolvedCheckout, canonicalPath: path, mainCheckoutPath: path, repositoryIdentity: 'repo:two' }
        : resolvedCheckout,
    ),
) =>
  Layer.succeed(
    CheckoutResolver,
    CheckoutResolver.of({
      resolve,
      createIsolatedWorktree: () => Effect.die('Unexpected worktree creation'),
      removeWorktree: () => Effect.die('Unexpected worktree removal'),
    }),
  )

const makeRuntime = (
  connect: DriverConnect,
  options: Partial<ExecutionServiceOptions> = {},
  storeService?: WorkspaceStore['Service'],
  additionalDrivers: ReadonlyArray<AgentDriver['Service']> = [],
  resolverLayer = fakeResolverLayer(),
  checkoutLayer = checkoutResolverLayer(),
) =>
  ManagedRuntime.make(
    Layer.provideMerge(
      ExecutionService.layer({ ownerEpoch: 7, ...options }),
      Layer.merge(
        Layer.merge(
          storeService ? Layer.succeed(WorkspaceStore, storeService) : WorkspaceStoreLive({ filename: ':memory:' }),
          Layer.succeed(
            AgentDriverRegistry,
            AgentDriverRegistry.fromDrivers([
              AgentDriver.of({ driverId: 'test-driver', connect }),
              ...additionalDrivers,
            ]),
          ),
        ),
        Layer.merge(resolverLayer, checkoutLayer),
      ),
    ),
  )

const setup = async (store: WorkspaceStore['Service'], run: RunEffect) => {
  await run(store.registerProject({ project, mainCheckout: checkout }))
  await run(store.createTask({ task, conversation }))
}

describe('ExecutionService', () => {
  it.each([
    ['canonical path changed', Effect.succeed({ ...resolvedCheckout, canonicalPath: 'C:/different-checkout' })],
    ['repository identity changed', Effect.succeed({ ...resolvedCheckout, repositoryIdentity: 'repo:replacement' })],
    ['main checkout mapping changed', Effect.succeed({ ...resolvedCheckout, mainCheckoutPath: 'C:/other-main' })],
    ['checkout kind changed', Effect.succeed({ ...resolvedCheckout, kind: 'worktree' as const })],
    [
      'directory is not a repository',
      Effect.succeed({
        ...resolvedCheckout,
        kind: 'directory' as const,
        repositoryIdentity: null,
        mainCheckoutPath: null,
        branch: null,
        headRevision: null,
      }),
    ],
    [
      'path is missing',
      Effect.fail(new CheckoutResolverError({ code: 'path-missing', message: 'Sensitive filesystem path' })),
    ],
    [
      'path is not a directory',
      Effect.fail(new CheckoutResolverError({ code: 'not-a-directory', message: 'Sensitive filesystem path' })),
    ],
    ['resolver failed', Effect.fail(new CheckoutResolverError({ code: 'git-failed', message: 'Sensitive Git error' }))],
  ])('refuses a checkout when %s before native dispatch', async (_label, resolution) => {
    const nativeCalls: string[] = []
    const runtime = makeRuntime(
      () => {
        nativeCalls.push('connect')
        return Effect.succeed(makeConnection(makeSession()))
      },
      {},
      undefined,
      [],
      fakeResolverLayer(),
      checkoutResolverLayer(() => resolution),
    )
    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start(command))
      await expect.poll(async () => (await run(store.readTaskSnapshot(task.id, 10))).runs[0]?.status).toBe('failed')
      const stopped = await run(Effect.flip(service.stopAll()))
      expect(stopped).toMatchObject({ _tag: 'ExecutionServiceError', nativeCleanup: 'confirmed' })
      expect(stopped.cause).toMatchObject({
        reasons: [
          expect.objectContaining({
            error: expect.objectContaining({
              _tag: 'ExecutionServiceError',
              message: 'Registered checkout could not be verified for execution.',
            }),
          }),
        ],
      })
      expect(JSON.stringify(stopped)).not.toContain('Sensitive')
      expect(nativeCalls).toEqual([])
      expect((await run(store.readTaskSnapshot(task.id, 10))).runs).toEqual([
        expect.objectContaining({ id: command.runId, status: 'failed', failure: 'launch-failed' }),
      ])
      expect(await run(store.recoverWorker(7, '2026-10-29T10:00:02Z'))).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('bounds shutdown while checkout revalidation is slow, without native dispatch', async () => {
    const resolverEntered = Deferred.makeUnsafe<undefined>()
    const nativeCalls: string[] = []
    const runtime = makeRuntime(
      () => {
        nativeCalls.push('connect')
        return Effect.succeed(makeConnection(makeSession()))
      },
      { closeDeadlineMs: 60 },
      undefined,
      [],
      fakeResolverLayer(),
      checkoutResolverLayer(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(resolverEntered, undefined)
          yield* Effect.sleep(500)
          return resolvedCheckout
        }),
      ),
    )
    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      const started = run(service.start(command))
      await run(Deferred.await(resolverEntered))
      const before = performance.now()
      const stopped = await run(Effect.exit(service.stopAll()))
      const elapsedMs = performance.now() - before
      await started
      const schedulingToleranceMs = 25
      expect(elapsedMs).toBeLessThan(60 + schedulingToleranceMs)
      expect(Exit.isFailure(stopped)).toBe(true)
      if (Exit.isFailure(stopped)) {
        expect(Cause.squash(stopped.cause)).toMatchObject({ _tag: 'ExecutionServiceError', nativeCleanup: 'confirmed' })
      }
      expect(nativeCalls).toEqual([])
      expect((await run(store.readTaskSnapshot(task.id, 10))).runs[0]).toMatchObject({
        status: 'uncertain',
        failure: 'shutdown',
      })
      expect(await run(store.recoverWorker(7, '2026-10-29T10:00:02Z'))).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

  it('admits concurrent starts without waiting for another checkout resolver', async () => {
    const slowResolutionEntered = Deferred.makeUnsafe<undefined>()
    const nativeCalls: string[] = []
    const otherProject = { ...project, id: 'project-fast' as never, repositoryIdentity: 'repo:fast' }
    const otherCheckout = { ...checkout, id: 'checkout-fast' as never, path: 'C:/fast-repo' }
    const otherTask = { ...task, id: 'task-fast' as never, projectId: otherProject.id }
    const otherConversation = { ...conversation, id: 'conversation-fast' as never }
    const fastCommand = {
      ...command,
      commandId: 'fast-command',
      runId: 'fast-run' as never,
      taskId: otherTask.id,
      conversationId: otherConversation.id,
      checkoutId: otherCheckout.id,
      provisionalAgentSessionId: 'fast-session',
    }
    const session = makeSession({
      events: () => Stream.succeed({ kind: 'turnCompleted', nativeTurnId: 'native-turn' }),
    })
    const runtime = makeRuntime(
      () =>
        Effect.succeed(
          makeConnection(session, {
            openSession: context => {
              nativeCalls.push(context.workspacePath)
              return Effect.succeed(session)
            },
          }),
        ),
      { closeDeadlineMs: 60 },
      undefined,
      [],
      fakeResolverLayer(),
      checkoutResolverLayer(path =>
        path === checkout.path
          ? Effect.gen(function* () {
              yield* Deferred.succeed(slowResolutionEntered, undefined)
              yield* Effect.sleep(500)
              return resolvedCheckout
            })
          : Effect.succeed({
              ...resolvedCheckout,
              canonicalPath: otherCheckout.path,
              mainCheckoutPath: otherCheckout.path,
              repositoryIdentity: otherProject.repositoryIdentity,
            }),
      ),
    )
    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      await run(store.registerProject({ project: otherProject, mainCheckout: otherCheckout }))
      await run(store.createTask({ task: otherTask, conversation: otherConversation }))
      const service = await runtime.runPromise(ExecutionService)
      const first = run(service.start(command))
      await run(Deferred.await(slowResolutionEntered))
      const before = performance.now()
      const second = await run(service.start(fastCommand))
      expect(performance.now() - before).toBeLessThan(150)
      expect(second.runId).toBe('fast-run')
      await expect
        .poll(async () => (await run(store.readTaskSnapshot(otherTask.id, 10))).runs[0]?.status)
        .toBe('completed')
      expect(nativeCalls).toEqual(['C:/fast-repo'])
      await first
      await run(Effect.exit(service.stopAll()))
    } finally {
      await runtime.dispose()
    }
  })

  it('settles and reports a checkout that disappears after admission but before native dispatch', async () => {
    const allowResolution = Deferred.makeUnsafe<undefined>()
    const nativeCalls: string[] = []
    const runtime = makeRuntime(
      () => {
        nativeCalls.push('connect')
        return Effect.succeed(makeConnection(makeSession()))
      },
      {},
      undefined,
      [],
      fakeResolverLayer(),
      checkoutResolverLayer(() =>
        Deferred.await(allowResolution).pipe(
          Effect.andThen(
            Effect.fail(new CheckoutResolverError({ code: 'path-missing', message: 'Sensitive filesystem path' })),
          ),
        ),
      ),
    )
    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start(command))
      await run(Deferred.succeed(allowResolution, undefined))
      await expect.poll(async () => (await run(store.readTaskSnapshot(task.id, 10))).runs[0]?.status).toBe('failed')
      expect(nativeCalls).toEqual([])
      expect(await run(store.recoverWorker(7, '2026-10-29T10:00:02Z'))).toBe(0)
      const stopped = await run(Effect.exit(service.stopAll()))
      expect(Exit.isFailure(stopped)).toBe(true)
      if (Exit.isFailure(stopped)) {
        expect(Cause.squash(stopped.cause)).toMatchObject({ _tag: 'ExecutionServiceError', nativeCleanup: 'confirmed' })
        expect(String(Cause.squash(stopped.cause))).not.toContain('Sensitive filesystem path')
      }
    } finally {
      await runtime.dispose()
    }
  })

  it('dispatches a matching checkout even when its tracked, untracked, and ignored files are dirty', async () => {
    const nativeCalls: string[] = []
    const session = makeSession({
      events: () => Stream.succeed({ kind: 'turnCompleted', nativeTurnId: 'native-turn' }),
      submit: () =>
        Effect.sync(() => {
          nativeCalls.push('submit')
          return { nativeSessionId: 'native-session', nativeTurnId: 'native-turn', generation: 1 }
        }),
    })
    const runtime = makeRuntime(
      () => {
        nativeCalls.push('connect')
        return Effect.succeed(makeConnection(session))
      },
      {},
      undefined,
      [],
      fakeResolverLayer(),
      checkoutResolverLayer(() =>
        Effect.succeed({
          ...resolvedCheckout,
          dirty: { trackedChanges: 3, untrackedCount: 2, ignoredCount: 1 },
        }),
      ),
    )
    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start(command))
      await expect.poll(async () => (await run(store.readTaskSnapshot(task.id, 10))).runs[0]?.status).toBe('completed')
      expect(nativeCalls).toEqual(['connect', 'submit'])
    } finally {
      await runtime.dispose()
    }
  })

  it.each([true, false])(
    'validates a paginated worktree checkout against its main mapping (matches: %s)',
    async matches => {
      const storeRuntime = ManagedRuntime.make(WorkspaceStoreLive({ filename: ':memory:' }))
      const store = await storeRuntime.runPromise(WorkspaceStore)
      await setup(store, effect => storeRuntime.runPromise(effect))
      const nativeCalls: string[] = []
      const runtime = makeRuntime(
        () => {
          nativeCalls.push('connect')
          return Effect.succeed(
            makeConnection(
              makeSession({
                events: () => Stream.succeed({ kind: 'turnCompleted', nativeTurnId: 'native-turn' }),
              }),
            ),
          )
        },
        {},
        WorkspaceStore.of({
          ...store,
          getProject: (id, options) =>
            store.getProject(id).pipe(
              Effect.map(detail => ({
                ...detail,
                mainCheckout: { ...detail.mainCheckout, id: 'main-checkout' as never, path: 'C:/main' },
                otherCheckouts: options?.afterCheckoutId ? [{ ...detail.mainCheckout, kind: 'worktree' as const }] : [],
                nextAfterCheckoutId: options?.afterCheckoutId ? null : ('before-target' as never),
                totalOtherCheckouts: 1,
              })),
            ),
        }),
        [],
        fakeResolverLayer(),
        checkoutResolverLayer(() =>
          Effect.succeed({
            ...resolvedCheckout,
            kind: 'worktree',
            mainCheckoutPath: matches ? 'C:/main' : 'C:/replaced-main',
          }),
        ),
      )
      try {
        const service = await runtime.runPromise(ExecutionService)
        if (matches) {
          await runtime.runPromise(service.start(command))
          await expect
            .poll(async () => (await storeRuntime.runPromise(store.readTaskSnapshot(task.id, 10))).runs[0]?.status)
            .toBe('completed')
          expect(nativeCalls).toEqual(['connect'])
        } else {
          await runtime.runPromise(service.start(command))
          await expect
            .poll(async () => (await storeRuntime.runPromise(store.readTaskSnapshot(task.id, 10))).runs[0]?.status)
            .toBe('failed')
          expect(await runtime.runPromise(Effect.flip(service.stopAll()))).toMatchObject({
            _tag: 'ExecutionServiceError',
            nativeCleanup: 'confirmed',
          })
          expect(nativeCalls).toEqual([])
          expect((await storeRuntime.runPromise(store.readTaskSnapshot(task.id, 10))).runs[0]).toMatchObject({
            status: 'failed',
            failure: 'launch-failed',
          })
        }
      } finally {
        await runtime.dispose()
        await storeRuntime.dispose()
      }
    },
  )

  it('coalesces adjacent text and flushes it on the age deadline before a request event', async () => {
    const textCommitted = await Effect.runPromise(Deferred.make<undefined>())
    const allowRequest = await Effect.runPromise(Deferred.make<undefined>())
    const requestCommitted = await Effect.runPromise(Deferred.make<undefined>())
    const responseDelivered = await Effect.runPromise(Deferred.make<undefined>())
    const request = {
      requestId: 'request-after-text',
      runId: command.runId,
      sessionId: 'session-1' as AgentSessionId,
      generation: 1,
      kind: 'approval' as const,
      prompt: 'Allow this action?',
      questions: [],
    }
    const committed: Array<{ kind: string; text?: string }> = []
    const session = makeSession({
      submit: () =>
        Effect.gen(function* () {
          yield* Deferred.await(responseDelivered)
          return { nativeSessionId: 'native-session', nativeTurnId: 'native-turn', generation: 1 }
        }),
      respond: () => Effect.as(Deferred.succeed(responseDelivered, undefined), { outcome: 'accepted' as const }),
      events: () =>
        Stream.concat(
          Stream.make(
            { kind: 'textDelta', text: 'hello ', itemId: 'item-1' } as const,
            { kind: 'textDelta', text: 'world', itemId: 'item-1' } as const,
          ),
          Stream.fromEffect(Deferred.await(allowRequest)).pipe(
            Stream.as({ kind: 'requestPending', request } as const),
            Stream.concat(
              Stream.fromEffect(Deferred.await(responseDelivered)).pipe(
                Stream.map(
                  () =>
                    ({ kind: 'requestResolved', requestId: request.requestId, decision: { kind: 'approve' } }) as const,
                ),
                Stream.concat(Stream.succeed({ kind: 'turnCompleted', nativeTurnId: 'native-turn' } as const)),
              ),
            ),
          ),
        ),
    })
    const runtime = makeRuntime(() => Effect.succeed(makeConnection(session)), {
      publishCommittedEvent: event =>
        Effect.gen(function* () {
          if (event.kind !== 'driverEvent') return
          const driverEvent = (event.data as { event: AgentDriverEvent }).event
          committed.push({
            kind: driverEvent.kind,
            ...(driverEvent.kind === 'textDelta' ? { text: driverEvent.text } : {}),
          })
          if (driverEvent.kind === 'textDelta') yield* Deferred.succeed(textCommitted, undefined)
          if (driverEvent.kind === 'requestPending') yield* Deferred.succeed(requestCommitted, undefined)
        }),
    })

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start({ ...command, commandId: 'coalesce-before-request' }))
      await run(Deferred.await(textCommitted))
      expect(committed).toEqual([{ kind: 'textDelta', text: 'hello world' }])
      await run(Deferred.succeed(allowRequest, undefined))
      await run(Deferred.await(requestCommitted))
      expect(committed.map(item => item.kind)).toEqual(['textDelta', 'requestPending'])
      await run(
        service.respond({
          commandId: 'answer-after-text',
          issuedAt: '2026-10-29T10:00:02Z',
          runId: command.runId,
          ownerEpoch: 7,
          generation: 1,
          requestId: request.requestId,
          decision: { kind: 'approve' },
        }),
      )
      await run(service.stopAll())
    } finally {
      await Effect.runPromise(Deferred.succeed(allowRequest, undefined))
      await Effect.runPromise(Deferred.succeed(responseDelivered, undefined))
      await runtime.dispose()
    }
  })

  it('closes a Run when durable event ingestion fails while submit is still pending', async () => {
    const storeRuntime = ManagedRuntime.make(WorkspaceStoreLive({ filename: ':memory:' }))
    const baseStore = await storeRuntime.runPromise(WorkspaceStore)
    const closeObserved = await Effect.runPromise(Deferred.make<undefined>())
    const writeError = new WorkspaceStoreError({ code: 'database-unavailable', message: 'event write failed' })
    const failingStore = WorkspaceStore.of({
      ...baseStore,
      recordDriverEvent: () => Effect.fail(writeError),
    })
    const request = {
      requestId: 'request-write-failure',
      runId: command.runId,
      sessionId: 'session-1' as AgentSessionId,
      generation: 1,
      kind: 'approval' as const,
      prompt: 'Allow this action?',
      questions: [],
    }
    const session = makeSession({
      submit: () => Effect.never,
      events: () => Stream.succeed({ kind: 'requestPending', request } as const),
    })
    const connection = makeConnection(session, {
      close: () => Deferred.succeed(closeObserved, undefined),
    })
    const runtime = makeRuntime(() => Effect.succeed(connection), {}, failingStore)

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start({ ...command, commandId: 'ingestion-failure-pending-submit' }))
      await run(Deferred.await(closeObserved))
      await expect.poll(async () => (await run(store.readTaskSnapshot(task.id, 10))).runs[0]?.status).toBe('uncertain')
      expect((await run(store.readTaskSnapshot(task.id, 10))).runs[0]?.failure).toBe('dispatch-uncertain')
    } finally {
      await runtime.dispose()
      await storeRuntime.dispose()
    }
  })

  it('settles an event stream that reaches EOF before submit acceptance as uncertain', async () => {
    const closeObserved = await Effect.runPromise(Deferred.make<undefined>())
    const connection = makeConnection(makeSession({ submit: () => Effect.never, events: () => Stream.empty }), {
      close: () => Deferred.succeed(closeObserved, undefined),
    })
    const runtime = makeRuntime(() => Effect.succeed(connection))

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start({ ...command, commandId: 'event-eof-pending-submit' }))
      await run(Deferred.await(closeObserved))
      await expect.poll(async () => (await run(store.readTaskSnapshot(task.id, 10))).runs[0]?.status).toBe('uncertain')
      expect((await run(store.readTaskSnapshot(task.id, 10))).runs[0]?.failure).toBe('dispatch-uncertain')
    } finally {
      await runtime.dispose()
    }
  })

  it('keeps a persisted native interrupt alive after the caller fiber is interrupted', async () => {
    const interruptStarted = await Effect.runPromise(Deferred.make<undefined>())
    const releaseInterrupt = await Effect.runPromise(Deferred.make<undefined>())
    const interruptFinished = await Effect.runPromise(Deferred.make<undefined>())
    let interruptCalls = 0
    const session = makeSession({
      interrupt: () =>
        Effect.gen(function* () {
          interruptCalls += 1
          yield* Deferred.succeed(interruptStarted, undefined)
          yield* Deferred.await(releaseInterrupt)
          yield* Deferred.succeed(interruptFinished, undefined)
          return { acknowledged: true, termination: 'stillRunning' as const }
        }),
      events: () =>
        Stream.fromEffect(Deferred.await(interruptFinished)).pipe(
          Stream.map(() => ({ kind: 'turnInterrupted', nativeTurnId: 'native-turn' }) as const),
        ),
    })
    const runtime = makeRuntime(() => Effect.succeed(makeConnection(session)))

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start({ ...command, commandId: 'owned-interrupt-control' }))
      const caller = Effect.runFork(service.interrupt(command.runId))
      await run(Deferred.await(interruptStarted))
      await Effect.runPromise(Fiber.interrupt(caller))
      await Effect.runPromise(Deferred.succeed(releaseInterrupt, undefined))
      await run(Deferred.await(interruptFinished))
      await expect
        .poll(async () => (await run(store.readTaskSnapshot(task.id, 10))).runs[0]?.status)
        .toBe('interrupted')
      expect(interruptCalls).toBe(1)
      await run(service.stopAll())
    } finally {
      await Effect.runPromise(Deferred.succeed(releaseInterrupt, undefined))
      await runtime.dispose()
    }
  })

  it('bounds stopAll when a native interrupt ignores cancellation', async () => {
    const submitFinished = await Effect.runPromise(Deferred.make<undefined>())
    const requestCommitted = await Effect.runPromise(Deferred.make<undefined>())
    const nativeResponseStarted = await Effect.runPromise(Deferred.make<undefined>())
    const request = {
      requestId: 'request-stopall-response',
      runId: command.runId,
      sessionId: 'session-1' as AgentSessionId,
      generation: 1,
      kind: 'approval' as const,
      prompt: 'Allow this action?',
      questions: [],
    }
    const session = makeSession({
      submit: () =>
        Effect.as(Deferred.succeed(submitFinished, undefined), {
          nativeSessionId: 'native-session',
          nativeTurnId: 'native-turn',
          generation: 1,
        }),
      interrupt: () => Effect.never,
      respond: () => Effect.andThen(Deferred.succeed(nativeResponseStarted, undefined), Effect.never),
      events: () => Stream.concat(Stream.succeed({ kind: 'requestPending', request } as const), Stream.never),
    })
    const runtime = makeRuntime(() => Effect.succeed(makeConnection(session)), {
      closeDeadlineMs: 90,
      publishCommittedEvent: event =>
        event.kind === 'driverEvent' && (event.data as { event?: { kind?: string } }).event?.kind === 'requestPending'
          ? Effect.as(Deferred.succeed(requestCommitted, undefined), undefined)
          : Effect.void,
    })

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start({ ...command, commandId: 'stopall-bounded-interrupt' }))
      await run(Deferred.await(submitFinished))
      await run(Deferred.await(requestCommitted))
      const responseCaller = Effect.runFork(
        service.respond({
          commandId: 'response-stopall-bounded',
          issuedAt: '2026-10-29T10:00:02Z',
          runId: command.runId,
          ownerEpoch: 7,
          generation: 1,
          requestId: request.requestId,
          decision: { kind: 'approve' },
        }),
      )
      await run(Deferred.await(nativeResponseStarted))
      const startedAt = Date.now()
      await expect(run(service.stopAll())).rejects.toMatchObject({
        _tag: 'ExecutionServiceError',
        reason: 'background-failure',
        message: expect.stringContaining('Shutdown deadline expired'),
        nativeCleanup: 'confirmed',
      })
      expect(Date.now() - startedAt).toBeLessThan(250)
      expect((await run(store.readTaskSnapshot(task.id, 10))).runs[0]).toMatchObject({
        status: 'uncertain',
        failure: 'shutdown',
      })
      expect((await run(store.listRequestResponses(task.id))).items[0]).toMatchObject({
        state: 'uncertain',
        delivery: { outcome: 'uncertain' },
      })
      await Effect.runPromise(Fiber.await(responseCaller))
    } finally {
      await runtime.dispose()
    }
  })

  it.each(['interrupt', 'stopAll'] as const)(
    'still sends the native interrupt when persisting %s fails',
    async operation => {
      const interrupted = await Effect.runPromise(Deferred.make<undefined>())
      const persistenceFailure = new WorkspaceStoreError({
        code: 'database-unavailable',
        message: 'interrupt persistence failed',
      })
      const storeRuntime = ManagedRuntime.make(WorkspaceStoreLive({ filename: ':memory:' }))
      const store = await storeRuntime.runPromise(WorkspaceStore)
      let nativeInterrupts = 0
      const session = makeSession({
        interrupt: () =>
          Effect.gen(function* () {
            nativeInterrupts += 1
            yield* Deferred.succeed(interrupted, undefined)
            return { acknowledged: true, termination: 'stillRunning' as const }
          }),
        events: () =>
          Stream.fromEffect(Deferred.await(interrupted)).pipe(
            Stream.as({ kind: 'turnInterrupted', nativeTurnId: 'native-turn' } as const),
          ),
      })
      const runtime = makeRuntime(
        () => Effect.succeed(makeConnection(session)),
        { closeDeadlineMs: 180 },
        WorkspaceStore.of({
          ...store,
          requestInterrupt: () => Effect.fail(persistenceFailure),
        }),
      )
      try {
        const run: RunEffect = effect => runtime.runPromise(effect)
        await setup(store, run)
        const service = await runtime.runPromise(ExecutionService)
        await run(service.start(command))
        await expect.poll(async () => (await run(store.readTaskSnapshot(task.id, 10))).runs[0]?.status).toBe('running')
        if (operation === 'interrupt') {
          await expect(run(service.interrupt(command.runId))).rejects.toMatchObject(persistenceFailure)
        } else {
          await expect(run(service.stopAll())).rejects.toMatchObject({
            _tag: 'ExecutionServiceError',
            nativeCleanup: 'confirmed',
          })
        }
        expect(nativeInterrupts).toBe(1)
        await expect
          .poll(async () => (await run(store.readTaskSnapshot(task.id, 10))).runs[0]?.status)
          .toBe('interrupted')
      } finally {
        await runtime.dispose()
        await storeRuntime.dispose()
      }
    },
  )

  it('confirms native cleanup even when forced shutdown cannot persist its uncertain fence', async () => {
    const storeRuntime = ManagedRuntime.make(WorkspaceStoreLive({ filename: ':memory:' }))
    const store = await storeRuntime.runPromise(WorkspaceStore)
    const runtime = makeRuntime(
      () => Effect.succeed(makeConnection(makeSession({ events: () => Stream.never }))),
      { closeDeadlineMs: 180 },
      WorkspaceStore.of({
        ...store,
        failDispatch: () =>
          Effect.fail(new WorkspaceStoreError({ code: 'database-unavailable', message: 'shutdown settlement failed' })),
      }),
    )
    try {
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start(command))
      await expect.poll(async () => (await run(store.readTaskSnapshot(task.id, 10))).runs[0]?.status).toBe('running')
      const shutdown = await run(Effect.exit(service.stopAll()))
      expect(shutdown).toMatchObject({ _tag: 'Failure' })
      if (Exit.isFailure(shutdown)) {
        expect(shutdown.cause.reasons.filter(Cause.isFailReason).map(reason => reason.error)).toMatchObject([
          {
            _tag: 'ExecutionServiceError',
            nativeCleanup: 'confirmed',
            message: 'Shutdown cleanup could not persist the uncertain execution fence',
          },
        ])
      }
      await expect(run(service.stopAll())).rejects.toMatchObject({
        _tag: 'ExecutionServiceError',
        nativeCleanup: 'confirmed',
      })
    } finally {
      await runtime.dispose()
      await storeRuntime.dispose()
    }
  })

  it.each(['connection-close', 'driver-finalizer'] as const)(
    'does not confirm native cleanup when %s fails',
    async failure => {
      const closeAttempted = await Effect.runPromise(Deferred.make<undefined>())
      const connection = makeConnection(makeSession(), {
        close: () =>
          Effect.andThen(
            Deferred.succeed(closeAttempted, undefined),
            failure === 'connection-close'
              ? Effect.fail(new AgentDriverError({ code: 'disconnected', message: 'native close failed' }))
              : Effect.void,
          ),
      })
      const runtime = makeRuntime(
        () =>
          failure === 'driver-finalizer'
            ? Effect.acquireRelease(Effect.succeed(connection), () =>
                Effect.die(new Error('driver scope cleanup failed')),
              )
            : Effect.succeed(connection),
        { closeDeadlineMs: 180 },
      )
      try {
        const store = await runtime.runPromise(WorkspaceStore)
        const run: RunEffect = effect => runtime.runPromise(effect)
        await setup(store, run)
        const service = await runtime.runPromise(ExecutionService)
        await run(service.start(command))
        await run(Deferred.await(closeAttempted))
        await expect(run(service.stopAll())).rejects.toMatchObject({
          _tag: 'ExecutionServiceError',
          nativeCleanup: 'unconfirmed',
        })
      } finally {
        await runtime.dispose()
      }
    },
  )

  it('ingests and answers a native request while submit is waiting for that answer', async () => {
    const requestCommitted = await Effect.runPromise(Deferred.make<undefined>())
    const responseDelivered = await Effect.runPromise(Deferred.make<undefined>())
    const nativeRequest = {
      requestId: 'request-early',
      runId: command.runId,
      sessionId: 'session-1' as AgentSessionId,
      generation: 1,
      kind: 'approval' as const,
      prompt: 'Allow this action?',
      questions: [],
    }
    let submitCalls = 0
    let responseCalls = 0
    const session = makeSession({
      submit: () =>
        Effect.gen(function* () {
          submitCalls += 1
          yield* Deferred.await(responseDelivered)
          return { nativeSessionId: 'native-session', nativeTurnId: 'native-turn', generation: 1 }
        }),
      respond: () =>
        Effect.gen(function* () {
          responseCalls += 1
          yield* Deferred.succeed(responseDelivered, undefined)
          return {
            outcome: 'accepted' as const,
            nativeConfirmation: 'unconfirmed' as const,
            nativeRequestId: 'native-request-early',
          }
        }),
      events: () =>
        Stream.concat(
          Stream.succeed({ kind: 'requestPending', request: nativeRequest } as const),
          Stream.fromEffect(Deferred.await(responseDelivered)).pipe(
            Stream.map(
              () => ({ kind: 'requestResolved', requestId: 'request-early', decision: { kind: 'approve' } }) as const,
            ),
            Stream.concat(Stream.succeed({ kind: 'turnCompleted', nativeTurnId: 'native-turn' } as const)),
          ),
        ),
    })
    const runtime = makeRuntime(() => Effect.succeed(makeConnection(session)), {
      publishCommittedEvent: event =>
        event.kind === 'driverEvent' && (event.data as { event?: { kind?: string } }).event?.kind === 'requestPending'
          ? Effect.as(Deferred.succeed(requestCommitted, undefined), undefined)
          : Effect.void,
    })

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start({ ...command, commandId: 'request-before-submit-ack' }))
      await run(Deferred.await(requestCommitted))
      expect(submitCalls).toBe(1)
      expect((await run(store.pageEvents(0, 30))).events.some(event => event.kind === 'runStarted')).toBe(false)
      const answer = {
        commandId: 'answer-early-request',
        issuedAt: '2026-10-29T10:00:02Z',
        runId: command.runId,
        ownerEpoch: 7,
        generation: 1,
        requestId: 'request-early',
        decision: { kind: 'approve' },
      } as const
      const receipts = await Promise.all([run(service.respond(answer)), run(service.respond(answer))])
      expect(receipts.map(receipt => receipt.replayed).sort()).toEqual([false, true])
      expect(responseCalls).toBe(1)
      await run(service.stopAll())
      expect((await run(store.pageEvents(0, 30))).events.some(event => event.kind === 'runStarted')).toBe(true)
      expect((await run(store.readTaskSnapshot(task.id, 10))).runs[0]).toMatchObject({ status: 'completed' })
      expect((await run(store.listRequestResponses(task.id))).items[0]).toMatchObject({
        state: 'resolved',
        delivery: {
          outcome: 'accepted',
          nativeConfirmation: 'unconfirmed',
          nativeRequestId: 'native-request-early',
        },
      })
    } finally {
      await runtime.dispose()
    }
  })

  it('keeps a durable response delivery alive after its caller fiber is interrupted', async () => {
    const requestCommitted = await Effect.runPromise(Deferred.make<undefined>())
    const nativeResponseStarted = await Effect.runPromise(Deferred.make<undefined>())
    const releaseNativeResponse = await Effect.runPromise(Deferred.make<undefined>())
    const responseDelivered = await Effect.runPromise(Deferred.make<undefined>())
    const nativeRequest = {
      requestId: 'request-detached-response',
      runId: command.runId,
      sessionId: 'session-1' as AgentSessionId,
      generation: 1,
      kind: 'approval' as const,
      prompt: 'Allow this action?',
      questions: [],
    }
    const session = makeSession({
      submit: () =>
        Effect.gen(function* () {
          yield* Deferred.await(responseDelivered)
          return { nativeSessionId: 'native-session', nativeTurnId: 'native-turn', generation: 1 }
        }),
      respond: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(nativeResponseStarted, undefined)
          yield* Deferred.await(releaseNativeResponse)
          yield* Deferred.succeed(responseDelivered, undefined)
          return { outcome: 'accepted' as const }
        }),
      events: () =>
        Stream.concat(
          Stream.succeed({ kind: 'requestPending', request: nativeRequest } as const),
          Stream.fromEffect(Deferred.await(responseDelivered)).pipe(
            Stream.map(
              () =>
                ({
                  kind: 'requestResolved',
                  requestId: nativeRequest.requestId,
                  decision: { kind: 'approve' },
                }) as const,
            ),
            Stream.concat(Stream.succeed({ kind: 'turnCompleted', nativeTurnId: 'native-turn' } as const)),
          ),
        ),
    })
    const runtime = makeRuntime(() => Effect.succeed(makeConnection(session)), {
      publishCommittedEvent: event =>
        event.kind === 'driverEvent' && (event.data as { event?: { kind?: string } }).event?.kind === 'requestPending'
          ? Effect.as(Deferred.succeed(requestCommitted, undefined), undefined)
          : Effect.void,
    })

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start({ ...command, commandId: 'response-caller-cancelled' }))
      await run(Deferred.await(requestCommitted))
      const caller = Effect.runFork(
        service.respond({
          commandId: 'response-survives-caller',
          issuedAt: '2026-10-29T10:00:02Z',
          runId: command.runId,
          ownerEpoch: 7,
          generation: 1,
          requestId: nativeRequest.requestId,
          decision: { kind: 'approve' },
        }),
      )
      await run(Deferred.await(nativeResponseStarted))
      await Effect.runPromise(Fiber.interrupt(caller))
      await Effect.runPromise(Deferred.succeed(releaseNativeResponse, undefined))
      await run(Deferred.await(responseDelivered))
      await expect.poll(async () => (await run(store.readTaskSnapshot(task.id, 10))).runs[0]?.status).toBe('completed')
      expect((await run(store.listRequestResponses(task.id))).items[0]).toMatchObject({
        state: 'resolved',
        delivery: { outcome: 'accepted' },
      })
      await run(service.stopAll())
    } finally {
      await Effect.runPromise(Deferred.succeed(releaseNativeResponse, undefined))
      await Effect.runPromise(Deferred.succeed(responseDelivered, undefined))
      await runtime.dispose()
    }
  })

  it('does not acknowledge a bound session when submit acceptance contradicts its native identity', async () => {
    const session = makeSession({
      submit: () =>
        Effect.succeed({ nativeSessionId: 'different-native-session', nativeTurnId: 'bad-turn', generation: 1 }),
    })
    const runtime = makeRuntime(() => Effect.succeed(makeConnection(session)))

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start({ ...command, commandId: 'contradictory-native-acceptance' }))
      await run(service.stopAll())

      expect((await run(store.readTaskSnapshot(task.id, 10))).runs[0]).toMatchObject({
        status: 'uncertain',
        failure: 'dispatch-uncertain',
      })
      expect((await run(store.pageEvents(0, 30))).events.some(event => event.kind === 'runStarted')).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  it('forwards the resolved ACP command and serialized arguments to the driver', async () => {
    let receivedOptions: Parameters<DriverConnect>[0] | undefined
    const connectionOptions = {
      connectionId: 'acp-connection',
      configuration: { command: 'acp-agent', argsJson: '["--mode","safe"]' },
    }
    const resolver = HarnessConnectionResolver.of({
      resolve: () => Effect.succeed(connectionOptions),
    })
    const connection = makeConnection(makeSession())
    const connect: DriverConnect = options =>
      Effect.sync(() => {
        receivedOptions = options
        return connection
      })
    const runtime = makeRuntime(
      () => Effect.die(new Error('The test-driver connection must not be used')),
      {},
      undefined,
      [AgentDriver.of({ driverId: 'acp', connect })],
      fakeResolverLayer(resolver),
    )

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(
        service.start({
          ...command,
          commandId: 'acp-config-forwarding',
          driverId: 'acp',
          connectionId: 'acp-connection',
        }),
      )
      await run(service.stopAll())
      expect(receivedOptions).toEqual(connectionOptions)
    } finally {
      await runtime.dispose()
    }
  })

  it('settles a missing harness connection before calling the driver', async () => {
    let connectCalls = 0
    const resolver = HarnessConnectionResolver.of({
      resolve: () =>
        Effect.fail(new HarnessConnectionResolutionError({ code: 'not-found', message: 'connection is missing' })),
    })
    const runtime = makeRuntime(
      () =>
        Effect.sync(() => {
          connectCalls += 1
          return makeConnection(makeSession())
        }),
      {},
      undefined,
      [],
      fakeResolverLayer(resolver),
    )

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start({ ...command, commandId: 'missing-harness-connection' }))
      await run(service.stopAll())
      expect(connectCalls).toBe(0)
      expect((await run(store.readTaskSnapshot(task.id, 10))).runs[0]).toMatchObject({
        status: 'failed',
        failure: 'launch-failed',
      })
    } finally {
      await runtime.dispose()
    }
  })

  it('persists steering before delivery and uses the expected native turn on receipt replay', async () => {
    const turnStarted = await Effect.runPromise(Deferred.make<undefined>())
    const finishTurn = await Effect.runPromise(Deferred.make<undefined>())
    const expectedTurns: Array<string | undefined> = []
    let steerCalls = 0
    const session = makeSession({
      events: () =>
        Stream.concat(
          Stream.succeed({ kind: 'turnStarted', nativeTurnId: 'native-turn' } as const),
          Stream.fromEffect(Deferred.await(finishTurn)).pipe(
            Stream.map(() => ({ kind: 'turnCompleted', nativeTurnId: 'native-turn' }) as const),
          ),
        ),
      steer: (_runId, expectedNativeTurnId) =>
        Effect.sync(() => {
          steerCalls += 1
          expectedTurns.push(expectedNativeTurnId)
          return { outcome: 'accepted' as const }
        }),
    })
    const runtime = makeRuntime(() => Effect.succeed(makeConnection(session)), {
      publishCommittedEvent: event =>
        event.kind === 'driverEvent' && (event.data as { event?: { kind?: string } }).event?.kind === 'turnStarted'
          ? Effect.as(Deferred.succeed(turnStarted, undefined), undefined)
          : Effect.void,
    })

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(service.start({ ...command, commandId: 'steer-run' }))
      await run(Deferred.await(turnStarted))
      const steering = {
        commandId: 'steer-once',
        issuedAt: '2026-10-29T10:00:02Z',
        runId: command.runId,
        ownerEpoch: 7,
        generation: 1,
        expectedNativeTurnId: 'native-turn',
        message: 'Use the smaller function',
      } as const
      const receipts = await Promise.all([run(service.steer(steering)), run(service.steer(steering))])
      expect(receipts.map(receipt => receipt.replayed).sort()).toEqual([false, true])
      expect(steerCalls).toBe(1)
      expect(expectedTurns).toEqual(['native-turn'])
      await run(Deferred.succeed(finishTurn, undefined))
      await run(service.stopAll())
    } finally {
      await Effect.runPromise(Deferred.succeed(finishTurn, undefined))
      await runtime.dispose()
    }
  })

  it('returns a replayed promotion without claiming or calling a native driver', async () => {
    const storeRuntime = ManagedRuntime.make(WorkspaceStoreLive({ filename: ':memory:' }))
    const store = await storeRuntime.runPromise(WorkspaceStore)
    const runStore: RunEffect = effect => storeRuntime.runPromise(effect)
    await setup(store, runStore)
    await runStore(
      store.enqueueFollowUp({
        commandId: 'queue-replayed',
        issuedAt: '2026-10-29T10:00:02Z',
        taskId: task.id,
        conversationId: conversation.id,
        prompt: 'Original queued prompt',
      }),
    )
    const original = await runStore(store.promoteNextFollowUp(conversation.id, command))
    if (!original) throw new Error('Expected the original promotion')
    const replay = { ...original, receipt: { ...original.receipt, replayed: true } }
    let claims = 0
    let connections = 0
    let submissions = 0
    const session = makeSession({
      submit: () =>
        Effect.sync(() => {
          submissions += 1
          return { nativeSessionId: 'native-session', nativeTurnId: 'native-turn', generation: 1 }
        }),
    })
    const runtime = makeRuntime(
      () =>
        Effect.sync(() => {
          connections += 1
          return makeConnection(session)
        }),
      {},
      WorkspaceStore.of({
        ...store,
        promoteNextFollowUp: () => Effect.succeed(replay),
        claimDispatch: (...args) =>
          Effect.andThen(
            Effect.sync(() => {
              claims += 1
            }),
            store.claimDispatch(...args),
          ),
      }),
    )
    try {
      const service = await runtime.runPromise(ExecutionService)
      expect(await runtime.runPromise(service.promoteQueuedFollowUp(conversation.id, command))).toEqual(replay)
      expect({ claims, connections, submissions }).toEqual({ claims: 0, connections: 0, submissions: 0 })
    } finally {
      await runtime.dispose()
      await storeRuntime.dispose()
    }
  })

  it('promotes a queued follow-up into one dispatch claim', async () => {
    let submittedPrompt: string | undefined
    let submitCalls = 0
    const finishTurn = await Effect.runPromise(Deferred.make<undefined>())
    const session = makeSession({
      submit: input =>
        Effect.sync(() => {
          submitCalls += 1
          submittedPrompt = input.messages[0]?.content
          return { nativeSessionId: 'native-session', nativeTurnId: 'queued-turn', generation: 1 }
        }),
      events: () =>
        Stream.fromEffect(Deferred.await(finishTurn)).pipe(
          Stream.map(() => ({ kind: 'turnCompleted', nativeTurnId: 'queued-turn' }) as const),
        ),
    })
    const runtime = makeRuntime(() => Effect.succeed(makeConnection(session)))

    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run: RunEffect = effect => runtime.runPromise(effect)
      await setup(store, run)
      const service = await runtime.runPromise(ExecutionService)
      await run(
        service.enqueueFollowUp({
          commandId: 'queue-1',
          issuedAt: '2026-10-29T10:00:02Z',
          taskId: task.id,
          conversationId: conversation.id,
          prompt: 'Follow up from the queue',
        }),
      )
      const promotion = {
        ...command,
        commandId: 'promote-queue-1',
        runId: 'queued-run-1' as never,
        provisionalAgentSessionId: 'queued-session-1',
      }
      const promoted = await run(service.promoteQueuedFollowUp(conversation.id, promotion))
      const replay = await run(service.promoteQueuedFollowUp(conversation.id, promotion))
      expect(promoted?.receipt).toMatchObject({ runId: 'queued-run-1', replayed: false })
      expect(replay?.receipt).toMatchObject({ runId: 'queued-run-1', replayed: true })
      await run(Deferred.succeed(finishTurn, undefined))
      await run(service.stopAll())
      expect(submittedPrompt).toBe('Follow up from the queue')
      expect(submitCalls).toBe(1)
    } finally {
      await Effect.runPromise(Deferred.succeed(finishTurn, undefined))
      await runtime.dispose()
    }
  })

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
        nativeCleanup: 'unconfirmed',
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
