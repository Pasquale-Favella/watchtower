import { Worker } from 'node:worker_threads'

import * as Cause from 'effect/Cause'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'

import { logCodeFor } from '../operational-log.js'
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

type ReadyHandshake = {
  promise: Promise<void>
  resolve: () => void
  reject: (err: Error) => void
}

function createReadyHandshake(): ReadyHandshake {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

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

/** A scan abort normally waits for the worker's real parser/callback drain.
 * If that never arrives, kill the owning thread under the same bound as
 * graceful shutdown; only then may its replacement receive requests. */
export const SCAN_ABORT_DRAIN_TIMEOUT_MS = 2_000

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
  /** Non-null while a stuck abort is terminating the old worker and booting
   * its replacement. Requests queue behind this exact ownership transition. */
  private recovery: Promise<void> | null = null
  /** The incarnation being forcibly retired; its late events are ignored. */
  private retiringWorker: DbWorkerPort | null = null
  private termination: { worker: DbWorkerPort; promise: Promise<void> } | null = null
  private currentReady: ReadyHandshake
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
  /** Resolves when the worker owns the ledger; rejects on boot failure. */
  readonly ready: Promise<void>

  constructor(
    private init: DbWorkerData,
    private scriptPath: string,
    private spawnWorker: DbWorkerFactory = defaultFactory,
  ) {
    this.currentReady = createReadyHandshake()
    this.ready = this.currentReady.promise
    // The constructor never awaits `ready` itself — mark it handled so a
    // boot failure the app surfaces elsewhere is not ALSO an unhandled
    // rejection. External `await client.ready` still observes the outcome.
    this.spawn()
  }

  private spawn(): void {
    this.becameReady = false
    this.initError = null
    const handshake = this.currentReady
    const worker = this.spawnWorker(this.scriptPath, this.init)
    this.worker = worker
    worker.on('message', (raw: unknown) => this.onMessage(raw, worker, handshake))
    worker.on('error', (raw: unknown) => {
      if (this.worker !== worker || this.retiringWorker === worker) return
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
        handshake.reject(err)
      }
    })
    worker.on('exit', (raw: unknown) => {
      if (this.worker !== worker || this.retiringWorker === worker) return
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
        handshake.reject(err)
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
      this.currentReady = createReadyHandshake()
      const attempt = nextRespawnAttempt(this.consecutiveCrashes, nowMs, this.lastCrashAtMs)
      this.consecutiveCrashes = attempt
      this.lastCrashAtMs = nowMs
      // Recreate so the app keeps serving reads; the renderer already shows
      // error states for the rejected in-flight calls.
      void Effect.runPromise(this.respawnAfterCrashEffect(attempt, code))
    })
  }

  private onMessage(raw: unknown, worker: DbWorkerPort, handshake: ReadyHandshake): void {
    if (this.worker !== worker || this.retiringWorker === worker) return
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
        handshake.resolve()
        return
      }
      if (raw.event === 'init-error') {
        this.initError = raw.error
        handshake.reject(new Error(raw.error))
        return
      }
      for (const listener of this.eventListeners) listener(raw)
    }
  }

  private send(op: string, args: unknown[] = []): Promise<unknown> {
    const recovery = this.recovery
    if (recovery) return recovery.then(() => this.sendTo(this.worker, op, args))
    return this.sendTo(this.worker, op, args)
  }

  private sendTo(worker: DbWorkerPort | null, op: string, args: unknown[] = []): Promise<unknown> {
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
    if (op === 'scan:abort') return this.abortScan(args)
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

  /** Await the worker's cooperative abort. A deadline never abandons a live
   * Promise in place: expiry tears down that Promise's entire worker isolate,
   * waits for actual termination, and only then admits the replacement. */
  private abortScan(args: unknown[]): Promise<unknown> {
    return Effect.runPromise(this.scanAbortEffect(args))
  }

  /** Effect form keeps the abort-drain deadline deterministic under TestClock.
   * Production enters it only through `request('scan:abort')`. */
  scanAbortEffect(
    args: unknown[],
    timeoutMs = SCAN_ABORT_DRAIN_TIMEOUT_MS,
    replacementTimeoutMs = SCAN_ABORT_DRAIN_TIMEOUT_MS,
  ): Effect.Effect<unknown, unknown> {
    return Effect.suspend(() => {
      const ongoingRecovery = this.recovery
      if (ongoingRecovery)
        return Effect.tryPromise({ try: () => ongoingRecovery, catch: cause => cause }).pipe(Effect.as(null))

      const worker = this.worker
      const sendAbort = (): Promise<unknown> => this.sendTo(worker, 'scan:abort', args)
      const recover = (target: DbWorkerPort | null): Effect.Effect<void, unknown> =>
        this.recoverStuckWorker(target, replacementTimeoutMs)
      return Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: sendAbort,
          catch: cause => cause,
        }).pipe(Effect.timeoutOption(Duration.millis(timeoutMs)))
        if (Option.isSome(response)) return response.value
        yield* recover(worker)
        return yield* Effect.fail(new Error('scan abort drain timed out; worker was restarted'))
      })
    })
  }

  private recoverStuckWorker(worker: DbWorkerPort | null, timeoutMs: number): Effect.Effect<void, unknown> {
    return Effect.uninterruptible(
      Effect.suspend(() => {
        const ongoingRecovery = this.recovery
        if (ongoingRecovery) {
          return Effect.tryPromise({ try: () => ongoingRecovery, catch: cause => cause })
        }
        if (!worker || this.worker !== worker) {
          return Effect.tryPromise({ try: () => this.currentReady.promise, catch: cause => cause })
        }

        const completion = createReadyHandshake()
        const recovery = completion.promise
        this.recovery = recovery
        return Effect.onExit(this.terminateAndReplace(worker, timeoutMs), exit =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) {
              if (this.recovery === recovery) this.recovery = null
              completion.resolve()
            } else {
              // Keep the failed recovery installed so requests fail closed. This
              // also settles joiners on defects or interruption, not only typed
              // failures from the worker promises.
              const failure = Cause.squash(exit.cause)
              completion.reject(failure instanceof Error ? failure : new Error(String(failure)))
            }
          }),
        )
      }),
    )
  }

  private terminateAndReplace(worker: DbWorkerPort, replacementTimeoutMs: number): Effect.Effect<void, unknown> {
    const terminatedError = new Error('data worker terminated after scan abort timed out')
    const terminate = (target: DbWorkerPort): Effect.Effect<void, unknown> =>
      Effect.tryPromise({ try: () => this.terminateWorker(target), catch: cause => cause }).pipe(Effect.asVoid)
    const startReplacement = (): ReadyHandshake => {
      const handshake = (this.currentReady = createReadyHandshake())
      this.spawn()
      return handshake
    }
    const bootReplacement = Effect.gen(function* () {
      const handshake = yield* Effect.try({ try: startReplacement, catch: cause => cause })
      const ready = yield* Effect.tryPromise({
        try: () => handshake.promise,
        catch: cause => cause,
      }).pipe(Effect.timeoutOption(Duration.millis(replacementTimeoutMs)))
      if (Option.isNone(ready)) return yield* Effect.fail(new Error('replacement worker did not become ready'))
    })
    const currentWorker = (): DbWorkerPort | null => this.worker
    const releaseWorker = (target: DbWorkerPort): void => {
      if (this.worker === target) this.worker = null
      if (this.retiringWorker === target) this.retiringWorker = null
    }
    const isTeardown = (): boolean => this.intentionalTeardown
    const rejectPending = (error: Error): void => this.rejectPending(error)
    const emitBootFailure = (): void => {
      this.emitEvent({
        event: 'scan:error',
        manual: true,
        message: 'scan stopped after abort timeout; replacement worker failed to start',
      })
      this.emitEvent({ event: 'scan:idle' })
    }
    const emitRecovery = (): void => {
      this.emitEvent({ event: 'scan:error', manual: true, message: 'scan abort timed out; worker restarted' })
      this.emitEvent({ event: 'scan:idle' })
    }
    const recoverBootFailure = (cause: unknown): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const failedWorker = currentWorker()
        if (failedWorker) {
          yield* terminate(failedWorker)
          releaseWorker(failedWorker)
        }
        if (!isTeardown()) emitBootFailure()
        return yield* Effect.fail(cause instanceof Error ? cause : new Error(String(cause)))
      })

    return Effect.gen(function* () {
      // Worker.terminate() resolves only after the isolate has exited, which
      // is the hard no-more-writes boundary.
      yield* terminate(worker).pipe(
        Effect.tapError(cause =>
          Effect.sync(() => rejectPending(cause instanceof Error ? cause : new Error(String(cause)))),
        ),
      )
      releaseWorker(worker)
      rejectPending(terminatedError)
      if (isTeardown()) return

      yield* bootReplacement.pipe(Effect.catch(recoverBootFailure))
      emitRecovery()
    })
  }

  private terminateWorker(worker: DbWorkerPort): Promise<void> {
    if (this.termination?.worker === worker) return this.termination.promise
    this.retiringWorker = worker
    const promise = Promise.resolve()
      .then(() => worker.terminate())
      .then(() => undefined)
    this.termination = { worker, promise }
    return promise
  }

  private rejectPending(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error)
    this.pending.clear()
    this.inflightReads.clear()
  }

  private emitEvent(event: DbWorkerEvent): void {
    for (const listener of this.eventListeners) listener(event)
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
      // `try`/`catch` this replaced — and the record is unchanged:
      // `code` stays an explicit `logCodeFor(spawnErr, 'restart-failed')`
      // rather than a `Cause` the Logger would have to squash.
      return Effect.sync(() => this.spawn()).pipe(
        Effect.catchDefect(spawnErr =>
          Effect.logError('worker.error').pipe(
            Effect.annotateLogs({
              event: 'worker.error',
              context: 'worker',
              op: 'worker-restart',
              code: logCodeFor(spawnErr, 'restart-failed'),
            }),
          ),
        ),
      )
    }
    return Effect.gen(function* () {
      const delay = yield* respawnBackoffDelayForAttempt(attempt)
      const backoffMs = Math.round(Duration.toMillis(delay))
      yield* Effect.logError('worker.error').pipe(
        Effect.annotateLogs({
          event: 'worker.error',
          context: 'worker',
          op: 'worker-restart',
          code: `exit-${exitCode}`,
          // An explicit `label` rides the same bag and wins over the message:
          // the message here IS the event name, so there is no prose to file.
          label: `attempt ${attempt} backoff ${backoffMs}ms`,
          count: attempt,
        }),
      )
      yield* Effect.sleep(delay)
      yield* respawnIfLive()
    })
  }

  /** Termination finalizer for `shutdownEffect`. The worker reference remains
   * owned until the actual termination promise resolves; a rejection must not
   * make this client spawn a second writer beside a possibly-live thread. */
  private terminateWorkerEffect(): Effect.Effect<void> {
    const currentWorker = (): DbWorkerPort | null => this.worker
    const rejectCalls = (): void => this.rejectPending(new Error('data worker shut down'))
    const releaseWorker = (worker: DbWorkerPort): void => {
      if (this.worker === worker) this.worker = null
      if (this.retiringWorker === worker) this.retiringWorker = null
    }
    const terminate = (worker: DbWorkerPort): Promise<void> => this.terminateWorker(worker)
    return Effect.gen(function* () {
      const worker: DbWorkerPort | null = yield* Effect.sync(currentWorker)
      if (worker) {
        yield* Effect.sync(rejectCalls)
        yield* Effect.tryPromise({
          try: () => terminate(worker),
          catch: cause => cause,
        }).pipe(
          Effect.tap(() => Effect.sync(() => releaseWorker(worker))),
          Effect.ignore,
        )
      }
    })
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
