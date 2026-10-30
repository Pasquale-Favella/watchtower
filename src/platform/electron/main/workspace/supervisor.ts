import { Worker } from 'node:worker_threads'

import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Scope from 'effect/Scope'
import * as SubscriptionRef from 'effect/SubscriptionRef'

import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import {
  WorkspaceWorkerStoreLive,
  type WorkspaceWorkerStoreOptions,
} from '@/platform/electron/workers/workspace/client.js'
import { WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

const UNAVAILABLE = 'Workspace storage is unavailable.'
const CLEANUP_FAILED = 'Workspace worker cleanup did not complete.'

export interface WorkspaceWorkerSupervisorOptions extends WorkspaceWorkerStoreOptions {
  readonly maxReplacements?: number
  readonly restartWindowMs?: number
  readonly restartBackoffMs?: number
}

export interface WorkspaceWorkerSupervisorStatus {
  readonly state: 'starting' | 'ready' | 'replacing' | 'unavailable' | 'stopped'
  readonly lastFailure: string | null
}

export class WorkspaceWorkerSupervisor extends Context.Service<
  WorkspaceWorkerSupervisor,
  {
    readonly store: WorkspaceStore['Service']
    readonly ownerEpoch: SubscriptionRef.SubscriptionRef<number | undefined>
    readonly status: SubscriptionRef.SubscriptionRef<WorkspaceWorkerSupervisorStatus>
  }
>()('watchtower/platform/electron/WorkspaceWorkerSupervisor') {}

interface Generation {
  readonly scope: Scope.Closeable
  readonly failed: Promise<void>
  readonly fail: () => void
  store: WorkspaceStore['Service'] | undefined
  closing: boolean
}

const unavailable = (): WorkspaceStoreError =>
  new WorkspaceStoreError({ code: 'database-unavailable', message: UNAVAILABLE })

export const WorkspaceWorkerSupervisorLive = (options: WorkspaceWorkerSupervisorOptions) =>
  Layer.effect(
    WorkspaceWorkerSupervisor,
    Effect.gen(function* () {
      const maxReplacements = options.maxReplacements ?? 3
      const restartWindowMs = options.restartWindowMs ?? 60_000
      const restartBackoffMs = options.restartBackoffMs ?? 250
      if (
        !Number.isSafeInteger(maxReplacements) ||
        maxReplacements < 0 ||
        !Number.isSafeInteger(restartWindowMs) ||
        restartWindowMs <= 0 ||
        !Number.isSafeInteger(restartBackoffMs) ||
        restartBackoffMs <= 0
      ) {
        return yield* Effect.fail(
          new WorkspaceStoreError({ code: 'invalid-data', message: 'Workspace supervisor options are invalid.' }),
        )
      }

      const status = yield* SubscriptionRef.make<WorkspaceWorkerSupervisorStatus>({
        state: 'starting',
        lastFailure: null,
      })
      const ownerEpoch = yield* SubscriptionRef.make<number | undefined>(undefined)
      let current: Generation | undefined
      let stopping = false
      let cleanupFailureCause: Cause.Cause<unknown> | undefined
      let monitor: Fiber.Fiber<void> | undefined

      const closeGeneration = Effect.fn('WorkspaceWorkerSupervisor.closeGeneration')(function* (
        generation: Generation,
      ) {
        generation.closing = true
        yield* Scope.close(generation.scope, Exit.void).pipe(
          Effect.tapCause(cause =>
            Effect.sync(() => {
              cleanupFailureCause ??= cause
            }),
          ),
        )
      })

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          stopping = true
          if (monitor) yield* Fiber.interrupt(monitor)
          const closed = current ? yield* Effect.exit(closeGeneration(current)) : Exit.void
          yield* SubscriptionRef.set(status, {
            state: 'stopped' as const,
            lastFailure: cleanupFailureCause ? CLEANUP_FAILED : (yield* SubscriptionRef.get(status)).lastFailure,
          })
          if (Exit.isFailure(closed)) return yield* Effect.failCause(closed.cause)
          if (cleanupFailureCause) return yield* Effect.failCause(cleanupFailureCause).pipe(Effect.orDie)
        }),
      )

      const openGeneration = Effect.fn('WorkspaceWorkerSupervisor.openGeneration')(function* () {
        const scope = yield* Scope.make()
        let fail!: () => void
        const failed = new Promise<void>(resolve => {
          fail = resolve
        })
        const generation: Generation = { scope, failed, fail, store: undefined, closing: false }
        current = generation
        const removeListeners: Array<() => void> = []
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            for (const remove of removeListeners) remove()
          }),
        )
        const context = yield* Layer.buildWithScope(
          WorkspaceWorkerStoreLive({
            ...options,
            workerFactory: (path, data) => {
              const worker = options.workerFactory
                ? options.workerFactory(path, data)
                : new Worker(path, { workerData: data })
              const onFailure = () => {
                if (!stopping && !generation.closing) fail()
              }
              worker.on('error', onFailure)
              worker.on('exit', onFailure)
              removeListeners.push(() => {
                worker.off('error', onFailure)
                worker.off('exit', onFailure)
              })
              return worker
            },
          }),
          scope,
        ).pipe(
          Effect.tapCause(cause =>
            Effect.sync(() => {
              // Acquisition can fail before the client's release finalizer exists.
              // Only confirmed cleanup permits opening another writer.
              const unconfirmed = cause.reasons.some(reason => {
                let error: unknown
                if (Cause.isFailReason(reason)) error = reason.error
                else if (Cause.isDieReason(reason)) error = reason.defect
                return (
                  error instanceof WorkspaceStoreError &&
                  error.code === 'database-unavailable' &&
                  error.message === CLEANUP_FAILED
                )
              })
              if (unconfirmed) cleanupFailureCause ??= cause
            }),
          ),
        )
        generation.store = Context.get(context, WorkspaceStore)
        const recoveredAt = DateTime.formatIso(yield* DateTime.now)
        const acquisition = yield* generation.store.acquireOwnerEpoch(recoveredAt)
        yield* SubscriptionRef.set(status, { state: 'ready', lastFailure: null })
        yield* SubscriptionRef.set(ownerEpoch, acquisition.ownerEpoch)
      })

      const opened = yield* Effect.exit(openGeneration())
      if (Exit.isFailure(opened)) {
        if (current) yield* closeGeneration(current)
        current = undefined
        yield* SubscriptionRef.set(status, {
          state: 'unavailable',
          lastFailure: cleanupFailureCause ? CLEANUP_FAILED : UNAVAILABLE,
        })
      }

      const store = new Proxy({} as WorkspaceStore['Service'], {
        get:
          (_target, key) =>
          (...args: ReadonlyArray<unknown>) =>
            Effect.suspend(() => {
              const generation = current
              if (stopping || SubscriptionRef.getUnsafe(status).state !== 'ready' || !generation?.store)
                return Effect.fail(unavailable())
              const operation = Reflect.get(generation.store, key) as (
                ...args: ReadonlyArray<unknown>
              ) => Effect.Effect<unknown, WorkspaceStoreError>
              return operation(...args).pipe(
                Effect.tapError(error =>
                  Effect.sync(() => {
                    if (error.code === 'database-unavailable' && error.message === UNAVAILABLE) generation.fail()
                  }),
                ),
              )
            }),
      })

      if (current) {
        monitor = yield* Effect.forkScoped(
          Effect.gen(function* () {
            let attempts: Array<number> = []
            while (!stopping && current) {
              const generation = current
              yield* Effect.promise(() => generation.failed)
              if (stopping) return
              yield* SubscriptionRef.set(status, { state: 'replacing', lastFailure: UNAVAILABLE })
              const closed = yield* Effect.exit(closeGeneration(current))
              if (Exit.isFailure(closed)) {
                yield* SubscriptionRef.set(status, { state: 'unavailable', lastFailure: CLEANUP_FAILED })
                return
              }
              current = undefined
              while (!stopping) {
                const now = DateTime.toEpochMillis(yield* DateTime.now)
                attempts = attempts.filter(time => now - time < restartWindowMs)
                if (attempts.length >= maxReplacements) {
                  yield* SubscriptionRef.set(status, { state: 'unavailable', lastFailure: UNAVAILABLE })
                  return
                }
                attempts.push(now)
                yield* Effect.sleep(restartBackoffMs)
                const replacement = yield* Effect.exit(openGeneration())
                if (Exit.isSuccess(replacement)) break
                if (current) {
                  const cleanup = yield* Effect.exit(closeGeneration(current))
                  if (Exit.isFailure(cleanup) || cleanupFailureCause) {
                    yield* SubscriptionRef.set(status, { state: 'unavailable', lastFailure: CLEANUP_FAILED })
                    return
                  }
                }
                current = undefined
              }
            }
          }),
        )
      }
      return WorkspaceWorkerSupervisor.of({ store, ownerEpoch, status })
    }),
  )

export const WorkspaceStoreFromSupervisor = Layer.effect(
  WorkspaceStore,
  Effect.map(WorkspaceWorkerSupervisor, supervisor => supervisor.store),
)
