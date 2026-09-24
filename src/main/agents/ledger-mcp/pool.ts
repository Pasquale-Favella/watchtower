import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as FiberHandle from 'effect/FiberHandle'
import * as Scope from 'effect/Scope'

import { safeLogOperationalEvent } from '../../operational-log.js'
import type { AcpMcpServer } from '../harnesses/types.js'
import type { LedgerMcpAttachment } from '../ipc.js'
import type { LedgerMcpSpawnContext } from './config.js'
import type { StartedLedgerMcpHttp } from './sidecar.js'

/**
 * App-level pool for the loopback-HTTP ledger sidecar: one sidecar serves
 * every Coach conversation and explicitly configured local MCP clients
 * instead of spawning + booting + readiness-probing for each conversation.
 * Reuse is safe because the sidecar carries no per-turn state (it serves the
 * full lifetime ledger) and the ledger runs in WAL mode (a long-lived
 * read-only handle never blocks writers nor goes stale — every statement
 * reads the latest commit).
 *
 * The pool sits behind the runner's `ledgerMcpServer` seam, so the runner is
 * untouched: per-run attachments carry a no-op release (the settle path is
 * unchanged). A pooled sidecar is health-gated on every acquire — one that
 * died between turns is respawned, never handed out. Conversation reset does
 * not drop it because a local external client may be using it independently;
 * app quit still releases it. A reset-like generation race kills an orphan
 * and degrades that turn to no-tools (the booked honesty rule).
 *
 * Effect boundary: the pool interface stays `Promise`-based (the runner seam
 * never sees Effects). Internally a `Deferred` single-flight coalesces rapid
 * turns, a `Scope` + `FiberHandle`-owned spawn fiber owns the in-flight
 * spawn (interrupted on `releaseAll`), and flight identity is the staleness
 * token — late arrivals are released-never-pooled.
 * Removal: `inflight: Promise` slot + `generation` counter juggling removed
 * when coalescing rides this `Deferred` flight + `FiberHandle` + flight-
 * identity staleness.
 */

export interface SidecarPoolDeps {
  spawn: (ctx: LedgerMcpSpawnContext) => Promise<StartedLedgerMcpHttp>
}

export interface SidecarPool {
  /** A healthy pooled sidecar's server, or null when none could be started
   *  (spawn failure, reset raced the spawn) — the turn runs without data
   *  tools, exactly like a sidecar that fails to boot. */
  acquire: (ctx: LedgerMcpSpawnContext) => Promise<LedgerMcpAttachment | null>
  /** Returns the healthy HTTP server config for a Coach or local client. */
  connection: (ctx: LedgerMcpSpawnContext) => Promise<AcpMcpServer | null>
  /** Replaces the running sidecar and bearer token. If it was stopped, this
   *  starts it on demand. */
  regenerate: (ctx: LedgerMcpSpawnContext) => Promise<AcpMcpServer | null>
  /** Returns the current healthy server, if one is running. */
  status: () => Promise<AcpMcpServer | null>
  /** Drops the app-level sidecar (app quit). In-flight spawns are orphaned by
   *  generation and killed on arrival — never pooled. */
  releaseAll: () => void
}

export function createSidecarPool(deps: SidecarPoolDeps): SidecarPool {
  let pooled: StartedLedgerMcpHttp | null = null
  // Single-flight + spawn-fiber ownership (the `snapshot.ts` shape):
  // - `poolScope` owns `spawnHandle`; `releaseAll` never closes the scope
  //   (the pool lives for app lifetime) — it only clears the handle.
  // - `flight` coalesces concurrent acquires into one `deps.spawn`; its
  //   identity is the staleness token (no numeric generation).
  const poolScope = Scope.makeUnsafe()
  const spawnHandle = Effect.runSync(Scope.provide(poolScope)(FiberHandle.make<StartedLedgerMcpHttp | null, unknown>()))
  let flight: Deferred.Deferred<StartedLedgerMcpHttp | null, unknown> | null = null

  function logHealthFailure(): void {
    safeLogOperationalEvent('error', 'sidecar.error', { op: 'ledger-mcp-health', code: 'unhealthy' }, 'sidecar')
  }

  async function isHealthy(sidecar: StartedLedgerMcpHttp): Promise<boolean> {
    try {
      return await sidecar.checkHealth()
    } catch {
      /* treat a failed probe as unhealthy */
      return false
    }
  }

  function toAttachment(started: StartedLedgerMcpHttp | null): LedgerMcpAttachment | null {
    return started ? { server: started.server, release: () => {} } : null
  }

  function completeFlightSync(
    deferred: Deferred.Deferred<StartedLedgerMcpHttp | null, unknown>,
    value: StartedLedgerMcpHttp | null,
  ): void {
    try {
      Deferred.doneUnsafe(deferred, Effect.succeed(value))
    } catch {
      /* best effort — a completed flight reports false, never throws */
    }
  }

  function interruptSpawnFiberSync(): void {
    try {
      Effect.runSync(FiberHandle.clear(spawnHandle))
    } catch {
      /* best effort — clearing an empty handle is a no-op */
    }
  }

  async function acquire(ctx: LedgerMcpSpawnContext): Promise<LedgerMcpAttachment | null> {
    // The app serves a single ledger.db — one slot, no keying. A pooled
    // sidecar is health-gated on every acquire: one that died between
    // conversations is respawned, never handed out.
    if (pooled) {
      if (await isHealthy(pooled)) return { server: pooled.server, release: () => {} }
      // A sidecar that died between turns is respawned, never handed out —
      // and the death is recorded (health failures are log records, #129).
      logHealthFailure()
      pooled.release()
      pooled = null
    }
    // Coalesce: rapid turns while a spawn is in flight share it instead of
    // spawning one sidecar each. `flight` identity is staleness — a reset
    // racing a spawn invalidates the old flight, so the orphan is killed on
    // arrival and never pooled (the booked honesty rule).
    if (flight) {
      const started = await Effect.runPromise(Deferred.await(flight))
      return toAttachment(started)
    }
    const myFlight = Deferred.makeUnsafe<StartedLedgerMcpHttp | null, unknown>()
    flight = myFlight
    let settled = false
    let raw: Promise<StartedLedgerMcpHttp>
    try {
      raw = deps.spawn(ctx)
    } catch {
      raw = Promise.reject(new Error('sidecar spawn failed'))
    }

    const spawnEffect = Effect.gen(function* () {
      let started: StartedLedgerMcpHttp | null = null
      try {
        started = yield* Effect.tryPromise({
          try: () => raw,
          catch: (error: unknown) => error,
        })
      } catch {
        started = null
      }
      if (settled) return started
      settled = true
      if (flight !== myFlight) {
        if (started) {
          yield* Effect.sync(() => {
            try {
              started?.release()
            } catch {
              /* best effort */
            }
          })
        }
        yield* Deferred.succeed(myFlight, null).pipe(Effect.ignore)
        return null
      }
      if (started) {
        pooled = started
      }
      yield* Deferred.succeed(myFlight, started).pipe(Effect.ignore)
      if (flight === myFlight) flight = null
      return started
    })
    const fiber = Effect.runFork(spawnEffect)
    FiberHandle.setUnsafe(spawnHandle, fiber)

    // Detached late-arrival guard: survives fiber interruption (a `clear`
    // during `releaseAll` kills the fiber before `raw` settles, so the
    // fiber's own staleness check never runs). Whichever handler runs first
    // wins via `settled`; the second skips — exactly one release, never a
    // pool of a stale handle. Fresh arrivals do nothing here (the fiber
    // pools); stale arrivals are released-never-pooled.
    void raw.then(
      started => {
        if (settled) return
        if (flight !== myFlight) {
          settled = true
          try {
            started.release()
          } catch {
            /* best effort */
          }
          completeFlightSync(myFlight, null)
        }
      },
      () => {
        if (settled) return
        settled = true
        completeFlightSync(myFlight, null)
      },
    )

    const result = await Effect.runPromise(Deferred.await(myFlight))
    return toAttachment(result)
  }

  async function connection(ctx: LedgerMcpSpawnContext): Promise<AcpMcpServer | null> {
    const attachment = await acquire(ctx)
    return attachment?.server ?? null
  }

  async function regenerate(ctx: LedgerMcpSpawnContext): Promise<AcpMcpServer | null> {
    releaseAll()
    return connection(ctx)
  }

  async function status(): Promise<AcpMcpServer | null> {
    if (!pooled) return null
    if (await isHealthy(pooled)) return pooled.server
    logHealthFailure()
    pooled.release()
    pooled = null
    return null
  }

  function releaseAll(): void {
    // Sync interrupt boundary (`runSync`, never `runPromise`): interrupt the
    // in-flight spawn fiber, complete the flight so pending acquires degrade
    // to null immediately (even when the spawn hangs forever), drop the
    // pooled handle, and invalidate `flight` so late arrivals are
    // released-never-pooled.
    const currentFlight = flight
    flight = null
    if (currentFlight) {
      completeFlightSync(currentFlight, null)
    }
    interruptSpawnFiberSync()
    pooled?.release()
    pooled = null
  }

  return { acquire, connection, regenerate, status, releaseAll }
}
