import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as FiberSet from 'effect/FiberSet'
import * as Layer from 'effect/Layer'
import * as Scope from 'effect/Scope'

import type { AcpMcpServer } from '@/infrastructure/agent-harnesses/harnesses/types.js'
import type { LedgerMcpAttachment } from '@/platform/electron/main/coach/ipc.js'
import type { LedgerMcpSpawnContext } from '@/platform/mcp/config.js'
import { LedgerMcpSidecar, type StartedLedgerMcpHttp } from '@/platform/mcp/sidecar.js'

interface NativeStartedLedgerMcpHttp {
  readonly server: AcpMcpServer
  readonly checkHealth: Effect.Effect<boolean>
  readonly release: Effect.Effect<void>
}

interface LedgerMcpPoolMethods {
  readonly acquire: (ctx: LedgerMcpSpawnContext) => Effect.Effect<LedgerMcpAttachment | null>
  readonly connection: (ctx: LedgerMcpSpawnContext) => Effect.Effect<AcpMcpServer | null>
  readonly regenerate: (ctx: LedgerMcpSpawnContext) => Effect.Effect<AcpMcpServer | null>
  readonly status: () => Effect.Effect<AcpMcpServer | null>
  readonly releaseAll: () => Effect.Effect<void>
}

/** App-scoped pool for the native ledger sidecar service. */
export class LedgerMcpPool extends Context.Service<LedgerMcpPool, LedgerMcpPoolMethods>()(
  'watchtower/agents/ledger-mcp/Pool',
) {}

interface NativePoolCore extends LedgerMcpPoolMethods {
  readonly releaseAllNow: () => void
  readonly releaseAllEffect: Effect.Effect<void>
}

function makePoolCore(
  start: (ctx: LedgerMcpSpawnContext) => Effect.Effect<NativeStartedLedgerMcpHttp, Error>,
  spawnFibers: FiberSet.FiberSet<unknown, never>,
): NativePoolCore {
  let pooled: NativeStartedLedgerMcpHttp | null = null
  let flight: Deferred.Deferred<NativeStartedLedgerMcpHttp | null, never> | null = null
  let spawnFiber: Fiber.Fiber<NativeStartedLedgerMcpHttp | null, never> | null = null

  function completeFlight(
    deferred: Deferred.Deferred<NativeStartedLedgerMcpHttp | null, never>,
    value: NativeStartedLedgerMcpHttp | null,
  ): void {
    Deferred.doneUnsafe(deferred, Effect.succeed(value))
  }

  function invalidateFlight(): void {
    const previous = flight
    flight = null
    if (previous) completeFlight(previous, null)
    spawnFiber?.interruptUnsafe()
    spawnFiber = null
  }

  // The Promise test seam keeps synchronous release semantics. Production
  // shutdown uses releaseAllEffect from the owning application Scope.
  const releaseAllNow = (): void => {
    invalidateFlight()
    const previous = pooled
    pooled = null
    if (previous) Effect.runFork(previous.release)
  }

  const releaseAllEffect = Effect.gen(function* () {
    const previous = pooled
    pooled = null
    const previousFiber = spawnFiber
    invalidateFlight()
    if (previousFiber) yield* Fiber.interrupt(previousFiber)
    if (previous) yield* previous.release
  })

  const isHealthy = (sidecar: NativeStartedLedgerMcpHttp): Effect.Effect<boolean> =>
    sidecar.checkHealth.pipe(Effect.catch(() => Effect.succeed(false)))

  function toAttachment(started: NativeStartedLedgerMcpHttp | null): LedgerMcpAttachment | null {
    return started ? { server: started.server, release: () => {} } : null
  }

  const logHealthFailure = Effect.logError('sidecar.error').pipe(
    Effect.annotateLogs({
      event: 'sidecar.error',
      context: 'sidecar',
      op: 'ledger-mcp-health',
      code: 'unhealthy',
    }),
  )

  const acquire = Effect.fn('LedgerMcpPool.acquire')(function* (
    ctx: LedgerMcpSpawnContext,
  ): Effect.fn.Return<LedgerMcpAttachment | null> {
    const current = pooled
    if (current) {
      const healthy = yield* isHealthy(current)
      if (healthy && pooled === current) return toAttachment(current)
      if (pooled === current) {
        pooled = null
        yield* logHealthFailure
        yield* current.release
      }
    }

    if (flight) return toAttachment(yield* Deferred.await(flight))

    // Flight identity is the staleness token. Forking with startImmediately
    // preserves the synchronous spawn prefix while callers share one Deferred.
    const myFlight = Deferred.makeUnsafe<NativeStartedLedgerMcpHttp | null, never>()
    flight = myFlight
    const spawn = Effect.gen(function* () {
      const started = yield* start(ctx).pipe(Effect.catch(() => Effect.succeed(null)))
      if (flight !== myFlight) {
        if (started) yield* started.release
        completeFlight(myFlight, null)
        return null
      }

      pooled = started
      if (flight === myFlight) flight = null
      completeFlight(myFlight, started)
      return started
    }).pipe(
      Effect.onExit(exit => {
        if (Exit.isSuccess(exit)) return Effect.void
        return Effect.sync(() => {
          if (flight === myFlight) flight = null
          Deferred.doneUnsafe(myFlight, Effect.failCause(exit.cause))
        })
      }),
    )
    spawnFiber = yield* FiberSet.run(spawnFibers, spawn, { startImmediately: true })
    return toAttachment(yield* Deferred.await(myFlight))
  })

  const connection = Effect.fn('LedgerMcpPool.connection')(function* (
    ctx: LedgerMcpSpawnContext,
  ): Effect.fn.Return<AcpMcpServer | null> {
    return (yield* acquire(ctx))?.server ?? null
  })

  const regenerate = Effect.fn('LedgerMcpPool.regenerate')(function* (
    ctx: LedgerMcpSpawnContext,
  ): Effect.fn.Return<AcpMcpServer | null> {
    yield* releaseAllEffect
    return yield* connection(ctx)
  })

  const status = Effect.fn('LedgerMcpPool.status')(function* (): Effect.fn.Return<AcpMcpServer | null> {
    const current = pooled
    if (!current) return null
    const healthy = yield* isHealthy(current)
    if (healthy && pooled === current) return current.server
    if (pooled !== current) return null
    pooled = null
    yield* logHealthFailure
    yield* current.release
    return null
  })

  return {
    acquire,
    connection,
    regenerate,
    status,
    releaseAll: () => releaseAllEffect,
    releaseAllNow,
    releaseAllEffect,
  }
}

/** Production pool layer: sidecar creation, health probes, and close remain in
 *  the app's existing Effect graph and Scope. The finalizer drains pooled and
 *  in-flight child resources before the sidecar layer closes its Scope. */
export const ledgerMcpPoolLayer: Layer.Layer<LedgerMcpPool, never, LedgerMcpSidecar> = Layer.effect(
  LedgerMcpPool,
  Effect.gen(function* () {
    const sidecar = yield* LedgerMcpSidecar
    const appScope = yield* Scope.Scope
    const spawnFibers = yield* FiberSet.make<unknown, never>()
    const pool = makePoolCore(ctx => sidecar.start(ctx), spawnFibers)
    yield* Scope.addFinalizer(appScope, pool.releaseAllEffect)
    return LedgerMcpPool.of({
      acquire: pool.acquire,
      connection: pool.connection,
      regenerate: pool.regenerate,
      status: pool.status,
      releaseAll: pool.releaseAll,
    })
  }),
)

/** Promise boundary retained for direct pool tests until their callers use
 *  `LedgerMcpPool` from the existing application runtime. */
export interface SidecarPoolDeps {
  readonly spawn: (ctx: LedgerMcpSpawnContext) => Promise<StartedLedgerMcpHttp>
}

export interface SidecarPool {
  readonly acquire: (ctx: LedgerMcpSpawnContext) => Promise<LedgerMcpAttachment | null>
  readonly connection: (ctx: LedgerMcpSpawnContext) => Promise<AcpMcpServer | null>
  readonly regenerate: (ctx: LedgerMcpSpawnContext) => Promise<AcpMcpServer | null>
  readonly status: () => Promise<AcpMcpServer | null>
  readonly releaseAll: () => void
  readonly dispose: () => Promise<void>
}

function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function promiseSpawn(
  deps: SidecarPoolDeps,
): (ctx: LedgerMcpSpawnContext) => Effect.Effect<NativeStartedLedgerMcpHttp, Error> {
  return ctx =>
    Effect.callback<NativeStartedLedgerMcpHttp, Error>((resume, signal) => {
      let cancelled = false
      let raw: Promise<StartedLedgerMcpHttp>
      try {
        raw = deps.spawn(ctx)
      } catch (cause) {
        resume(Effect.fail(errorFrom(cause)))
        return
      }
      const onAbort = (): void => {
        cancelled = true
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void raw.then(
        started => {
          if (cancelled) {
            try {
              started.release()
            } catch {
              /* stale test handles have best-effort release semantics */
            }
            return
          }
          resume(
            Effect.succeed({
              server: started.server,
              checkHealth: Effect.tryPromise({
                try: () => started.checkHealth(),
                catch: errorFrom,
              }).pipe(Effect.catch(() => Effect.succeed(false))),
              release: Effect.sync(() => {
                try {
                  started.release()
                } catch {
                  /* preserve the Promise pool's best-effort release */
                }
              }),
            }),
          )
        },
        cause => {
          if (!cancelled) resume(Effect.fail(errorFrom(cause)))
        },
      )
      return Effect.sync(() => {
        signal.removeEventListener('abort', onAbort)
        cancelled = true
      })
    })
}

export function createSidecarPool(deps: SidecarPoolDeps): SidecarPool {
  const appScope = Scope.makeUnsafe()
  const spawnFibers = Effect.runSync(Scope.provide(appScope)(FiberSet.make<unknown, never>()))
  const pool = makePoolCore(promiseSpawn(deps), spawnFibers)
  return {
    acquire: ctx => Effect.runPromise(pool.acquire(ctx)),
    connection: ctx => Effect.runPromise(pool.connection(ctx)),
    regenerate: ctx => Effect.runPromise(pool.regenerate(ctx)),
    status: () => Effect.runPromise(pool.status()),
    releaseAll: pool.releaseAllNow,
    dispose: async () => {
      await Effect.runPromise(pool.releaseAllEffect)
      await Effect.runPromise(Scope.close(appScope, Exit.void))
    },
  }
}
