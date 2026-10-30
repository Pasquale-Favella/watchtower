import { NodeServices } from '@effect/platform-node'
import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Queue from 'effect/Queue'
import * as RpcTest from 'effect/rpc/RpcTest'
import * as Stream from 'effect/Stream'
import * as SubscriptionRef from 'effect/SubscriptionRef'
import { describe, expect, it } from 'vitest'

import { ExecutionService } from '@/core/application/commands/execution-service.js'
import { WorkspaceProjects, WorkspaceProjectsLive } from '@/core/application/commands/workspace-projects.js'
import { AgentDriver, type AgentDriverSession } from '@/core/ports/agent-driver.js'
import { AgentDriverRegistry } from '@/core/ports/agent-driver-registry.js'
import { CheckoutResolver } from '@/core/ports/checkout-resolver.js'
import { HarnessConnectionResolver } from '@/core/ports/harness-connections.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import { workspaceHandlers } from '@/platform/electron/main/rpc/workspace-handlers.js'
import { WorkspaceHost, type WorkspaceHostStatus } from '@/platform/electron/main/workspace/host.js'
import { WorkspaceRpcGroup } from '@/shared/rpc/workspace.js'
import type { AgentCapabilities, AgentDriverEvent } from '@/shared/schemas/execution.js'
import { WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

const failure = new WorkspaceStoreError({ code: 'database-unavailable', message: 'secret C:\\private\\db stack' })

const failingHost = (mode: 'typed' | 'failure' | 'defect' | 'throw') =>
  Effect.gen(function* () {
    const secret = new Error('secret C:\\private\\db stack')
    return WorkspaceHost.of({
      ensureOpen: Effect.void,
      store: {
        listProjects: () => {
          switch (mode) {
            case 'typed':
              return Effect.fail(failure)
            case 'failure':
              return Effect.fail(secret)
            case 'defect':
              return Effect.die(secret)
            case 'throw':
              throw secret
          }
        },
      } as unknown as WorkspaceHost['Service']['store'],
      withExecution: () => Effect.fail(failure),
      eventHighWatermark: yield* SubscriptionRef.make(0),
      status: yield* SubscriptionRef.make<WorkspaceHostStatus>({ state: 'unavailable', ownerEpoch: undefined }),
    })
  })

const failingProjects = Layer.succeed(WorkspaceProjects, { register: () => Effect.fail(failure) })

describe('Workspace renderer RPC', () => {
  it('returns durable repository reuse across new commands without duplicating projects', async () => {
    const workspace = makeWorkspace()
    try {
      const result = await workspace.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
            const first = yield* client['workspace:registerProject']({
              commandId: 'register',
              name: 'Project',
              path: 'C:/repo',
            })
            const reused = yield* client['workspace:registerProject']({
              commandId: 'reuse',
              name: 'Another display name',
              path: 'C:/repo',
            })
            const replay = yield* client['workspace:registerProject']({
              commandId: 'reuse',
              name: 'Another display name',
              path: 'C:/repo',
            })
            const conflict = yield* client['workspace:registerProject']({
              commandId: 'reuse',
              name: 'Changed',
              path: 'C:/repo',
            }).pipe(Effect.flip)
            const listed = yield* client['workspace:listProjects']({})
            return { first, reused, replay, conflict, listed }
          }),
        ),
      )
      expect(result.first).toMatchObject({ reused: false, replayed: false })
      expect(result.reused).toEqual({ ...result.first, commandId: 'reuse', reused: true })
      expect(result.replay).toEqual({ ...result.reused, replayed: true })
      expect(result.conflict).toMatchObject({ code: 'conflict' })
      expect(result.listed.total).toBe(1)
    } finally {
      await workspace.runtime.dispose()
    }
  })

  it.each(['typed', 'failure', 'defect', 'throw'] as const)(
    'sanitizes %s failures before they cross the renderer boundary',
    async mode => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
          return yield* Effect.exit(client['workspace:listProjects']({}))
        }).pipe(
          Effect.scoped,
          Effect.provide(
            workspaceHandlers().pipe(
              Layer.provide(Layer.effect(WorkspaceHost, failingHost(mode))),
              Layer.provide(failingProjects),
              Layer.provide(
                Layer.succeed(CheckoutResolver, {
                  resolve: () => Effect.die('unused'),
                  createIsolatedWorktree: () => Effect.die('unused'),
                  removeWorktree: () => Effect.die('unused'),
                }),
              ),
            ),
          ),
          Effect.provide(NodeServices.layer),
        ),
      )
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(Cause.findError(result.cause)).toMatchObject({
          _tag: 'Success',
          success: {
            _tag: 'WorkspaceRpcError',
            code: mode === 'typed' ? 'unavailable' : 'failed',
            message: mode === 'typed' ? 'Workspace is unavailable.' : 'Workspace operation failed.',
          },
        })
        expect(JSON.stringify(result)).not.toContain('private')
      }
    },
  )
})

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
const resolver = CheckoutResolver.of({
  resolve: path =>
    Effect.succeed({
      kind: 'main',
      canonicalPath: path,
      repositoryIdentity: path.toLowerCase(),
      mainCheckoutPath: path,
      branch: 'main',
      headRevision: null,
      dirty: { trackedChanges: 0, untrackedCount: 0, ignoredCount: 0 },
    }),
  createIsolatedWorktree: () => Effect.die('unused'),
  removeWorktree: () => Effect.die('unused'),
})

function makeWorkspace(options: { readonly respondGate?: Deferred.Deferred<undefined> } = {}) {
  const nativeEvents = Effect.runSync(Queue.unbounded<AgentDriverEvent>())
  const highWatermark = Effect.runSync(SubscriptionRef.make(0))
  const submitted = Effect.runSync(Deferred.make<undefined>())
  const finished = Effect.runSync(Deferred.make<undefined>())
  const responseStarted = Effect.runSync(Deferred.make<undefined>())
  const responseFinished = Effect.runSync(Deferred.make<undefined>())
  const observations = { submissions: 0, interruptions: 0, responses: 0, steers: 0 }
  const session: AgentDriverSession = {
    identity: { nativeSessionId: 'native-session', generation: 1 },
    capabilities,
    events: () => Stream.fromQueue(nativeEvents),
    submit: () =>
      Effect.gen(function* () {
        observations.submissions++
        yield* Deferred.succeed(submitted, undefined)
        return { nativeSessionId: 'native-session', nativeTurnId: 'native-turn', generation: 1 }
      }),
    interrupt: () =>
      Effect.sync(() => {
        observations.interruptions++
        return { acknowledged: true, termination: 'stillRunning' as const }
      }),
    respond: () =>
      Effect.gen(function* () {
        observations.responses++
        yield* Deferred.succeed(responseStarted, undefined)
        if (options.respondGate) yield* Deferred.await(options.respondGate)
        yield* Deferred.succeed(responseFinished, undefined)
        return { outcome: 'accepted' as const }
      }),
    steer: () =>
      Effect.sync(() => {
        observations.steers++
        return { outcome: 'accepted' as const }
      }),
    reconcile: () => Stream.empty,
  }
  const base = Layer.mergeAll(
    WorkspaceStoreLive({ filename: ':memory:' }),
    Layer.succeed(CheckoutResolver, resolver),
    Layer.succeed(HarnessConnectionResolver, { resolve: connectionId => Effect.succeed({ connectionId }) }),
    Layer.succeed(
      AgentDriverRegistry,
      AgentDriverRegistry.fromDrivers([
        AgentDriver.of({
          driverId: 'test-driver',
          connect: () =>
            Effect.succeed({
              identity: { id: 'connection', driverId: 'test-driver', authentication: 'authenticated' },
              discover: () => Effect.succeed(capabilities),
              openSession: () => Effect.succeed(session),
              loadSession: () => Effect.succeed(session),
              close: () => Effect.void,
            }),
        }),
      ]),
    ),
  )
  const execution = ExecutionService.layer({
    ownerEpoch: 1,
    closeDeadlineMs: 100,
    publishCommittedEvent: event =>
      Effect.gen(function* () {
        yield* SubscriptionRef.set(highWatermark, event.sequence)
        if (event.kind === 'driverEvent' && (event.data.event as AgentDriverEvent).kind === 'turnCompleted')
          yield* Deferred.succeed(finished, undefined)
      }),
  }).pipe(Layer.provideMerge(base))
  const host = Layer.effect(
    WorkspaceHost,
    Effect.gen(function* () {
      const store = yield* WorkspaceStore
      const service = yield* ExecutionService
      return WorkspaceHost.of({
        store,
        ensureOpen: Effect.void,
        eventHighWatermark: highWatermark,
        status: yield* SubscriptionRef.make<WorkspaceHostStatus>({ state: 'ready', ownerEpoch: 1 }),
        withExecution: use =>
          use(service, 1).pipe(
            Effect.tap(() =>
              store
                .pageEvents(0, 1)
                .pipe(Effect.flatMap(page => SubscriptionRef.set(highWatermark, page.highWatermark))),
            ),
          ),
      })
    }),
  ).pipe(Layer.provideMerge(execution))
  const application = WorkspaceProjectsLive.pipe(Layer.provideMerge(host))
  const runtime = ManagedRuntime.make(
    workspaceHandlers().pipe(Layer.provideMerge(application), Layer.provideMerge(NodeServices.layer)),
  )
  const close = async () => {
    if (observations.submissions > 0) {
      await runtime.runPromise(Queue.offer(nativeEvents, { kind: 'turnCompleted', nativeTurnId: 'native-turn' }))
      await runtime.runPromise(Deferred.await(finished).pipe(Effect.timeout('2 seconds')))
    }
    await runtime.dispose()
  }
  return { runtime, observations, submitted, nativeEvents, highWatermark, close, responseStarted, responseFinished }
}

const seed = Effect.gen(function* () {
  const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
  const registration = yield* client['workspace:registerProject']({
    commandId: 'project',
    name: 'Project',
    path: 'C:\\repo',
  })
  const task = yield* client['workspace:createTask']({
    commandId: 'task',
    projectId: registration.project.id,
    title: 'Fix bug',
    description: 'Preserve the objective',
  })
  return {
    registration,
    task,
    request: {
      commandId: 'start',
      taskId: task.taskId,
      conversationId: task.conversationId,
      checkoutId: registration.mainCheckout.id,
      generation: 1,
      driverId: 'test-driver',
      connectionId: 'connection',
      prompt: 'Fix it',
    },
  }
})

it('registers Projects and creates Tasks with stable identities across reconnects and rejects conflicting reuse', async () => {
  const { runtime, close } = makeWorkspace()
  try {
    const first = await runtime.runPromise(seed.pipe(Effect.scoped))
    const replay = await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        return {
          project: yield* client['workspace:registerProject']({
            commandId: 'project',
            name: 'Project',
            path: 'C:\\repo',
          }),
          task: yield* client['workspace:createTask']({
            commandId: 'task',
            projectId: first.registration.project.id,
            title: 'Fix bug',
            description: 'Preserve the objective',
          }),
          conflict: yield* Effect.exit(
            client['workspace:createTask']({
              commandId: 'task',
              projectId: first.registration.project.id,
              title: 'Different objective',
              description: '',
            }),
          ),
          projectConflict: yield* Effect.exit(
            client['workspace:registerProject']({ commandId: 'project', name: 'Project', path: 'C:\\different' }),
          ),
        }
      }).pipe(Effect.scoped),
    )
    expect(replay.project).toMatchObject({
      commandId: 'project',
      replayed: true,
      project: { id: first.registration.project.id },
    })
    expect(replay.task).toEqual({ ...first.task, replayed: true })
    for (const result of [replay.conflict, replay.projectConflict]) {
      expect(result._tag).toBe('Failure')
      if (result._tag === 'Failure')
        expect(Cause.findError(result.cause)).toMatchObject({ _tag: 'Success', success: { code: 'conflict' } })
    }
  } finally {
    await close()
  }
})
it('returns the original start receipt after a new client connects without redispatching native work', async () => {
  const { runtime, observations, submitted, close } = makeWorkspace()
  try {
    const { request } = await runtime.runPromise(seed.pipe(Effect.scoped))
    const first = await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        return yield* client['workspace:startRun'](request)
      }).pipe(Effect.scoped),
    )
    await runtime.runPromise(Deferred.await(submitted))
    await new Promise(resolve => setTimeout(resolve, 5))
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        const second = yield* client['workspace:startRun'](request)
        const conflict = yield* Effect.exit(client['workspace:startRun']({ ...request, prompt: 'Different work' }))
        const history = yield* client['workspace:readConversationPage']({
          conversationId: request.conversationId,
          afterSequence: 0,
          limit: 100,
        })
        return { second, conflict, history }
      }).pipe(Effect.scoped),
    )
    expect(result.second).toEqual({ ...first, replayed: true })
    expect(observations.submissions).toBe(1)
    expect(result.history.items.filter(item => item.event.kind === 'runQueued')).toHaveLength(1)
    expect(Exit.isFailure(result.conflict)).toBe(true)
  } finally {
    await close()
  }
})

it('delivers fixed Snapshot pages then live Events without gaps or duplicates across the watermark handoff', async () => {
  const { runtime, nativeEvents, close } = makeWorkspace()
  try {
    const { request } = await runtime.runPromise(seed.pipe(Effect.scoped))
    const frames = await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        yield* client['workspace:startRun'](request)
        let sent = false
        return yield* client['workspace:events']({ afterSequence: 0 }).pipe(
          Stream.tap(frame => {
            if (frame._tag !== 'Snapshot' || sent) return Effect.void
            sent = true
            return Queue.offerAll(nativeEvents, [
              { kind: 'textDelta', text: 'answer', itemId: 'item' },
              { kind: 'turnCompleted', nativeTurnId: 'native-turn' },
            ])
          }),
          Stream.takeUntil(frame =>
            frame.page.events.some(
              event => event.kind === 'driverEvent' && (event.data.event as AgentDriverEvent).kind === 'turnCompleted',
            ),
          ),
          Stream.runCollect,
          Effect.timeout('3 seconds'),
        )
      }).pipe(Effect.scoped),
    )
    expect(frames[0]._tag).toBe('Snapshot')
    expect(frames.at(-1)?._tag).toBe('Events')
    expect(frames.flatMap(frame => frame.page.events.map(event => event.sequence))).toEqual([1, 2, 3, 4, 5])
    expect(frames.flatMap(frame => frame.page.events.map(event => event.kind))).toEqual([
      'runQueued',
      'dispatchClaimed',
      'runStarted',
      'driverEvent',
      'driverEvent',
    ])
    for (const frame of frames)
      expect(frame.page.events.every(event => event.sequence <= frame.throughSequence)).toBe(true)
  } finally {
    await close()
  }
})

it('cancelling an event subscription leaves the native run running and reconnect resumes only newer sequences', async () => {
  const { runtime, observations, submitted, close } = makeWorkspace()
  try {
    const { request } = await runtime.runPromise(seed.pipe(Effect.scoped))
    const first = await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        yield* client['workspace:startRun'](request)
        yield* Deferred.await(submitted)
        return yield* client['workspace:events']({ afterSequence: 0 }).pipe(Stream.take(1), Stream.runCollect)
      }).pipe(Effect.scoped),
    )
    expect(observations).toMatchObject({ submissions: 1, interruptions: 0 })
    const afterSequence = first[0].page.events.at(-1)?.sequence ?? 0
    const second = await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        return yield* client['workspace:events']({ afterSequence }).pipe(Stream.take(1), Stream.runCollect)
      }).pipe(Effect.scoped),
    )
    expect(second[0].page.events.every(event => event.sequence > afterSequence)).toBe(true)
    expect(observations.interruptions).toBe(0)
  } finally {
    await close()
  }
})

it.each(['slow', 'oversized', 'bytes'] as const)(
  'ends a %s subscriber with a typed overflow instead of silently dropping event pages',
  async mode => {
    const total = mode === 'slow' ? 2000 : 20
    const data =
      mode === 'slow' ? {} : { content: 'x'.repeat(mode === 'oversized' ? 4 * 1024 * 1024 : 2 * 1024 * 1024) }
    const host = Effect.gen(function* () {
      return WorkspaceHost.of({
        ensureOpen: Effect.void,
        withExecution: () => Effect.die('subscriptions cannot acquire execution'),
        status: yield* SubscriptionRef.make<WorkspaceHostStatus>({ state: 'ready', ownerEpoch: 1 }),
        eventHighWatermark: yield* SubscriptionRef.make(total),
        store: {
          pageEvents: (after: number, limit: number, through = total) => {
            const count = Math.min(mode === 'slow' ? limit : 1, through - after)
            return Effect.succeed({
              highWatermark: total,
              events: Array.from({ length: count }, (_, index) => ({
                sequence: after + index + 1,
                schemaVersion: 1 as const,
                kind: 'runQueued' as const,
                runId: 'run' as never,
                taskId: 'task' as never,
                generation: 1,
                occurredAt: '2026-10-30T10:00:00Z',
                data,
              })),
              nextAfterSequence: after + count < through ? after + count : null,
              hasMore: after + count < through,
            })
          },
        } as unknown as WorkspaceHost['Service']['store'],
      })
    })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        return yield* Effect.exit(
          client['workspace:events']({ afterSequence: 0 }).pipe(
            Stream.mapEffect(frame => Effect.as(Effect.sleep('20 millis'), frame)),
            Stream.runCollect,
            Effect.timeout('3 seconds'),
          ),
        )
      }).pipe(
        Effect.scoped,
        Effect.provide(
          workspaceHandlers().pipe(
            Layer.provide(Layer.effect(WorkspaceHost, host)),
            Layer.provide(failingProjects),
            Layer.provide(Layer.succeed(CheckoutResolver, resolver)),
          ),
        ),
        Effect.provide(NodeServices.layer),
      ),
    )
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result))
      expect(Cause.findError(result.cause)).toMatchObject({
        _tag: 'Success',
        success: { _tag: 'WorkspaceRpcError', code: 'stream-overflow' },
      })
  },
)

it('validates project registration before creating any project', async () => {
  const { runtime, close } = makeWorkspace()
  try {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        return {
          invalid: yield* Effect.exit(
            client['workspace:registerProject']({ commandId: 'bad-project', name: '', path: 'C:\\repo' }),
          ),
          projects: yield* client['workspace:listProjects']({}),
        }
      }).pipe(Effect.scoped),
    )
    expect(Exit.isFailure(result.invalid)).toBe(true)
    expect(result.projects.items).toEqual([])
  } finally {
    await close()
  }
})

it('derives distinct Task identities for command IDs that differ only by unpaired surrogates', async () => {
  const { runtime, close } = makeWorkspace()
  try {
    const first = await runtime.runPromise(seed.pipe(Effect.scoped))
    const tasks = await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        const create = (commandId: string) =>
          client['workspace:createTask']({
            commandId,
            projectId: first.registration.project.id,
            title: 'Surrogate',
            description: '',
          })
        return [yield* create('id-\uD800'), yield* create('id-\uD801')] as const
      }).pipe(Effect.scoped),
    )
    expect(tasks[0].taskId).not.toBe(tasks[1].taskId)
    expect(tasks.map(task => task.replayed)).toEqual([false, false])
  } finally {
    await close()
  }
})

it('repeated interrupt after reconnect is a no-op while the existing interrupt is pending', async () => {
  const { runtime, observations, submitted, close } = makeWorkspace()
  try {
    const { request } = await runtime.runPromise(seed.pipe(Effect.scoped))
    const receipt = await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        const receipt = yield* client['workspace:startRun'](request)
        yield* Deferred.await(submitted)
        yield* client['workspace:interrupt']({ commandId: 'interrupt', runId: receipt.runId })
        return receipt
      }).pipe(Effect.scoped),
    )
    const repeated = await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        const interrupt = yield* client['workspace:interrupt']({ commandId: 'interrupt', runId: receipt.runId })
        const events = yield* client['workspace:readConversationPage']({
          conversationId: request.conversationId,
          afterSequence: 0,
          limit: 100,
        })
        return { interrupt, events }
      }).pipe(Effect.scoped),
    )
    expect(repeated.interrupt).toMatchObject({
      commandId: 'interrupt',
      runId: receipt.runId,
      outcome: 'interruptRequested',
    })
    expect(observations.interruptions).toBe(1)
    expect(repeated.events.items.filter(item => item.event.kind === 'runInterruptRequested')).toHaveLength(1)
  } finally {
    await close()
  }
})

it('replays a queued follow-up receipt and deterministically reports cancellation after its removal', async () => {
  const { runtime, close } = makeWorkspace()
  try {
    const { task } = await runtime.runPromise(seed.pipe(Effect.scoped))
    const request = {
      commandId: 'queued',
      taskId: task.taskId,
      conversationId: task.conversationId,
      prompt: 'Next work',
    }
    const first = await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        return yield* client['workspace:enqueueFollowUp'](request)
      }).pipe(Effect.scoped),
    )
    await new Promise(resolve => setTimeout(resolve, 5))
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        const replay = yield* client['workspace:enqueueFollowUp'](request)
        const cancel = { commandId: 'cancel', conversationId: task.conversationId, targetCommandId: 'queued' }
        return {
          replay,
          cancelled: yield* client['workspace:cancelQueuedFollowUp'](cancel),
          repeated: yield* client['workspace:cancelQueuedFollowUp'](cancel),
          queue: yield* client['workspace:listQueuedFollowUps']({ conversationId: task.conversationId }),
          replayAfterRemoval: yield* client['workspace:enqueueFollowUp'](request),
        }
      }).pipe(Effect.scoped),
    )
    expect(result.replay).toEqual({ ...first, replayed: true })
    expect(result.cancelled.outcome).toBe('removed')
    expect(result.repeated).toEqual(result.cancelled)
    expect(result.queue.items).toEqual([])
    expect(result.replayAfterRemoval).toEqual({ ...first, replayed: true })
  } finally {
    await close()
  }
})

it('replays response and steering receipts after reconnect without redelivering native controls', async () => {
  const { runtime, nativeEvents, observations, close } = makeWorkspace()
  try {
    const { request } = await runtime.runPromise(seed.pipe(Effect.scoped))
    const first = await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        const started = yield* client['workspace:startRun'](request)
        let pending = false
        yield* client['workspace:events']({ afterSequence: 0 }).pipe(
          Stream.tap(() => {
            if (pending) return Effect.void
            pending = true
            return Queue.offer(nativeEvents, {
              kind: 'requestPending',
              request: {
                requestId: 'approval',
                runId: started.runId,
                generation: 1,
                kind: 'approval',
                prompt: 'Allow?',
                questions: [],
              },
            })
          }),
          Stream.takeUntil(frame =>
            frame.page.events.some(
              event => event.kind === 'driverEvent' && (event.data.event as AgentDriverEvent).kind === 'requestPending',
            ),
          ),
          Stream.runDrain,
          Effect.timeout('3 seconds'),
        )
        const respond = {
          commandId: 'respond',
          runId: started.runId,
          generation: 1,
          requestId: 'approval',
          decision: { kind: 'approve' as const },
        }
        const steer = {
          commandId: 'steer',
          runId: started.runId,
          generation: 1,
          message: 'Keep tests focused',
          expectedNativeTurnId: 'native-turn',
        }
        return {
          respond,
          steer,
          response: yield* client['workspace:respond'](respond),
          steering: yield* client['workspace:steer'](steer),
        }
      }).pipe(Effect.scoped),
    )
    await new Promise(resolve => setTimeout(resolve, 5))
    const second = await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        return {
          response: yield* client['workspace:respond'](first.respond),
          steering: yield* client['workspace:steer'](first.steer),
          responses: yield* client['workspace:listRequestResponses']({ taskId: request.taskId }),
          steers: yield* client['workspace:listSteerIntents']({ taskId: request.taskId }),
        }
      }).pipe(Effect.scoped),
    )
    expect(second.response).toEqual({ ...first.response, replayed: true })
    expect(second.steering).toEqual({ ...first.steering, replayed: true })
    expect(second.responses.items).toHaveLength(1)
    expect(second.steers.items).toHaveLength(1)
    expect(observations).toMatchObject({ responses: 1, steers: 1 })
  } finally {
    await close()
  }
})

it('replays a promotion receipt without dequeuing another follow-up or dispatching another run', async () => {
  const { runtime, observations, submitted, close } = makeWorkspace()
  try {
    const { request } = await runtime.runPromise(seed.pipe(Effect.scoped))
    const promotion = { ...request, commandId: 'promotion' }
    const first = await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        yield* client['workspace:enqueueFollowUp']({
          commandId: 'queue-for-promotion',
          taskId: request.taskId,
          conversationId: request.conversationId,
          prompt: 'Promoted work',
        })
        return yield* client['workspace:promoteQueuedFollowUp'](promotion)
      }).pipe(Effect.scoped),
    )
    await runtime.runPromise(Deferred.await(submitted))
    await new Promise(resolve => setTimeout(resolve, 5))
    const second = await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        return yield* client['workspace:promoteQueuedFollowUp'](promotion)
      }).pipe(Effect.scoped),
    )
    expect(first).not.toBeNull()
    if (first === null) throw new Error('Expected a promotion receipt')
    expect(second).toEqual({ ...first, receipt: { ...first.receipt, replayed: true } })
    expect(observations.submissions).toBe(1)
  } finally {
    await close()
  }
})

it('caller cancellation during a native response does not cancel application-owned delivery or repeat it on reconnect', async () => {
  const allowResponse = Effect.runSync(Deferred.make<undefined>())
  const { runtime, nativeEvents, responseStarted, responseFinished, observations, close } = makeWorkspace({
    respondGate: allowResponse,
  })
  try {
    const { request } = await runtime.runPromise(seed.pipe(Effect.scoped))
    const responseRequest = await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        const receipt = yield* client['workspace:startRun'](request)
        yield* Queue.offer(nativeEvents, {
          kind: 'requestPending',
          request: {
            requestId: 'approval',
            runId: receipt.runId,
            generation: 1,
            kind: 'approval',
            prompt: 'Allow?',
            questions: [],
          },
        })
        yield* client['workspace:events']({ afterSequence: 0 }).pipe(
          Stream.takeUntil(frame =>
            frame.page.events.some(
              event => event.kind === 'driverEvent' && (event.data.event as AgentDriverEvent).kind === 'requestPending',
            ),
          ),
          Stream.runDrain,
        )
        const response = {
          commandId: 'disconnected-response',
          runId: receipt.runId,
          generation: 1,
          requestId: 'approval',
          decision: { kind: 'approve' as const },
        }
        const waiting = yield* Effect.forkScoped(client['workspace:respond'](response))
        yield* Deferred.await(responseStarted)
        yield* Fiber.interrupt(waiting)
        yield* Deferred.succeed(allowResponse, undefined)
        yield* Deferred.await(responseFinished)
        return response
      }).pipe(Effect.scoped, Effect.timeout('3 seconds')),
    )
    const replay = await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(WorkspaceRpcGroup)
        return yield* client['workspace:respond'](responseRequest)
      }).pipe(Effect.scoped),
    )
    expect(replay).toMatchObject({ commandId: 'disconnected-response', replayed: true })
    expect(observations).toMatchObject({ responses: 1, submissions: 1, interruptions: 0 })
  } finally {
    await Effect.runPromise(Deferred.succeed(allowResponse, undefined))
    await close()
  }
})
