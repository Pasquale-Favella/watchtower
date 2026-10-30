import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'
import * as SubscriptionRef from 'effect/SubscriptionRef'

import { ExecutionService, ExecutionServiceError } from '@/core/application/commands/execution-service.js'
import { AgentDriverRegistry } from '@/core/ports/agent-driver-registry.js'
import { CheckoutResolver } from '@/core/ports/checkout-resolver.js'
import { HarnessConnectionResolutionError, HarnessConnectionResolver } from '@/core/ports/harness-connections.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import type { WorkspaceWorkerSupervisorOptions } from '@/platform/electron/main/workspace/supervisor.js'
import {
  WorkspaceWorkerSupervisor,
  WorkspaceWorkerSupervisorLive,
} from '@/platform/electron/main/workspace/supervisor.js'
import type { HarnessConnection } from '@/shared/schemas/harness-connections.js'
import type { WorkspaceConnection } from '@/shared/schemas/workspace-connections.js'
import { WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'
import type { HarnessConnectionCatalog } from '@/infrastructure/agent-harnesses/connection-catalog.js'

const UNAVAILABLE = 'Workspace execution is unavailable until owned resources are confirmed closed.'

export class WorkspaceHostError extends Schema.TaggedError<WorkspaceHostError>()('WorkspaceHostError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface WorkspaceHostOptions extends WorkspaceWorkerSupervisorOptions {
  readonly loadConnections?: () => Effect.Effect<ReadonlyArray<HarnessConnection>, unknown>
  /** Loads the immutable execution definitions and their renderer-safe catalog rows together. */
  readonly loadConnectionCatalog?: () => Effect.Effect<HarnessConnectionCatalog, unknown>
  readonly loadDrivers?: () => Effect.Effect<AgentDriverRegistry['Service'], unknown>
  readonly loadCheckoutResolver?: () => Effect.Effect<CheckoutResolver['Service'], unknown>
  readonly runtimeExecutable?: string
  readonly closeDeadlineMs?: number
}

type SupervisorContext = Context.Context<WorkspaceWorkerSupervisor>
type Execution = ExecutionService['Service']

interface OwnedExecution {
  readonly ownerEpoch: number
  readonly service: Execution
  readonly scope: Scope.Closeable
  readonly leases: Set<Fiber.Fiber<unknown, unknown>>
  retiring: boolean
  retirementFailure?: ExecutionServiceError
}

export class WorkspaceHost extends Context.Service<
  WorkspaceHost,
  {
    readonly store: WorkspaceStore['Service']
    /** The first opening failure is sticky; retry requires a new application host. */
    readonly ensureOpen: Effect.Effect<void, WorkspaceStoreError>
    readonly withExecution: <A, E, R>(
      use: (execution: Execution, ownerEpoch: number) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<
      A,
      E | WorkspaceHostError | WorkspaceStoreError | ExecutionServiceError | HarnessConnectionResolutionError,
      R | ChildProcessSpawner.ChildProcessSpawner
    >
    /** Lazy catalog read that does not open the workspace worker or acquire ExecutionService. */
    readonly listConnections?: Effect.Effect<ReadonlyArray<WorkspaceConnection>, WorkspaceHostError>
    readonly eventHighWatermark: SubscriptionRef.SubscriptionRef<number>
    readonly status: SubscriptionRef.SubscriptionRef<WorkspaceHostStatus>
  }
>()('watchtower/platform/electron/WorkspaceHost') {}

export interface WorkspaceHostStatus {
  readonly state: 'not-started' | 'opening' | 'ready' | 'replacing' | 'unavailable' | 'stopped'
  readonly ownerEpoch: number | undefined
}

function unavailableStore(message = 'Workspace storage is unavailable.'): WorkspaceStoreError {
  return new WorkspaceStoreError({ code: 'database-unavailable', message })
}

const closedExecution = () =>
  new ExecutionServiceError({ reason: 'service-stopped', message: UNAVAILABLE, nativeCleanup: 'unconfirmed' })

/** The service itself is inert at acquisition. Its child application scope is opened on demand. */
export const WorkspaceHostLive = (options: WorkspaceHostOptions) =>
  Layer.effect(
    WorkspaceHost,
    Effect.gen(function* () {
      const appScope = yield* Scope.Scope
      const closeDeadlineMs = options.closeDeadlineMs ?? 10_000
      const gate = yield* Semaphore.make(1)
      const executionGate = yield* Semaphore.make(1)
      const eventHighWatermark = yield* SubscriptionRef.make(0)
      const status = yield* SubscriptionRef.make<WorkspaceHostStatus>({ state: 'not-started', ownerEpoch: undefined })
      let hostScope: Scope.Closeable | undefined
      let supervisor: WorkspaceWorkerSupervisor['Service'] | undefined
      let supervisorContext: SupervisorContext | undefined
      let openFailure: WorkspaceStoreError | undefined
      let execution: OwnedExecution | undefined
      let driverRegistry: AgentDriverRegistry['Service'] | undefined
      let checkoutResolver: CheckoutResolver['Service'] | undefined
      let opening: Deferred.Deferred<SupervisorContext, WorkspaceStoreError> | undefined
      let stopped = false

      const retireExecution = Effect.fn('WorkspaceHost.retireExecution')(function* () {
        const owned = execution
        if (!owned) return
        if (owned.retirementFailure) return yield* owned.retirementFailure
        const startedAt = yield* Clock.currentTimeMillis
        const shutdown = yield* Effect.exit(owned.service.stopAll())
        owned.retiring = true
        const remainingMs = Math.max(1, closeDeadlineMs - ((yield* Clock.currentTimeMillis) - startedAt))
        const released = yield* Effect.exit(Fiber.interruptAll(owned.leases).pipe(Effect.timeoutOption(remainingMs)))
        if (Exit.isFailure(released) || Option.isNone(released.value)) {
          owned.retirementFailure = new ExecutionServiceError({
            reason: 'background-failure',
            message: 'Execution epoch leases could not be confirmed retired before the shutdown deadline',
            nativeCleanup: 'unconfirmed',
            ...(Exit.isFailure(released) ? { cause: released.cause } : {}),
          })
          return yield* owned.retirementFailure
        }
        yield* Scope.close(owned.scope, Exit.void)
        if (
          Exit.isSuccess(shutdown) ||
          shutdown.cause.reasons.some(reason => reason._tag === 'Fail' && reason.error.nativeCleanup === 'confirmed')
        )
          execution = undefined
        if (Exit.isFailure(shutdown)) return yield* Effect.failCause(shutdown.cause)
      })

      const openApplication = Effect.fn('WorkspaceHost.openApplication')(function* () {
        yield* SubscriptionRef.set(status, { state: 'opening', ownerEpoch: undefined })
        const scope = yield* Scope.make()
        hostScope = scope
        const layer = WorkspaceWorkerSupervisorLive({
          ...options,
          beforeReplace: () =>
            executionGate.withPermit(retireExecution()).pipe(
              Effect.catch(error => (error.nativeCleanup === 'confirmed' ? Effect.void : Effect.fail(error))),
              Effect.andThen(() => options.beforeReplace?.() ?? Effect.void),
            ),
        })
        const context = yield* Layer.buildWithScope(layer, scope)
        const current = Context.get(context, WorkspaceWorkerSupervisor)
        if ((yield* SubscriptionRef.get(current.status)).state !== 'ready') {
          yield* Scope.close(scope, Exit.void)
          yield* SubscriptionRef.set(status, { state: 'unavailable', ownerEpoch: undefined })
          return yield* unavailableStore()
        }
        supervisorContext = context
        supervisor = current
        const refreshStatus = Effect.gen(function* () {
          if (stopped) return
          const workerStatus = yield* SubscriptionRef.get(current.status)
          const ownerEpoch = yield* SubscriptionRef.get(current.ownerEpoch)
          const state: WorkspaceHostStatus['state'] = workerStatus.state === 'starting' ? 'opening' : workerStatus.state
          yield* SubscriptionRef.set(status, {
            state,
            ownerEpoch,
          })
        })
        const syncHighWatermark = current.store.pageEvents(0, 1).pipe(
          Effect.tap(page => SubscriptionRef.update(eventHighWatermark, value => Math.max(value, page.highWatermark))),
          Effect.asVoid,
          Effect.catchCause(() => Effect.void),
        )
        yield* Effect.forkIn(
          Stream.runForEach(SubscriptionRef.changes(current.status), workerStatus =>
            workerStatus.state === 'ready' ? Effect.andThen(syncHighWatermark, refreshStatus) : refreshStatus,
          ),
          appScope,
        )
        yield* Effect.forkIn(
          Stream.runForEach(SubscriptionRef.changes(current.ownerEpoch), () => refreshStatus),
          appScope,
        )
        yield* Effect.andThen(syncHighWatermark, refreshStatus)
      })

      const getSupervisor = Effect.fn('WorkspaceHost.getSupervisor')(function* () {
        if (stopped) return yield* unavailableStore('Workspace host is stopped.')
        if (supervisorContext) return supervisorContext
        // Opening failures are sticky: only a new application host may retry acquisition.
        if (openFailure) return yield* Effect.fail(openFailure)
        const pending = yield* gate.withPermit(
          Effect.gen(function* () {
            if (stopped || supervisorContext || openFailure) return undefined
            if (!opening) {
              const deferred = yield* Deferred.make<SupervisorContext, WorkspaceStoreError>()
              opening = deferred
              yield* Effect.forkIn(
                Effect.flatMap(openApplication(), () =>
                  supervisorContext ? Effect.succeed(supervisorContext) : Effect.fail(unavailableStore()),
                ).pipe(
                  Effect.tapError(error =>
                    Effect.gen(function* () {
                      openFailure = error
                      if (!stopped) yield* SubscriptionRef.set(status, { state: 'unavailable', ownerEpoch: undefined })
                    }),
                  ),
                  Effect.exit,
                  Effect.flatMap(exit => Deferred.done(deferred, exit)),
                ),
                appScope,
              )
            }
            return opening
          }),
        )
        if (supervisorContext) return supervisorContext
        if (openFailure) return yield* Effect.fail(openFailure)
        if (!pending) return yield* Effect.fail(unavailableStore())
        return yield* Deferred.await(pending)
      })

      const catalogLoad = options.loadConnectionCatalog
        ? options
            .loadConnectionCatalog()
            .pipe(
              Effect.mapError(
                cause => new WorkspaceHostError({ message: 'Harness connections could not be loaded.', cause }),
              ),
            )
        : (options.loadConnections?.() ?? Effect.succeed([])).pipe(
            Effect.map(connections => ({ connections, rows: [] })),
            Effect.mapError(
              cause => new WorkspaceHostError({ message: 'Harness connections could not be loaded.', cause }),
            ),
          )
      // Constructing the cache is inert; the loader runs on first list or execution request.
      // Effect.cached also coalesces concurrent callers and retries an interrupted first load.
      const getConnectionCatalog = yield* Effect.cached(catalogLoad)

      const getExecution = Effect.fn('WorkspaceHost.getExecution')(function* () {
        const context = yield* getSupervisor()
        const owner = Context.get(context, WorkspaceWorkerSupervisor)
        const isCurrent = (epoch: number) =>
          !stopped &&
          SubscriptionRef.getUnsafe(owner.status).state === 'ready' &&
          SubscriptionRef.getUnsafe(owner.ownerEpoch) === epoch
        const ownerEpoch = yield* SubscriptionRef.get(owner.ownerEpoch)
        if (ownerEpoch === undefined || !isCurrent(ownerEpoch)) return yield* closedExecution()
        if (execution?.ownerEpoch === ownerEpoch) return execution
        yield* retireExecution().pipe(
          Effect.catch(error => (error.nativeCleanup === 'confirmed' ? Effect.void : Effect.fail(error))),
        )
        const scope = hostScope
        if (!scope) return yield* new WorkspaceHostError({ message: 'Workspace application scope is unavailable.' })
        if (!driverRegistry) {
          if (options.loadDrivers)
            driverRegistry = yield* options
              .loadDrivers()
              .pipe(
                Effect.mapError(
                  cause => new WorkspaceHostError({ message: 'Harness drivers could not be loaded.', cause }),
                ),
              )
          else {
            const { agentDriverRegistryLayer } = yield* Effect.tryPromise({
              try: () => import('@/infrastructure/agent-harnesses/drivers/registry.js'),
              catch: cause => new WorkspaceHostError({ message: 'Harness drivers could not be loaded.', cause }),
            })
            const driversContext = yield* Layer.buildWithScope(
              agentDriverRegistryLayer({ runtimeExecutable: options.runtimeExecutable }),
              scope,
            )
            driverRegistry = Context.get(driversContext, AgentDriverRegistry)
          }
        }
        if (!checkoutResolver) {
          if (options.loadCheckoutResolver)
            checkoutResolver = yield* options
              .loadCheckoutResolver()
              .pipe(
                Effect.mapError(
                  cause => new WorkspaceHostError({ message: 'Checkout validation could not be loaded.', cause }),
                ),
              )
          else {
            const [{ CheckoutResolverLive }, { CommandRunnerLive }, NodeFileSystem, NodePath] =
              yield* Effect.tryPromise({
                try: () =>
                  Promise.all([
                    import('@/infrastructure/filesystem/checkout-resolver.js'),
                    import('@/infrastructure/process/command-runner.js'),
                    import('@effect/platform-node/NodeFileSystem'),
                    import('@effect/platform-node/NodePath'),
                  ]),
                catch: cause => new WorkspaceHostError({ message: 'Checkout validation could not be loaded.', cause }),
              })
            const checkoutContext = yield* Layer.buildWithScope(
              CheckoutResolverLive.pipe(
                Layer.provide(CommandRunnerLive),
                Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
              ),
              scope,
            )
            checkoutResolver = Context.get(checkoutContext, CheckoutResolver)
          }
        }
        const { connections } = yield* getConnectionCatalog
        if (!isCurrent(ownerEpoch)) return yield* closedExecution()
        const layers = Layer.mergeAll(
          Layer.succeed(WorkspaceStore, owner.store),
          Layer.succeed(CheckoutResolver, checkoutResolver),
          Layer.succeed(AgentDriverRegistry, driverRegistry),
          HarnessConnectionResolver.layer(connections, { runtimeExecutable: options.runtimeExecutable }),
        )
        const serviceScope = yield* Scope.make()
        const serviceContext = yield* Layer.buildWithScope(
          ExecutionService.layer({
            ownerEpoch,
            closeDeadlineMs: options.closeDeadlineMs,
            publishCommittedEvent: event =>
              SubscriptionRef.update(eventHighWatermark, value => Math.max(value, event.sequence)),
          }),
          serviceScope,
        ).pipe(
          Effect.provide(layers),
          Effect.onExit(exit => (Exit.isFailure(exit) ? Scope.close(serviceScope, Exit.void) : Effect.void)),
        )
        const service = Context.get(serviceContext, ExecutionService)
        execution = { ownerEpoch, service, scope: serviceScope, leases: new Set(), retiring: false }
        if (!isCurrent(ownerEpoch)) {
          yield* retireExecution()
          return yield* closedExecution()
        }
        return execution
      })

      const store = new Proxy({} as WorkspaceStore['Service'], {
        get: (_target, key) => {
          if (typeof key !== 'string' || key === 'then' || key in Object.prototype) return undefined
          return (...args: ReadonlyArray<unknown>) =>
            Effect.suspend(() =>
              getSupervisor().pipe(
                Effect.flatMap(context => {
                  const service = Context.get(context, WorkspaceWorkerSupervisor).store
                  const operation: unknown = Reflect.get(service, key)
                  if (typeof operation !== 'function')
                    return Effect.fail(
                      new WorkspaceStoreError({ code: 'invalid-data', message: 'Unknown workspace operation.' }),
                    )
                  return (
                    operation as (...values: ReadonlyArray<unknown>) => Effect.Effect<unknown, WorkspaceStoreError>
                  )(...args)
                }),
              ),
            )
        },
      })
      const ensureOpen: WorkspaceHost['Service']['ensureOpen'] = getSupervisor().pipe(Effect.asVoid)
      // Admission is serialized; each callback holds an independently interruptible epoch lease.
      const withExecution: WorkspaceHost['Service']['withExecution'] = use =>
        Effect.gen(function* () {
          const fiber = yield* executionGate.withPermit(
            Effect.gen(function* () {
              const owned = yield* getExecution()
              return yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  const admitted = yield* Deferred.make<undefined>()
                  const leaseRef: { current?: Fiber.Fiber<unknown, unknown> } = {}
                  const callback = Effect.gen(function* () {
                    yield* Deferred.await(admitted)
                    if (
                      stopped ||
                      owned.retiring ||
                      execution !== owned ||
                      !supervisor ||
                      SubscriptionRef.getUnsafe(supervisor.status).state !== 'ready' ||
                      SubscriptionRef.getUnsafe(supervisor.ownerEpoch) !== owned.ownerEpoch
                    )
                      return yield* closedExecution()
                    return yield* use(owned.service, owned.ownerEpoch)
                  }).pipe(
                    Effect.ensuring(
                      Effect.suspend(() => {
                        if (leaseRef.current) owned.leases.delete(leaseRef.current)
                        return owned.retiring && owned.leases.size === 0
                          ? Scope.close(owned.scope, Exit.void)
                          : Effect.void
                      }),
                    ),
                  )
                  const fiber = yield* Effect.forkIn(Effect.interruptible(callback), owned.scope, {
                    startImmediately: true,
                  })
                  leaseRef.current = fiber
                  owned.leases.add(fiber)
                  yield* Deferred.succeed(admitted, undefined)
                  return fiber
                }),
              )
            }),
          )
          return yield* Fiber.join(fiber).pipe(
            Effect.onInterrupt(() => Fiber.interrupt(fiber).pipe(Effect.timeoutOption(closeDeadlineMs), Effect.asVoid)),
          )
        })

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          stopped = true
          const stoppedStatus: WorkspaceHostStatus = {
            state: 'stopped',
            ownerEpoch: supervisor ? SubscriptionRef.getUnsafe(supervisor.ownerEpoch) : undefined,
          }
          yield* SubscriptionRef.set(status, stoppedStatus)
          const retired = yield* Effect.exit(executionGate.withPermit(retireExecution()))
          const closed = hostScope ? yield* Effect.exit(Scope.close(hostScope, Exit.void)) : Exit.void
          if (Exit.isFailure(retired)) {
            const cause = Exit.isFailure(closed) ? Cause.combine(retired.cause, closed.cause) : retired.cause
            return yield* Effect.failCause(cause).pipe(Effect.orDie)
          }
          if (Exit.isFailure(closed)) return yield* Effect.failCause(closed.cause)
        }),
      )
      return WorkspaceHost.of({
        store,
        ensureOpen,
        withExecution,
        listConnections: getConnectionCatalog.pipe(Effect.map(catalog => catalog.rows)),
        eventHighWatermark,
        status,
      })
    }),
  )
