import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Schedule from 'effect/Schedule'
import type { SchemaError } from 'effect/Schema'
import * as Scope from 'effect/Scope'
import type { SqlError } from 'effect/sql/SqlError'

import { clearLedger } from '../application/clear-ledger.js'
import { queryActiveCurrency, selectDisplayCurrency } from '../application/currency-commands.js'
import { setRefreshCadence } from '../application/ledger-config-commands.js'
import { scanLedger } from '../application/scan-ledger.js'
import { settingsInfoEffect } from '../application/settings-info.js'
import { resolveCadenceMs } from '../cadence.js'
import { type CurrencyOption, FxRates, isValidCurrencyCode, listCurrencies, refreshFxRateWithRates } from '../fx.js'
import { logCodeFor } from '../operational-log.js'
import type { HttpFetch } from '../pipeline/fetch-utils.js'
import { fileErrorCode, takeQueuedLogRecords } from '../pipeline/file-errors.js'
import { refreshPricingNowEffect } from '../pipeline/models.js'
import { buildScanSummaryRecords, ScanAbortedError, type ScanMetadata, type ScanProgress } from '../pipeline/scan.js'
import { LedgerConfig, LedgerQueries } from '../store/ledger-ports.js'
import type { WorkerRuntime, WorkerServices } from '../worker-runtime.js'
import { ledgerConfigRequest } from './config-dispatch.js'
import type { DbWorkerData, DbWorkerEvent } from './protocol.js'
import { ledgerQueryRequest } from './query-dispatch.js'

export type DbWorkerEmit = (event: DbWorkerEvent) => void

function abortedScanError(): ScanAbortedError {
  return new ScanAbortedError({ message: 'scan aborted' })
}

const SCAN_FAILURE_MESSAGE = 'The scan failed.'
const SCAN_ABORTED_MESSAGE = 'scan aborted'
const PRICING_REFRESH_FAILURE_MESSAGE = 'Pricing refresh failed.'

/**
 * The composition root supplies the runtime that owns the worker's SQL client
 * and application capabilities. Tests can substitute services in that runtime.
 */
export interface DbWorkerDeps {
  readonly runtime: WorkerRuntime
  /** Testable boundary for the fallible post-clear response hydration. */
  readonly readSettingsInfo?: (dataDir: string, cacheDir: string) => Effect.Effect<unknown, unknown>
}

interface ActiveScan {
  readonly manual: boolean
  aborted: boolean
  workFiber: Fiber.Fiber<ScanMetadata, unknown> | null
  fiber: Fiber.Fiber<unknown, unknown> | null
  readonly fiberReady: Deferred.Deferred<undefined>
  readonly markFiberReady: () => void
}

function makeActiveScan(manual: boolean): ActiveScan {
  const fiberReady = Deferred.makeUnsafe<undefined>()
  const markFiberReady = (): void => {
    Deferred.doneUnsafe(fiberReady, Effect.succeed(undefined))
  }
  return { manual, aborted: false, workFiber: null, fiber: null, fiberReady, markFiberReady }
}

type ScanRequirements = ReturnType<typeof scanLedger> extends Effect.Effect<unknown, unknown, infer R> ? R : never

/**
 * Everything the old main process owned around the ledger, now running on the
 * db-worker thread: the scan lifecycle, the background cadence, and every
 * query-time view builder over the store the root hands in. The main process
 * only forwards renderer IPC here and relays the emitted broadcasts to
 * windows — so a scan or a heavy aggregation blocks this thread, never the main
 * event loop.
 */
export class DbWorkerContext {
  private runtime: WorkerRuntime
  private dataDir: string
  private cacheDir: string
  private emit: DbWorkerEmit
  private readSettingsInfo: NonNullable<DbWorkerDeps['readSettingsInfo']>
  /** The most recent completed scan's metadata — the `getScanStatus()` answer
   * and the `store:changed` payload (ADR 0004). In-memory only. */
  private lastScanMetadata: ScanMetadata | null = null
  /** The single-flight owner remains installed until its fiber finishes
   * draining parser Promises. Its abort state cannot leak into a replacement
   * scan, and its manual/background event ownership travels with that run. */
  private activeScan: ActiveScan | null = null
  private cadenceFiber: Fiber.Fiber<unknown, never> | null = null
  private cadenceGeneration = 0
  private readonly backgroundScope = Scope.makeUnsafe()
  private readonly scanScope = Scope.makeUnsafe()
  /** Idempotent shutdown: first `close()` forks the shutdown Effect into
   * `closeFiber`; concurrent/second closes join the same fiber. */
  private closeFiber: Fiber.Fiber<void, unknown> | null = null
  private closed = false

  constructor(init: DbWorkerData, emit: DbWorkerEmit, deps: DbWorkerDeps) {
    this.dataDir = init.dataDir
    this.cacheDir = init.cacheDir
    this.emit = emit
    this.runtime = deps.runtime
    this.readSettingsInfo = deps.readSettingsInfo ?? settingsInfoEffect
    void this.scheduleCadence()
    // Prime the FX side-table for the persisted display currency at startup,
    // non-blocking: readers use the cached rate (or USD) meanwhile, and an
    // event lands the fresh rate if the cache was stale.
    this.startBackgroundFx(this.refreshFxOnCadence())
  }

  // ── Scan pipeline ───────────────────────────────────────────────────

  /** The application workflow receives the worker's cooperative stop state. */
  private performScan(
    options: { provider?: string } | undefined,
    emit: (progress: ScanProgress) => void,
    owner: ActiveScan,
  ): ReturnType<typeof scanLedger> {
    return scanLedger(options, emit, { isAborted: () => owner.aborted })
  }

  /** Manual scan work and its result events share one shutdown-owned fiber. */
  private manualScanEffect(
    owner: ActiveScan,
    options: { provider?: string } | undefined,
  ): Effect.Effect<{ ok: boolean; aborted?: boolean; error?: string }, never, ScanRequirements> {
    const emit = (progress: ScanProgress): void => this.emit({ event: 'scan:progress', manual: owner.manual, progress })
    const reportFailure = (error: unknown) => {
      const aborted = error instanceof ScanAbortedError || owner.aborted
      const normalized = aborted && !(error instanceof ScanAbortedError) ? abortedScanError() : error
      const message = aborted ? SCAN_ABORTED_MESSAGE : SCAN_FAILURE_MESSAGE
      return Effect.sync(() => {
        this.emit({ event: 'scan:error', manual: true, message })
        this.emitScanFailure(normalized)
        return {
          ok: false,
          aborted,
          error: message,
        }
      })
    }

    return Effect.uninterruptibleMask(restore =>
      Effect.gen({ self: this }, function* () {
        // Abort can win after admission but before this owned fiber starts.
        if (owner.aborted) return yield* reportFailure(abortedScanError())
        const workFiber = yield* Effect.forkChild(restore(this.performScan(options, emit, owner)))
        owner.workFiber = workFiber
        // close()/scan:abort may win while the work fiber is being admitted.
        // Recheck after registration so that a null workFiber observed by the
        // abort path cannot leave newly admitted scan work running.
        if (owner.aborted) yield* Fiber.interrupt(workFiber).pipe(Effect.asVoid)
        const scanExit = yield* Fiber.await(workFiber)
        owner.workFiber = null
        if (Exit.isFailure(scanExit)) return yield* reportFailure(Cause.squash(scanExit.cause))

        const completionExit = yield* Effect.exit(
          Effect.sync(() => {
            this.lastScanMetadata = scanExit.value
            this.emit({ event: 'store:changed', metadata: scanExit.value })
            this.emitScanFinish(scanExit.value)
          }),
        )
        if (Exit.isFailure(completionExit)) return yield* reportFailure(Cause.squash(completionExit.cause))
        return { ok: true }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.activeScan === owner) this.activeScan = null
          }),
        ),
      ),
    )
  }

  /** Startup, cadence and selection refreshes share the worker's HttpFetch
   * and FxRates services. backgroundScope owns their shutdown. */
  private startBackgroundFx(work: Effect.Effect<void, SqlError | SchemaError, HttpFetch | FxRates>): void {
    if (this.closed) return
    const observed = work.pipe(
      Effect.catch(failure =>
        Effect.logError('Currency refresh failed').pipe(
          Effect.annotateLogs({ event: 'currency.refresh.error', op: 'currency.refresh', code: failure._tag }),
        ),
      ),
    )
    this.runtime.runSync(Effect.forkIn(observed, this.backgroundScope, { startImmediately: true }))
  }

  /** Operational-log forwards (#128): scan lifecycle over the existing host
   * event channel. Main files each `oplog` via the shared seam with
   * `context: 'worker'` — allowlisted fields only. */
  private emitScanStart(provider?: string): void {
    this.emit({
      event: 'oplog',
      level: 'info',
      logEvent: 'scan.start',
      fields: provider ? { op: 'scan', provider } : { op: 'scan' },
    })
  }

  private emitScanFinish(metadata: ScanMetadata): void {
    for (const record of buildScanSummaryRecords(metadata)) {
      this.emit({ event: 'oplog', level: record.level, logEvent: record.logEvent, fields: record.fields })
    }
    this.drainQueuedLogs()
  }

  private emitScanFailure(err: unknown): void {
    // Native scan lifecycles pass their normalized failure to this synchronous
    // event emitter. TaggedError class identity preserves the abort record.
    if (err instanceof ScanAbortedError) {
      this.emit({ event: 'oplog', level: 'warn', logEvent: 'scan.abort', fields: { op: 'scan', code: 'aborted' } })
    } else {
      this.emit({
        event: 'oplog',
        level: 'error',
        logEvent: 'scan.error',
        fields: { op: 'scan', code: fileErrorCode(err, 'failed') },
      })
    }
    this.drainQueuedLogs()
  }

  /** Files the file-error outbox queued during the scan (provider + basename
   * + code, never contents or full paths). */
  private drainQueuedLogs(): void {
    for (const queued of takeQueuedLogRecords()) {
      this.emit({ event: 'oplog', level: queued.level, logEvent: queued.logEvent, fields: { ...queued.fields } })
    }
  }

  /** Interrupt scan work using the same ownership rule for manual and
   * background scans. A missing manual work fiber means admission has not
   * completed yet; manualScanEffect observes `aborted` before it starts work. */
  private interruptActiveScanEffect(waitForRegistration = false): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const owner = this.activeScan
      if (!owner) return
      owner.aborted = true
      if (waitForRegistration && !owner.fiber) yield* Deferred.await(owner.fiberReady)
      const fiber = owner.workFiber ?? (owner.manual ? null : owner.fiber)
      if (fiber) yield* Fiber.interrupt(fiber).pipe(Effect.asVoid)
    })
  }

  /** Fires on the configured cadence (ADR 0004). The scan fiber owns both the
   * work and its completion events, so shutdown joins the whole lifecycle. */
  private triggerBackgroundScanEffect(): Effect.Effect<void, never, ScanRequirements> {
    return Effect.uninterruptible(
      Effect.suspend(() => {
        if (this.closed || this.activeScan !== null) return Effect.void

        const owner = makeActiveScan(false)
        const emit = (progress: ScanProgress): void =>
          this.emit({ event: 'scan:progress', manual: owner.manual, progress })
        const complete = Effect.uninterruptibleMask(restore =>
          Effect.gen({ self: this }, function* () {
            const exit = yield* Effect.exit(
              restore(
                Effect.gen({ self: this }, function* () {
                  const metadata = yield* this.performScan(undefined, emit, owner)
                  yield* Effect.sync(() => {
                    this.lastScanMetadata = metadata
                    this.emit({ event: 'store:changed', metadata })
                    this.emitScanFinish(metadata)
                  })
                  return metadata
                }),
              ),
            )
            if (Exit.isSuccess(exit)) return

            const error = owner.aborted ? abortedScanError() : Cause.squash(exit.cause)
            this.emit({ event: 'scan:idle' })
            this.emitScanFailure(error)
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (this.activeScan === owner) this.activeScan = null
              }),
            ),
          ),
        )

        const admit = Effect.gen({ self: this }, function* () {
          this.activeScan = owner
          this.emitScanStart()
          const fiber = yield* Effect.forkIn(complete, this.scanScope, { startImmediately: false })
          owner.fiber = fiber
          owner.markFiberReady()
        })
        return admit.pipe(
          Effect.onExit(exit =>
            Effect.sync(() => {
              owner.markFiberReady()
              if (Exit.isFailure(exit) && owner.fiber === null && this.activeScan === owner) {
                this.activeScan = null
              }
            }),
          ),
        )
      }),
    )
  }

  /** (Re)schedules the background scan in the worker scope from the persisted
   * cadence. Ticks remain delayed and fixed-rate; scan coalescing stays in
   * triggerBackgroundScanEffect. */
  private scheduleCadenceEffect(): Effect.Effect<void, SqlError, LedgerConfig | ScanRequirements> {
    const backgroundScope = this.backgroundScope
    const nextGeneration = (): { generation: number; previous: Fiber.Fiber<unknown, never> | null } => {
      const generation = ++this.cadenceGeneration
      const previous = this.cadenceFiber
      this.cadenceFiber = null
      return { generation, previous }
    }
    const isStale = (generation: number): boolean => this.closed || generation !== this.cadenceGeneration
    const install = (fiber: Fiber.Fiber<unknown, never>): void => {
      this.cadenceFiber = fiber
    }
    const runTick = (): Effect.Effect<void, never, LedgerConfig | ScanRequirements> => {
      this.startBackgroundFx(this.refreshFxOnCadence())
      return this.triggerBackgroundScanEffect()
    }
    const tick = Effect.suspend(runTick)
    return Effect.gen(function* () {
      const { generation, previous } = yield* Effect.sync(nextGeneration)
      if (previous) yield* Fiber.interrupt(previous)
      if (yield* Effect.sync(() => isStale(generation))) return

      const config = yield* LedgerConfig
      const ms = resolveCadenceMs(yield* config.getRefreshCadence())
      if (ms === null) return // Manual: no background timer
      // Scheduling-hygiene verdicts (Wave 7 §4.4 — the "Schedule retry/jitter
      // + Cron" item, closed honestly):
      // - Cron evaluated, rejected: Unix Cron is minute-resolution, so the
      //   30s preset is below Cron resolution; and even with Effect Cron's
      //   optional seconds field, Cron expresses wall-clock times, not
      //   fixed-rate intervals — mapping the preset family
      //   (30s/1m/3m/5m/10m + manual=null) to Cron would align ticks to the
      //   wall clock (plus timezone/DST handling) and change tick semantics,
      //   with `manual` having no Cron meaning at all. `Schedule` ticks stay.
      // - Carrier `spaced`, not `fixed`: `fixed` phase-locks ticks to a grid
      //   and fires catch-up ticks for jitter-induced phase lag — measured 22
      //   ticks vs 10 nominal over 300s virtual with `fixed+jittered`
      //   (TestClock, instant ticks), i.e. ~2.2x background scans in
      //   fast-scan regimes. `spaced+jittered` measures exactly nominal (10
      //   vs 10) with the same ±20% mean-preserving spread, so fleet/host
      //   timers decorrelate instead of re-aligning to one grid. First tick
      //   stays exact via the leading sleep; coalescing, generation,
      //   staleness, and manual=null are untouched.
      // The FX background job rides the same repurposed cadence as the scan
      // trigger (ADR 0009): each tick also refreshes the selected currency's
      // rate when it is missing or older than 24h. HTTP failures retain their
      // cached fallback; storage failures are logged by startBackgroundFx.
      const cadence = Effect.sleep(ms).pipe(
        Effect.andThen(Effect.repeat(tick, Schedule.spaced(ms).pipe(Schedule.jittered))),
      )
      const fiber = yield* Effect.forkIn(cadence, backgroundScope, { startImmediately: true })
      yield* Effect.sync(() => install(fiber))
    })
  }

  private async scheduleCadence(): Promise<void> {
    await this.runtime.runPromise(this.scheduleCadenceEffect())
  }

  /** The FX half of the background cadence tick (and the startup prime):
   * refresh the selected currency's cached rate when stale, and emit the
   * result only when the rate actually changed — so a minute cadence doesn't
   * spam re-renders while the 24h cache is still fresh. Fiber interruption
   * (backgroundScope close) aborts the underlying fetch via HttpFetch —
   * no manual AbortSignal plumbing. */
  private refreshFxOnCadence(): Effect.Effect<void, SqlError | SchemaError, HttpFetch | FxRates> {
    const emit = this.emit
    const isClosed = (): boolean => this.closed
    return Effect.gen(function* () {
      const rates = yield* FxRates
      const code = yield* rates.getDisplayCurrency()
      const before = isValidCurrencyCode(code) && code !== 'USD' ? yield* rates.getCurrencyRate(code) : null
      const after = yield* refreshFxRateWithRates(code)
      if (!isClosed() && (after.rate !== (before?.rate ?? 1) || after.updatedAt !== before?.updatedAt)) {
        yield* Effect.sync(() => emit({ event: 'currency:changed', currency: after }))
      }
    })
  }

  // ── Settings helpers ────────────────────────────────────────────────

  // ── Op dispatch (one arm per renderer IPC channel that touches data) ──

  private provideRuntime<A, E, R extends WorkerServices>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | SqlError> {
    return Effect.flatMap(this.runtime.contextEffect, services => Effect.provide(effect, services)) as Effect.Effect<
      A,
      E | SqlError
    >
  }

  /** Native application operation entry for the fixed worker RPC handlers. */
  dispatchEffect(op: string, args: unknown[]): Effect.Effect<unknown, unknown> {
    if (this.closed && op !== 'shutdown') return Effect.fail(new Error('db-worker is shutting down'))

    const query = ledgerQueryRequest(op, args)
    if (query) {
      return this.provideRuntime(
        query.pipe(
          Effect.tapError(error =>
            Effect.logError('ledger.query.error').pipe(
              Effect.annotateLogs({ event: 'ledger.query.error', op: 'ledger.query', code: logCodeFor(error) }),
              Effect.catchCause(() => Effect.void),
            ),
          ),
        ),
      )
    }

    const command = ledgerConfigRequest(
      op,
      args,
      Effect.sync(() => this.emit({ event: 'config:changed' })),
    )
    if (command) return this.provideRuntime(command)

    switch (op) {
      case 'scan:start': {
        const options = args[0] as { provider?: string } | undefined
        // A scan is already in flight (background cadence or a concurrent call).
        // This is NOT a failure: its progress and store:changed events will land
        // on their own, so the renderer must not surface an error box or a retry
        // button for it — hence the explicit flag instead of an error string.
        // Coalescing retains ownership through parser Promise drainage.
        return this.provideRuntime(
          Effect.uninterruptibleMask(restore =>
            Effect.gen({ self: this }, function* () {
              if (this.activeScan !== null) return { ok: false, alreadyRunning: true }
              const owner = makeActiveScan(true)
              this.activeScan = owner
              const started = yield* Effect.exit(Effect.sync(() => this.emitScanStart(options?.provider)))
              if (Exit.isFailure(started)) {
                if (this.activeScan === owner) this.activeScan = null
                owner.markFiberReady()
                return yield* Effect.failCause(started.cause)
              }

              const fork = Effect.forkIn(this.manualScanEffect(owner, options), this.scanScope, {
                startImmediately: false,
              })
              const admitted = yield* Effect.exit(fork)
              if (Exit.isFailure(admitted)) {
                if (this.activeScan === owner) this.activeScan = null
                owner.markFiberReady()
                return yield* Effect.failCause(admitted.cause)
              }

              owner.fiber = admitted.value
              const joinFiber = yield* Effect.forkChild(restore(Fiber.join(admitted.value)), { startImmediately: true })
              owner.markFiberReady()
              return yield* restore(Fiber.join(joinFiber))
            }),
          ),
        )
      }

      /** Whether a scan (manual or background) is in flight — the worker owns
       * the scan, so it is the one authority; a window reads it once at boot
       * and follows the broadcast lifecycle from there. */
      case 'scan:active':
        return Effect.sync(() => this.activeScan !== null)

      case 'scan:abort': {
        // Set the cooperative stop state before interruption. The scan owner
        // remains active until the underlying parser Promise has drained.
        return this.provideRuntime(Effect.as(this.interruptActiveScanEffect(), null))
      }

      /** Graceful shutdown (quit path): stop background work and close the
       * ledger after its outstanding scan and FX requests have settled. */
      case 'shutdown':
        return Effect.as(this.closeEffect(), null)

      case 'cadence:get':
        return this.provideRuntime(Effect.flatMap(LedgerConfig, config => config.getRefreshCadence()))

      case 'cadence:set': {
        const reschedule = this.scheduleCadenceEffect()
        return this.provideRuntime(
          Effect.gen(function* () {
            yield* setRefreshCadence(args[0])
            yield* reschedule
            const config = yield* LedgerConfig
            return yield* config.getRefreshCadence()
          }),
        )
      }

      /** Scan status (ADR 0004): the most recent completed scan's metadata,
       * or a "never scanned" sentinel when the ledger has no rows at all. */
      case 'store:status': {
        const metadata = this.lastScanMetadata
        return this.provideRuntime(
          Effect.flatMap(LedgerQueries, queries => queries.hasSources()).pipe(
            Effect.map(hasRows => ({ scanned: hasRows || metadata !== null, ...(metadata ? { metadata } : {}) })),
          ),
        )
      }

      case 'settings:info':
        return this.provideRuntime(settingsInfoEffect(this.dataDir, this.cacheDir))

      case 'settings:clear': {
        const emit = this.emit
        const resetMetadata = Effect.sync(() => {
          this.lastScanMetadata = null
        })
        const settingsInfo = Effect.suspend(() => this.readSettingsInfo(this.dataDir, this.cacheDir))
        return this.provideRuntime(
          Effect.gen(function* () {
            yield* clearLedger()
            yield* resetMetadata
            yield* Effect.sync(() => emit({ event: 'ledger:reset' }))
            return yield* settingsInfo
          }),
        )
      }

      /** Pricing-table live refresh. NOTE: the pricing table is module-level
       * in-memory state (pipeline/models.ts), so the refresh MUST run on the
       * thread that scans — this worker — or it would update a copy nothing
       * reads. `HttpFetch` and `Env` come from the worker runtime, so a test can
       * substitute either without touching this arm; the `{ok:true}` /
       * `{ok:false, error}` envelopes are unchanged. */
      case 'pricing:refresh': {
        return this.provideRuntime(
          refreshPricingNowEffect().pipe(
            Effect.map(() => ({ ok: true as const })),
            Effect.catch(() => Effect.succeed({ ok: false as const, error: PRICING_REFRESH_FAILURE_MESSAGE })),
          ),
        )
      }

      /** The active display currency (ADR 0009): the persisted code plus its
       * CACHED rate from the FX side-table. Never touches the network. */
      case 'currency:get':
        return this.provideRuntime(queryActiveCurrency())

      /** Select a display currency (ADR 0009): persists the choice, kicks off a
       * non-blocking Frankfurter refresh in the background when the cached rate
       * is missing/stale, and returns the current state immediately — readers
       * keep working on the last cached rate (or USD) while the fetch runs.
       * When the fetch lands, `currency:changed` is emitted. */
      case 'currency:set': {
        const code = args[0] as string // Validated by selectDisplayCurrency.
        const emit = this.emit
        const isClosed = (): boolean => this.closed
        return this.provideRuntime(
          Effect.gen({ self: this }, function* () {
            const selected = yield* selectDisplayCurrency(code)
            yield* Effect.sync(() =>
              this.startBackgroundFx(
                Effect.gen(function* () {
                  const currency = yield* refreshFxRateWithRates(code)
                  if (!isClosed()) yield* Effect.sync(() => emit({ event: 'currency:changed', currency }))
                }),
              ),
            )
            return selected
          }),
        )
      }

      /** The full ISO 4217 currency list (162 codes) for the Settings selector. */
      case 'currency:list':
        return Effect.sync(() => listCurrencies() satisfies CurrencyOption[])

      default:
        return Effect.fail(new Error(`unknown db-worker op: ${op}`))
    }
  }

  /** Promise facade retained for local compatibility tests and legacy callers. */
  dispatch(op: string, args: unknown[]): Promise<unknown> {
    return Effect.runPromise(this.dispatchEffect(op, args))
  }

  /** Stop background work and close the store after scans/FX settle. Idempotent. */
  private closeEffect(): Effect.Effect<void> {
    if (this.closeFiber)
      return Fiber.join(this.closeFiber).pipe(
        Effect.asVoid,
        Effect.catchCause(() => Effect.void),
      )
    this.closed = true
    this.cadenceGeneration++
    this.cadenceFiber = null
    const activeScan = this.activeScan
    if (activeScan) activeScan.aborted = true
    const backgroundScope = this.backgroundScope
    const scanScope = this.scanScope
    const currentScan = (): Fiber.Fiber<unknown, unknown> | null => activeScan?.fiber ?? null
    const disposeRuntime = this.runtime.disposeEffect
    const shutdown = Effect.gen({ self: this }, function* () {
      yield* Scope.close(backgroundScope, Exit.void)
      // Setting the abort flag alone does not wake an Effect awaiting scan
      // work. Interrupt the owned work fiber and wait for its finalizers before
      // closing the scan scope or releasing the SQL runtime.
      yield* this.interruptActiveScanEffect(true)
      const scan = yield* Effect.sync(currentScan)
      if (scan) yield* Fiber.await(scan).pipe(Effect.asVoid)
      if (activeScan) {
        yield* Effect.sync(() => {
          if (this.activeScan === activeScan) this.activeScan = null
        })
      }
      yield* Scope.close(scanScope, Exit.void)
      // Release the SQL client only after background work and parser callbacks drain.
      yield* disposeRuntime
    })
    const closeFiber = this.runtime.runFork(shutdown)
    this.closeFiber = closeFiber
    return Fiber.join(closeFiber).pipe(
      Effect.asVoid,
      Effect.catchCause(() => Effect.void),
    )
  }

  close(): Promise<void> {
    return Effect.runPromise(this.closeEffect())
  }
}
