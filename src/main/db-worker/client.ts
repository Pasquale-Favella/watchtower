import { Worker } from 'node:worker_threads'

import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Schedule from 'effect/Schedule'

import { emitOperationalRecord, logCodeFor } from '../operational-log.js'
import {
  type DbWorkerData,
  type DbWorkerEvent,
  DEDUPABLE_OPS,
  isDbWorkerEvent,
  isDbWorkerResponse,
} from './protocol.js'

/**
 * Main-side handle to the db-worker thread (ADR 0023). `request(op, ...args)`
 * resolves with the op's data or rejects with the worker-thrown error — the
 * same contract an `ipcMain.handle` had for the renderer, so every forwarder
 * in `registerIpc` is a mechanical `return client.request(channel, ...)`.
 * Worker broadcasts arrive on `onEvent` and are relayed to windows.
 *
 * Robustness policy:
 * - Boot handshake: `ready` resolves once the worker owns the ledger. A boot
 *   failure (`init-error`, e.g. an unopenable DB) rejects it and is NEVER
 *   respawned — respawning a worker that cannot init is a hot loop.
 * - Crash policy: a worker that exits AFTER becoming ready is recreated
 *   (fresh ledger connection — WAL-safe) while in-flight requests reject,
 *   exactly as an IPC failure surfaces today. No silent replay: writes must
 *   never run twice.
 * - Read coalescing: an identical pure-read op+args already in flight shares
 *   one execution (double-mounts, tick+mount races). Writes always execute.
 */
/** The sliver of `node:worker_threads.Worker` the client drives — structural
 * so tests can inject a fake port instead of spawning a real thread. */
export interface DbWorkerPort {
  postMessage(message: unknown): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
  terminate(): Promise<unknown>
}

export type DbWorkerFactory = (scriptPath: string, workerData: DbWorkerData) => DbWorkerPort

const defaultFactory: DbWorkerFactory = (scriptPath, workerData) =>
  new Worker(scriptPath, { workerData }) as unknown as DbWorkerPort

/**
 * Bounded graceful-close send — the drain-barrier shape from
 * `drainIteratorEffect` (`src/main/agents/runtime.ts`): the worker's shutdown
 * ack is awaited under an Effect Clock deadline instead of a raw
 * `setTimeout`, so `TestClock` governs the timeout in tests. Graceful ack,
 * deadline expiry, and send failure all collapse to void — termination rides
 * `Effect.ensuring` at the call site, so every path terminates exactly once.
 */
const awaitGracefulShutdown = Effect.fn('awaitGracefulShutdown')(function* (
  sendShutdown: () => Promise<unknown>,
  timeoutMs: number,
) {
  yield* Effect.tryPromise({
    try: sendShutdown,
    catch: cause => cause,
  }).pipe(Effect.timeoutOption(Duration.millis(timeoutMs)), Effect.ignore)
})

/**
 * Crash-respawn backoff (Wave 7 §4.4 scheduling hygiene).
 *
 * Rationale:
 * - Base 1s: the first post-ready crash respawns fast (~0.8–1.2s jittered) —
 *   a lone crash is usually a flake, and downtime dominates any backoff gain.
 * - ×2 exponential: repeated rapid crashes are a poisoned worker until
 *   proven otherwise; growth buys the host and ledger room without a manual cap.
 * - Cap 30s (`Schedule.min` with `spaced(30s)`, then `jittered` — the
 *   production retry shape from Effect's Schedule docs): the worst case lands
 *   ~24–36s, i.e. tens of seconds, never minutes of dead UI.
 * - Reset 60s: a respawned worker that stays up longer than this has served
 *   at least two fastest cadence ticks (30s preset) — sustained health, so
 *   the streak clears and the next crash counts as attempt 1 again.
 */
export const RESPAWN_BACKOFF_BASE_MS = 1_000
export const RESPAWN_BACKOFF_CAP_MS = 30_000
export const RESPAWN_BACKOFF_RESET_AFTER_MS = 60_000

/** Capped exponential respawn backoff with jitter: attempt N (1-based) waits
 * `min(base * 2^(N-1), cap)`, scaled by `jittered` (±20%, mean-preserving) so
 * fleet/host timers don't thunder. `Schedule.min` is the v4 cap combinator
 * (no `whileOutput`/`intersect` in `effect@4.0.0-rc.115`). */
export const respawnBackoffSchedule = Schedule.min([
  Schedule.exponential(Duration.millis(RESPAWN_BACKOFF_BASE_MS)),
  Schedule.spaced(Duration.millis(RESPAWN_BACKOFF_CAP_MS)),
]).pipe(Schedule.jittered)

/** Pure streak rule: a crash landing more than `RESET_AFTER` past the
 * previous one closes the incident — the worker proved sustained health, so
 * the streak restarts at 1; otherwise it increments. Pure (wall ms in, count
 * out) so tests pin the rule without timers. */
export function nextRespawnAttempt(streak: number, nowMs: number, lastCrashMs: number | null): number {
  if (lastCrashMs === null || nowMs - lastCrashMs > RESPAWN_BACKOFF_RESET_AFTER_MS) return 1
  return streak + 1
}

/** The attempt-N backoff delay: steps the capped+jittered exponential N times
 * (`now` fixed — `exponential`/`jittered` are attempt-driven, not wall-clock,
 * so the Nth step IS the attempt-N delay). Exposed so tests assert growth,
 * jitter bounds, and the cap without sleeping. */
export const respawnBackoffDelayForAttempt = (attempt: number): Effect.Effect<Duration.Duration> =>
  Effect.gen(function* () {
    const step = yield* Schedule.toStep(respawnBackoffSchedule)
    const steps: number = Math.max(1, Math.floor(attempt))
    let delay: Duration.Duration = Duration.millis(0)
    for (let i = 0; i < steps; i++) {
      // `orDie`: the capped exponential never completes, so the step's `Done`
      // channel is unreachable — a completion would be a bug, fail loud.
      delay = (yield* Effect.orDie(step(0, undefined)))[1]
    }
    return delay
  })

export class DbWorkerClient {
  private worker: DbWorkerPort | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (data: unknown) => void; reject: (err: Error) => void }>()
  private inflightReads = new Map<string, Promise<unknown>>()
  private eventListeners = new Set<(event: DbWorkerEvent) => void>()
  private intentionalTeardown = false
  /** True once the CURRENT worker incarnation posted `ready`. Gates respawn:
   * only a worker that once lived is recreated. */
  private becameReady = false
  /** Consecutive post-ready crashes (backoff streak for `respawnAfterCrashEffect`).
   * Reset when a respawned worker stays up past `RESPAWN_BACKOFF_RESET_AFTER_MS`. */
  private consecutiveCrashes = 0
  /** Wall time (ms) of the previous post-ready crash; null until the first.
   * Measurement only — every wait rides the Effect Clock, never this stamp. */
  private lastCrashAtMs: number | null = null
  private initError: string | null = null
  private readyResolve!: () => void
  private readyReject!: (err: Error) => void
  /** Resolves when the worker owns the ledger; rejects on boot failure. */
  readonly ready: Promise<void>

  constructor(
    private init: DbWorkerData,
    private scriptPath: string,
    private spawnWorker: DbWorkerFactory = defaultFactory,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    // The constructor never awaits `ready` itself — mark it handled so a
    // boot failure the app surfaces elsewhere is not ALSO an unhandled
    // rejection. External `await client.ready` still observes the outcome.
    this.ready.catch(() => {})
    this.spawn()
  }

  private spawn(): void {
    this.becameReady = false
    this.initError = null
    const worker = this.spawnWorker(this.scriptPath, this.init)
    this.worker = worker
    worker.on('message', (raw: unknown) => this.onMessage(raw))
    worker.on('error', (raw: unknown) => {
      const err = raw instanceof Error ? raw : new Error(String(raw))
      for (const { reject } of this.pending.values()) reject(err)
      this.pending.clear()
      this.inflightReads.clear()
      // A thread error before `ready` is itself a boot failure (uncaught
      // throw during init): settle the handshake now instead of leaving it
      // to a later `exit`, which may never come for a wedged thread. The
      // exit handler below still runs and stays a safe no-op for `ready`.
      if (!this.becameReady) {
        this.initError ??= err.message
        this.readyReject(err)
      }
    })
    worker.on('exit', (raw: unknown) => {
      const code = String(raw)
      const wasReady = this.becameReady
      this.becameReady = false
      this.worker = null
      if (this.intentionalTeardown) return
      if (!wasReady) {
        // Never lived (bad DB path, corrupt store, …): respawning would spin
        // the same failure forever. Surface the boot error instead.
        const err = new Error(this.initError ?? `data worker failed to start (exit ${code})`)
        this.initError = null
        for (const { reject } of this.pending.values()) reject(err)
        this.pending.clear()
        this.inflightReads.clear()
        this.readyReject(err)
        return
      }
      const err = new Error(`data worker exited unexpectedly (code ${code})`)
      for (const { reject } of this.pending.values()) reject(err)
      this.pending.clear()
      this.inflightReads.clear()
      // Crash-respawn with backoff (Wave 7 §4.4): recreating immediately
      // hot-loops on a poisoned worker, so consecutive post-ready crashes wait
      // out a capped exponential + jittered delay on the Effect Clock
      // (TestClock in tests — no raw `setTimeout`). In-flight calls are
      // already rejected above: no replay, exactly as before. Never-lived
      // workers return early above and never enter this path.
      const nowMs = Date.now()
      const attempt = nextRespawnAttempt(this.consecutiveCrashes, nowMs, this.lastCrashAtMs)
      this.consecutiveCrashes = attempt
      this.lastCrashAtMs = nowMs
      // Recreate so the app keeps serving reads; the renderer already shows
      // error states for the rejected in-flight calls.
      void Effect.runPromise(this.respawnAfterCrashEffect(attempt, code))
    })
  }

  private onMessage(raw: unknown): void {
    if (isDbWorkerResponse(raw)) {
      const slot = this.pending.get(raw.id)
      if (!slot) return
      this.pending.delete(raw.id)
      if (raw.ok) slot.resolve(raw.data)
      else slot.reject(new Error(raw.error))
      return
    }
    if (isDbWorkerEvent(raw)) {
      // Boot handshake — consumed here, never relayed to windows.
      if (raw.event === 'ready') {
        this.becameReady = true
        this.readyResolve()
        return
      }
      if (raw.event === 'init-error') {
        this.initError = raw.error
        this.readyReject(new Error(raw.error))
        return
      }
      for (const listener of this.eventListeners) listener(raw)
    }
  }

  private send(op: string, args: unknown[] = []): Promise<unknown> {
    const worker = this.worker
    if (!worker) return Promise.reject(new Error('data worker unavailable'))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject })
      worker.postMessage({ id, op, args })
    })
  }

  /** Invoke one worker op. Identical pure-read ops already in flight share a
   * single execution; everything else always runs. Fire-and-forget callers
   * pass no args and ignore the (null) resolution. */
  request(op: string, ...args: unknown[]): Promise<unknown> {
    if (!DEDUPABLE_OPS.has(op)) return this.send(op, args)
    let key: string | null = null
    try {
      key = `${op}\n${JSON.stringify(args)}`
    } catch {
      return this.send(op, args)
    }
    const hit = this.inflightReads.get(key)
    if (hit) return hit
    const flight = this.send(op, args)
    this.inflightReads.set(key, flight)
    const forget = (): void => {
      if (this.inflightReads.get(key) === flight) this.inflightReads.delete(key)
    }
    flight.then(forget, forget)
    return flight
  }

  onEvent(listener: (event: DbWorkerEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  /**
   * Effect orchestration behind `shutdown()` (ADR 0032): the graceful-close
   * send rides `awaitGracefulShutdown` (Effect Clock deadline) and thread
   * termination rides `Effect.ensuring`, so graceful ack, deadline expiry,
   * and send failure all terminate exactly once. Exposed (additive) so tests
   * run it under `TestClock`; production runs it via `shutdown()` with the
   * live Clock. `shutdown()` stays the single `run*` composition root for
   * this deadline — no second runtime, no shared SQLite state.
   */
  shutdownEffect(timeoutMs = 2000): Effect.Effect<void> {
    return awaitGracefulShutdown(() => this.send('shutdown'), timeoutMs).pipe(
      Effect.ensuring(this.terminateWorkerEffect()),
    )
  }

  /**
   * Delayed crash-respawn behind `worker.on('exit')` (ADR 0023 + Wave 7 §4.4):
   * files the scheduling record, sleeps the attempt's capped+jittered
   * exponential backoff on the Effect Clock, then recreates the worker —
   * unless torn down meanwhile. attempt/backoff ride the allowlisted `count`
   * + `label` fields (the sanitizer drops any other key, so no bespoke field
   * names here). Exposed (additive) so tests run it under `TestClock`;
   * production runs it via the exit handler with the live Clock — the same
   * seam shape as `shutdownEffect`. Never fails: a respawn that cannot sleep
   * or spawn must not surface as a rejection.
   */
  respawnAfterCrashEffect(attempt: number, exitCode: string): Effect.Effect<void> {
    // Arrow closure (NOT a `self` alias): lexical `this`, same shape as
    // `terminateWorkerEffect`'s `takeWorker` below. Returns an Effect rather
    // than running itself so the spawn-failure record is `yield*`ed in Effect
    // context — a `() => void` handed to `Effect.sync` could not be, and
    // reaching for a logger without an Effect there is the composition-root
    // violation this slice exists to remove.
    const respawnIfLive = (): Effect.Effect<void> => {
      if (this.intentionalTeardown) return Effect.void
      // `Effect.sync` turns a `spawn()` throw into a defect (it is not a
      // typed failure), so `catchDefect` is the recovery that matches the
      // `try`/`catch` this replaced — and the record is byte-identical:
      // `code` stays an explicit `logCodeFor(spawnErr, 'restart-failed')`
      // rather than a `Cause` the Logger would have to squash.
      return Effect.sync(() => this.spawn()).pipe(
        Effect.catchDefect(spawnErr =>
          emitOperationalRecord(
            'error',
            'worker.error',
            { op: 'worker-restart', code: logCodeFor(spawnErr, 'restart-failed') },
            'worker',
          ),
        ),
      )
    }
    return Effect.gen(function* () {
      const delay = yield* respawnBackoffDelayForAttempt(attempt)
      const backoffMs = Math.round(Duration.toMillis(delay))
      yield* emitOperationalRecord(
        'error',
        'worker.error',
        {
          op: 'worker-restart',
          code: `exit-${exitCode}`,
          label: `attempt ${attempt} backoff ${backoffMs}ms`,
          count: attempt,
        },
        'worker',
      )
      yield* Effect.sleep(delay)
      yield* respawnIfLive()
    })
  }

  /** Termination finalizer for `shutdownEffect`: captures the live worker,
   * rejects every in-flight call with the legacy 'data worker shut down'
   * error, and terminates the thread. Never fails — teardown must not turn
   * a completed shutdown into a rejection. */
  private terminateWorkerEffect(): Effect.Effect<void> {
    const takeWorker = (): DbWorkerPort | null => this.takeWorkerForTeardown()
    return Effect.gen(function* () {
      const worker: DbWorkerPort | null = yield* Effect.sync(takeWorker)
      if (worker) {
        yield* Effect.tryPromise({
          try: () => worker.terminate(),
          catch: cause => cause,
        }).pipe(Effect.ignore)
      }
    })
  }

  /** Captures the live worker for teardown (the legacy `finally` semantics):
   * the worker ref is cleared, every pending call is rejected, and read
   * coalescing is dropped, so a late graceful ack finds no slot and is
   * ignored. A second call captures null and is a safe no-op. */
  private takeWorkerForTeardown(): DbWorkerPort | null {
    const worker = this.worker
    this.worker = null
    for (const { reject } of this.pending.values()) reject(new Error('data worker shut down'))
    this.pending.clear()
    this.inflightReads.clear()
    return worker
  }

  /**
   * Best-effort graceful shutdown: asks the worker to checkpoint and close
   * the ledger, then terminates the thread. Resolves once the thread is gone
   * (or the Clock deadline elapses first). Idempotent. The app's quit path calls
   * this fire-and-forget — quitting must never block on it.
   */
  async shutdown(timeoutMs = 2000): Promise<void> {
    if (this.intentionalTeardown) return
    this.intentionalTeardown = true
    await Effect.runPromise(this.shutdownEffect(timeoutMs))
  }

  /** Permanently shut the worker down (tests). The app itself uses
   * `shutdown()` from its quit path instead. */
  async terminate(): Promise<void> {
    await this.shutdown(0)
  }
}
