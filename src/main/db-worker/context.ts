import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Schedule from 'effect/Schedule'
import type { SchemaError } from 'effect/Schema'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import type { SqlError } from 'effect/unstable/sql/SqlError'
import { readdirSync, statSync } from 'fs'
import { join } from 'path'

import type { ComparePair } from '../../shared/schemas/compare.js'
import {
  DEFAULT_SKILLS_THRESHOLDS,
  type SkillsThresholds,
  skillsThresholdsSchema,
} from '../../shared/schemas/skills.js'
import { queryCompareView } from '../application/compare-query.js'
import { queryExport } from '../application/export-query.js'
import { GatewayReports } from '../application/gateway-reports.js'
import { queryModelsView } from '../application/models-query.js'
import { queryOptimizeView } from '../application/optimize-query.js'
import { queryOverview } from '../application/overview-query.js'
import { queryPullRequestsView } from '../application/pull-requests-query.js'
import { querySessionsView } from '../application/sessions-query.js'
import { querySkillsView } from '../application/skills-query.js'
import { querySpendView } from '../application/spend-query.js'
import { queryAnalyticalViews, queryDashboardViews } from '../application/view-queries.js'
import { queryYieldView } from '../application/yield-query.js'
import { resolveCadenceMs } from '../cadence.js'
import type { Env } from '../env.js'
import {
  type ActiveCurrency,
  type CurrencyOption,
  FxRates,
  getActiveCurrency,
  isValidCurrencyCode,
  listCurrencies,
  refreshFxRateWithRates,
} from '../fx.js'
import type { OperationalLog } from '../operational-log.js'
import type { OverviewScope } from '../overview.js'
import type { HttpFetch } from '../pipeline/fetch-utils.js'
import { fileErrorCode, takeQueuedLogRecords } from '../pipeline/file-errors.js'
import { getRepoUrl } from '../pipeline/git-remote.js'
import {
  captureLocalModelSavings,
  captureModelPricingCatalogue,
  captureProxyPaths,
  refreshPricingNowEffect,
} from '../pipeline/models.js'
import type { DeltaHandler } from '../pipeline/parser.js'
import { getClaudeConfigDirs } from '../pipeline/providers/claude.js'
import {
  buildScanSummaryRecords,
  runScan,
  ScanAbortedError,
  type ScanMetadata,
  type ScanProgress,
} from '../pipeline/scan.js'
import type { DateRange } from '../pipeline/types.js'
import { LedgerStore } from '../store/ledger.js'
import {
  buildProjectRowsFromLedger,
  getSessionDetailFromLedger,
  querySessionRowsFromLedger,
  searchSessionsFromLedger,
} from '../views.js'
import type { WorkerRuntime } from '../worker-runtime.js'
import type { DbWorkerData, DbWorkerEvent } from './protocol.js'

export type DbWorkerEmit = (event: DbWorkerEvent) => void

function dirSize(path: string): number {
  let total = 0
  try {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) total += dirSize(full)
      else if (entry.isFile()) total += statSync(full).size
    }
  } catch {
    // missing or unreadable dir counts as zero
  }
  return total
}

/**
 * The scan ALWAYS ports lifetime (epoch → now): the ledger must absorb every
 * file's full history on its first scan, and the old report-era 30-day default
 * (or any windowed scan) would silently strand anything outside the window
 * forever — a cold first scan has no cache entry to fall back to as an
 * `unchanged` backfill. The views apply their own period at read time
 * (aggregation), never at scan time, so a windowed scan is never wanted.
 */
function lifetimeRange(): DateRange {
  return { start: new Date(0), end: new Date() }
}

function abortedScanError(): ScanAbortedError {
  return new ScanAbortedError({ message: 'scan aborted' })
}

/**
 * What the composition root (`db-worker/entry.ts`, ADR 0023) hands in: the
 * single-writer ledger this thread owns, and the worker's application runtime
 * built from it. They are constructed together because `WorkerLive`'s `FxRates`
 * layer is bound to that store instance — the runtime is the ONLY place worker
 * workflows obtain their capabilities now (no per-call `Effect.provide`), so a
 * test can substitute any of them by handing in a differently-composed runtime.
 */
export interface DbWorkerDeps {
  readonly ledger: LedgerStore
  readonly runtime: WorkerRuntime
}

interface ActiveScan {
  readonly manual: boolean
  aborted: boolean
  fiber: Fiber.Fiber<ScanMetadata, unknown> | null
}

/**
 * Everything the old main process owned around the ledger, now running on the
 * db-worker thread: the scan lifecycle, the background cadence, and every
 * query-time view builder over the store the root hands in. The main process
 * only forwards renderer IPC here and relays the emitted broadcasts to
 * windows — so a scan or a heavy aggregation blocks this thread, never the main
 * event loop.
 */
export class DbWorkerContext {
  private ledger: LedgerStore
  private runtime: WorkerRuntime
  private dataDir: string
  private cacheDir: string
  private emit: DbWorkerEmit
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
  private closeFiber: Fiber.Fiber<void> | null = null
  private closed = false

  constructor(init: DbWorkerData, emit: DbWorkerEmit, deps: DbWorkerDeps) {
    this.dataDir = init.dataDir
    this.cacheDir = init.cacheDir
    this.emit = emit
    this.ledger = deps.ledger
    this.runtime = deps.runtime
    void this.scheduleCadence()
    // Prime the FX side-table for the persisted display currency at startup,
    // non-blocking: readers use the cached rate (or USD) meanwhile, and an
    // event lands the fresh rate if the cache was stale.
    this.startBackgroundFx(this.refreshFxOnCadence())
  }

  // ── Scan pipeline ───────────────────────────────────────────────────

  /** Runs one scan pass: parse streams per-file deltas into the ledger (ticket
   * 03) and the scan returns metadata — never a `ProjectSummary[]`, never a
   * `saveReport`. Shared by the manual ⌘R-triggered path and the
   * background-cadence timer, so both go through identical port-in + broadcast
   * semantics. Repo URLs are resolved per unique project cwd (memoized) so the
   * ledger's per-source `repo_url` is captured at port-in without a rescan.
   *
   * `HttpFetch | Env | OperationalLog` are UNSATISFIED requirements (ADR 0032
   * P2: a workflow widens its `R`; it never provides a layer). `runTrackedScan`
   * supplies them from the worker runtime — which used to be a per-call
   * `Effect.provide(Layer.mergeAll(liveFetchLayer(), Env.layer,
   * OperationalLog.layer))` here, so `Env` was rebuilt on every scan. The
   * `R`-channel `OperationalLog` over the snapshot-style optional value-seam is
   * unchanged: the live layer still delegates to the main-owned Operational-log writer
   * (same sink/allowlist/`main` context, never a second sink), tests still
   * substitute `OperationalLog.layerWithSink`, and never-throw filing lives in
   * `runScan`'s `onExit` (`catchCause`) so forked scan fibers stay green. */
  private performScan(
    options: { provider?: string } | undefined,
    emit: (progress: ScanProgress) => void,
    owner: ActiveScan,
  ): Effect.Effect<ScanMetadata, unknown, HttpFetch | Env | OperationalLog> {
    const range = lifetimeRange()
    const repoUrlCache = new Map<string, Promise<string | undefined>>()
    const portIn: DeltaHandler = async (delta, pricing) => {
      if (delta.cachedFile.failed) return
      if (owner.aborted) throw abortedScanError()
      // Repository badge (#106): resolve from the canonical project path for
      // every provider — the worktree-folded cwd when the parser derived one,
      // else the provider's exact working directory. Same memoized-per-scan,
      // silent-when-absent semantics as before; never an identity key.
      const cwd = delta.cachedFile.canonicalCwd ?? delta.workingDirectory ?? delta.cachedFile.workingDirectory
      let repoUrl: string | undefined
      if (cwd) {
        let lookup = repoUrlCache.get(cwd)
        if (!lookup) {
          lookup = getRepoUrl(cwd)
          repoUrlCache.set(cwd, lookup)
        }
        repoUrl = await lookup
      }
      // The git lookup is an external Promise and may outlive interruption.
      // Check on both sides so an old scan can never write after cancellation.
      if (owner.aborted) throw abortedScanError()
      this.ledger.portIn({ ...delta, repoUrl }, pricing)
    }
    return runScan(
      { range, provider: options?.provider },
      emit,
      { isAborted: () => owner.aborted },
      // Ledger port-in seam (ADR 0002): every settled session file is streamed
      // to the ledger while the parse runs. The scan's delta wrapper already
      // gates out failed parses; `unchanged` is a no-op inside portIn.
      portIn,
      {
        gatewayEnabled: this.runtime.runSync(Effect.map(GatewayReports, reports => reports.enabled)),
        fetchGatewayReport: (range, signal) =>
          this.runtime.runPromise(
            Effect.flatMap(GatewayReports, reports => reports.getReport(range, signal)),
            { signal },
          ),
      },
      // Effect-native typed-abort proof (Wave 5 §2): `catchTag` on the `_tag`
      // (NOT `instanceof`, NOT `either`). No `either` here, so no span-inside
      // trap — any future `withSpan` must wrap OUTSIDE this `catchTag`, never
      // inside a branch. Re-fails unchanged so envelopes/flag semantics stay
      // byte-identical downstream (Promise-boundary `instanceof` + flag in the
      // `scan:start`/background catches). Defects stay in Cause (no catchAll).
    ).pipe(Effect.catchTag('ScanAbortedError', err => Effect.fail(err)))
  }

  /**
   * Forks the scan into `scanScope` and joins it.
   *
   * `runtime.runSync(Effect.forkIn(...))` — NOT `Effect.runSync`: forking is the
   * only reason this is synchronous, and the runtime supplies `performScan`'s
   * `HttpFetch | Env | OperationalLog` requirements from the memoised
   * `WorkerLive` context (it used to build a fresh layer per scan). The join
   * stays Promise-returning at the `dispatch` boundary: the scan fiber's own
   * lifecycle is owned by `scanScope` and is deliberately unchanged by this
   * slice, interruption and all.
   */
  private async runTrackedScan(
    owner: ActiveScan,
    options: { provider?: string } | undefined,
    emit: (progress: ScanProgress) => void,
  ): Promise<ScanMetadata> {
    const fiber = this.runtime.runSync(
      Effect.forkIn(this.performScan(options, emit, owner), this.scanScope, { startImmediately: true }),
    )
    owner.fiber = fiber
    try {
      return await Effect.runPromise(Fiber.join(fiber))
    } finally {
      if (this.activeScan === owner) this.activeScan = null
    }
  }

  /**
   * Forks non-blocking background FX work into `backgroundScope` (startup prime,
   * cadence tick, post-`currency:set` refresh). Runs through the runtime, so
   * `HttpFetch | FxRates` come from the one memoised `WorkerLive` graph instead
   * of a per-call `liveFxLayer(this.ledger)` rebuild.
   */
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
    // Promise-boundary seam (NOT Effect-native): called from `await`
    // `runTrackedScan` catches with `unknown`, so this stays `instanceof`
    // (NOT `catchTag` — no Effect here). Works with the TaggedError because
    // the class NAME is preserved.
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

  /** Fires on the configured cadence (ADR 0004). Silent on failure — the
   * user's last-known data stays visible (stale-while-revalidate) and they can
   * still trigger a manual scan via ⌘R; background scans don't surface errors
   * as intrusively as a user-initiated one would. Coalesces with any
   * already-running scan rather than overlapping it. */
  private async triggerBackgroundScan(): Promise<void> {
    if (this.closed || this.activeScan !== null) return
    const owner: ActiveScan = { manual: false, aborted: false, fiber: null }
    this.activeScan = owner
    this.emitScanStart()
    try {
      const metadata = await this.runTrackedScan(owner, undefined, progress =>
        this.emit({ event: 'scan:progress', manual: owner.manual, progress }),
      )
      this.lastScanMetadata = metadata
      this.emit({ event: 'store:changed', metadata })
      this.emitScanFinish(metadata)
    } catch (err) {
      // background scans fail silently; manual ⌘R remains available.
      // Fiber interruption (abort/close) rides the abort flag so the oplog
      // stays `scan.abort` (warn), not `scan.error`. Promise-boundary
      // `instanceof` + flag mapping stays (NOT `catchTag` — this is `await`,
      // not an Effect); the Effect-native `catchTag` proof lives in
      // `performScan`.
      this.emit({ event: 'scan:idle' })
      this.emitScanFailure(owner.aborted ? abortedScanError() : err)
    }
  }

  /** (Re)schedules the background scan in the worker scope from the persisted
   * cadence. Ticks remain delayed and fixed-rate; scan coalescing stays in
   * triggerBackgroundScan. */
  private scheduleCadenceEffect(): Effect.Effect<void> {
    const ledger = this.ledger
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
    const runTick = (): void => {
      this.startBackgroundFx(this.refreshFxOnCadence())
      void this.triggerBackgroundScan()
    }
    const tick = Effect.sync(runTick)
    return Effect.gen(function* () {
      const { generation, previous } = yield* Effect.sync(nextGeneration)
      if (previous) yield* Fiber.interrupt(previous)
      if (yield* Effect.sync(() => isStale(generation))) return

      const ms = resolveCadenceMs(ledger.getRefreshCadence())
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
    await Effect.runPromise(this.scheduleCadenceEffect())
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

  private userDataPaths(): {
    dataDir: string
    dbSize: number
    dataDirSize: number
    cacheDir: string
    cacheSize: number
  } {
    const dbPath = join(this.dataDir, 'ledger.db')
    let dbSize = 0
    try {
      dbSize = statSync(dbPath).size
    } catch {
      /* no db yet */
    }
    return {
      dataDir: this.dataDir,
      dbSize,
      dataDirSize: dirSize(this.dataDir),
      cacheDir: this.cacheDir,
      cacheSize: dirSize(this.cacheDir),
    }
  }

  private async settingsInfo(): Promise<{
    dataDir: string
    dbSize: number
    dataDirSize: number
    cacheDir: string
    cacheSize: number
    claudeConfigDirs?: string[]
  }> {
    // The Claude-config row in General is nullable: when the config dirs cannot
    // be resolved we omit the field entirely so the renderer just hides the row.
    let claudeConfigDirs: string[] | undefined
    try {
      claudeConfigDirs = await getClaudeConfigDirs()
    } catch {
      /* absent */
    }
    return { ...this.userDataPaths(), claudeConfigDirs }
  }

  // ── Op dispatch (one arm per renderer IPC channel that touches data) ──

  async dispatch(op: string, args: unknown[]): Promise<unknown> {
    if (this.closed && op !== 'shutdown') throw new Error('db-worker is shutting down')
    const ledger = this.ledger
    switch (op) {
      case 'scan:start': {
        const options = args[0] as { provider?: string } | undefined
        // A scan is already in flight (background cadence or a concurrent call).
        // This is NOT a failure: its progress and store:changed events will land
        // on their own, so the renderer must not surface an error box or a retry
        // button for it — hence the explicit flag instead of an error string.
        // Coalescing retains ownership through parser Promise drainage.
        if (this.activeScan !== null) return { ok: false, alreadyRunning: true }
        const owner: ActiveScan = { manual: true, aborted: false, fiber: null }
        this.activeScan = owner
        this.emitScanStart(options?.provider)
        try {
          const metadata = await this.runTrackedScan(owner, options, progress =>
            this.emit({ event: 'scan:progress', manual: owner.manual, progress }),
          )
          this.lastScanMetadata = metadata
          this.emit({ event: 'store:changed', metadata })
          this.emitScanFinish(metadata)
          // The `metadata` lands on `store:changed`; the scan-result envelope
          // itself carries only the flags scanResultSchema declares, so the
          // wire stays byte-faithful to the shared schema.
          return { ok: true }
        } catch (err) {
          // Fiber interruption (abort/close) rides the abort flag so the wire
          // stays `{ok:false, aborted:true}` + `scan:error` even when the
          // failure is an interruption cause rather than `ScanAbortedError`.
          // Promise-boundary `instanceof` + flag mapping stays (NOT `catchTag`
          // — this is `await runTrackedScan`, not an Effect); the Effect-native
          // `catchTag` proof lives in `performScan`. `store:changed` only on
          // success (this `catch` never emits it).
          const aborted = err instanceof ScanAbortedError || owner.aborted
          const normalized = aborted && !(err instanceof ScanAbortedError) ? abortedScanError() : err
          const message = aborted ? 'scan aborted' : err instanceof Error ? err.message : String(err)
          this.emit({ event: 'scan:error', manual: true, message })
          this.emitScanFailure(normalized)
          return {
            ok: false,
            aborted,
            error: normalized instanceof Error ? normalized.message : String(normalized),
          }
        }
      }

      case 'scan:abort': {
        // Set the cooperative stop state before interruption. The scan owner
        // remains active until the underlying parser Promise has drained.
        const owner = this.activeScan
        if (owner) owner.aborted = true
        const fiber = owner?.fiber
        if (fiber) await Effect.runPromise(Fiber.interrupt(fiber))
        return null
      }

      /** Graceful shutdown (quit path): stop background work and close the
       * ledger after its outstanding scan and FX requests have settled. */
      case 'shutdown':
        await this.close()
        return null

      /** Persisted cadence read. Plain sync store call: the `Effect.runPromise(
       * Effect.sync(...))` wrapper this used to wear added a microtask and a
       * `never`-typed `R` around a synchronous `node:sqlite` read, and rejected
       * with the SAME squashed error when it threw — so the wrapper was
       * ceremony with no composition in it. `dispatch` is already Promise-
       * returning (a `worker_threads` handler IS a composition root, ADR 0023),
       * so the arm stays async with no Effect at all. */
      case 'cadence:get': {
        return ledger.getRefreshCadence()
      }

      case 'cadence:set': {
        const value = args[0] as string
        const reschedule = this.scheduleCadenceEffect()
        // Only `reschedule` is genuinely effectful (it interrupts the prior
        // cadence fiber and forks the new one into `backgroundScope`), so only
        // it stays an Effect, run through the worker runtime.
        return this.runtime.runPromise(
          Effect.gen(function* () {
            ledger.setRefreshCadence(value)
            yield* reschedule
            return ledger.getRefreshCadence()
          }),
        )
      }

      /** Scan status (ADR 0004): the most recent completed scan's metadata,
       * or a "never scanned" sentinel when the ledger has no rows at all. */
      case 'store:status': {
        const hasRows = ledger.getSources().length > 0
        return {
          scanned: hasRows || this.lastScanMetadata !== null,
          ...(this.lastScanMetadata ? { metadata: this.lastScanMetadata } : {}),
        }
      }

      case 'store:views':
        return this.runtime.runPromise(
          queryDashboardViews({ catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() }),
        )

      case 'store:projects':
        return buildProjectRowsFromLedger(ledger)

      case 'store:sessions': {
        const filter = (args[0] ?? {}) as { project?: string; since?: string; until?: string }
        return querySessionRowsFromLedger(ledger, filter)
      }

      case 'sessions:view': {
        const scope = args[0] as OverviewScope
        return this.runtime.runPromise(
          querySessionsView({ scope, catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() }),
        )
      }

      case 'pullRequests:view': {
        const scope = args[0] as OverviewScope
        return this.runtime.runPromise(
          queryPullRequestsView({ scope, catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() }),
        )
      }

      case 'spend:view': {
        const scope = args[0] as OverviewScope
        return this.runtime.runPromise(
          querySpendView({ scope, catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() }),
        )
      }

      /** The Models section's scoped payload (ADR 0008): by-model / by-task /
       * audit lenses. Built at read time from the ledger plus the CURRENT
       * alias/price-override config tables, so a quick-add write updates the
       * affected rows on the next query without a rescan. */
      case 'models:view': {
        const scope = args[0] as OverviewScope
        return this.runtime.runPromise(
          queryModelsView({ scope, catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() }),
        )
      }

      /** The Compare section's scoped payload (ADR 0008): a model-pair picker
       * over every detected model, plus a query-time side-by-side metrics card,
       * per-category one-shot bars, and a working-style card. */
      case 'compare:view': {
        const scope = args[0] as OverviewScope
        const pair = args[1] as ComparePair | undefined
        return this.runtime.runPromise(
          queryCompareView({ scope, pair, catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() }),
        )
      }

      /** Optimize combines captured ledger data and assistant setup facts in
       * pure detectors, then validates the section payload (ADR 0008). */
      case 'optimize:view': {
        const scope = args[0] as OverviewScope
        return this.runtime.runPromise(
          queryOptimizeView({ scope, catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() }),
        )
      }

      /** The Skills section's detection payload (ticket 24): pure local mining
       * of skill/bash/tool seams plus the on-disk inventory — no consent, no
       * network. Thresholds (frequency × spread) are renderer settings passed
       * per request; defaults (5 × 2) apply when absent. */
      case 'skills:view': {
        const scope = args[0] as OverviewScope
        const thresholds = args[1] as SkillsThresholds | undefined
        // Schema decoding requires positive integer thresholds and applies
        // defaults. Invalid IPC values use the default pair (ADR 0005).
        const parsed = Schema.decodeUnknownResult(skillsThresholdsSchema)(thresholds)
        // Dismissals ride every fetch (ticket 25): the not-a-skill store filters
        // rejected patterns out of drafts AND opportunities before the gate.
        return this.runtime.runPromise(
          querySkillsView({
            scope,
            thresholds: parsed._tag === 'Success' ? parsed.success : DEFAULT_SKILLS_THRESHOLDS,
            catalogue: captureModelPricingCatalogue(),
            proxyPaths: captureProxyPaths(),
          }),
        )
      }

      /** Not-a-skill dismissal write (ticket 25): a ledger config-table upsert,
       * so dismissals survive `clear()`. */
      case 'skills:dismiss': {
        const req = args[0] as { source: 'skill' | 'bash' | 'tool'; name: string; reason: string }
        ledger.dismissSkill(req.source, req.name, req.reason)
        return { ok: true }
      }

      /** Yield inspects repositories at query time (ADR 0008). Expected git
       * failures use partial or empty facts; defects remain query failures. */
      case 'optimize:yield': {
        const scope = args[0] as OverviewScope
        return this.runtime.runPromise(
          queryYieldView({ scope, catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() }),
        )
      }

      /** Quick-add alias (ADR 0010): map an unpriced model to a priced one,
       * writing directly to the ledger's `model_alias` config table. The
       * `config:changed` event tells the mounted view to refetch (query-time
       * config — no rescan). */
      case 'models:addAlias': {
        const model = args[0] as string
        const aliasOf = args[1] as string
        if (typeof model !== 'string' || !model.trim() || typeof aliasOf !== 'string' || !aliasOf.trim()) {
          throw new Error('model and alias target must be non-empty strings')
        }
        ledger.setModelAlias(model.trim(), aliasOf.trim())
        this.emit({ event: 'config:changed' })
        return { ok: true }
      }

      /** Read the current model-alias config (Settings › Model aliases CRUD). */
      case 'models:getAliases':
        return ledger.getModelAliases()

      /** Remove a model alias (Settings › Model aliases CRUD). */
      case 'models:removeAlias': {
        const model = args[0] as string
        if (typeof model !== 'string' || !model.trim()) {
          throw new Error('model must be a non-empty string')
        }
        ledger.removeModelAlias(model.trim())
        this.emit({ event: 'config:changed' })
        return { ok: true }
      }

      /** Read the current price-override config (Settings › Pricing CRUD). */
      case 'models:getPriceOverrides':
        return ledger.getPriceOverrides()

      /** Remove a price override (Settings › Pricing CRUD): a pure config delete —
       * display cost reverts to the stored base on the next query (query-time
       * pricing), no row updates, no rescan. */
      case 'models:removePriceOverride': {
        const model = args[0] as string
        if (typeof model !== 'string' || !model.trim()) {
          throw new Error('model must be a non-empty string')
        }
        ledger.removePriceOverride(model.trim())
        this.emit({ event: 'config:changed' })
        return { ok: true }
      }

      /** Quick-add price override (ADR 0010): a manual price (USD per 1M tokens)
       * for a model, a pure upsert on the ledger's `price_override` config table
       * (display cost recomputes on read) plus a `config:changed` event. */
      case 'models:setPrice': {
        const model = args[0] as string
        const inputPricePerMillion = args[1] as number
        const outputPricePerMillion = args[2] as number
        if (typeof model !== 'string' || !model.trim()) {
          throw new Error('model must be a non-empty string')
        }
        if (
          !Number.isFinite(inputPricePerMillion) ||
          inputPricePerMillion < 0 ||
          !Number.isFinite(outputPricePerMillion) ||
          outputPricePerMillion < 0
        ) {
          throw new Error('prices must be non-negative numbers')
        }
        ledger.setPriceOverride(model.trim(), { inputPricePerMillion, outputPricePerMillion })
        this.emit({ event: 'config:changed' })
        return { ok: true }
      }

      case 'store:session': {
        const sessionId = args[0] as string
        return getSessionDetailFromLedger(ledger, sessionId)
      }

      case 'store:analytics':
        return this.runtime.runPromise(
          queryAnalyticalViews({ catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() }),
        )

      case 'overview:query': {
        const scope = args[0] as OverviewScope
        return this.runtime.runPromise(
          queryOverview({
            scope,
            catalogue: captureModelPricingCatalogue(),
            proxyPaths: captureProxyPaths(),
            localSavings: captureLocalModelSavings(),
          }),
        )
      }

      case 'store:search': {
        const query = args[0] as string
        return searchSessionsFromLedger(ledger, query)
      }

      case 'settings:info':
        return this.settingsInfo()

      case 'ledger-mcp:startup:get':
        return this.ledger.getLedgerMcpStartupMode()

      case 'ledger-mcp:startup:set':
        return this.ledger.setLedgerMcpStartupMode(args[0])

      case 'settings:clear': {
        ledger.clear()
        this.lastScanMetadata = null
        return this.settingsInfo()
      }

      /** Pricing-table live refresh. NOTE: the pricing table is module-level
       * in-memory state (pipeline/models.ts), so the refresh MUST run on the
       * thread that scans — this worker — or it would update a copy nothing
       * reads. `HttpFetch` and `Env` come from the worker runtime, so a test can
       * substitute either without touching this arm; the `{ok:true}` /
       * `{ok:false, error}` envelopes are unchanged. */
      case 'pricing:refresh': {
        return this.runtime.runPromise(
          refreshPricingNowEffect().pipe(
            Effect.map(() => ({ ok: true as const })),
            Effect.catch(err => Effect.succeed({ ok: false as const, error: err.message })),
          ),
        )
      }

      /** The active display currency (ADR 0009): the persisted code plus its
       * CACHED rate from the FX side-table. Never touches the network. */
      case 'currency:get':
        return getActiveCurrency(ledger) satisfies ActiveCurrency

      /** Select a display currency (ADR 0009): persists the choice, kicks off a
       * non-blocking Frankfurter refresh in the background when the cached rate
       * is missing/stale, and returns the current state immediately — readers
       * keep working on the last cached rate (or USD) while the fetch runs.
       * When the fetch lands, `currency:changed` is emitted. */
      case 'currency:set': {
        const code = args[0] as string
        if (typeof code !== 'string' || !isValidCurrencyCode(code)) {
          throw new Error('invalid ISO 4217 currency code')
        }
        // Repository-direct write (ADR 0032 follow-up): through the `FxRates`
        // port straight to `LedgerConfig`, bypassing the store facade —
        // `LedgerStore.setDisplayCurrency` is gone. The port comes from the
        // worker runtime, so the SAME `FxRates` instance serves this write, the
        // background FX refresh below, and the cadence tick.
        this.runtime.runSync(Effect.flatMap(FxRates, rates => rates.setDisplayCurrency(code)))
        const emit = this.emit
        const isClosed = (): boolean => this.closed
        this.startBackgroundFx(
          Effect.gen(function* () {
            const currency = yield* refreshFxRateWithRates(code)
            if (!isClosed()) yield* Effect.sync(() => emit({ event: 'currency:changed', currency }))
          }),
        )
        return getActiveCurrency(ledger) satisfies ActiveCurrency
      }

      /** The full ISO 4217 currency list (162 codes) for the Settings selector. */
      case 'currency:list':
        return listCurrencies() satisfies CurrencyOption[]

      case 'export:csv': {
        return this.runtime.runPromise(
          queryExport({
            kind: 'csv',
            outputPath: args[0] as string,
            catalogue: captureModelPricingCatalogue(),
            proxyPaths: captureProxyPaths(),
          }),
        )
      }

      case 'export:json': {
        return this.runtime.runPromise(
          queryExport({
            kind: 'json',
            outputPath: args[0] as string,
            catalogue: captureModelPricingCatalogue(),
            proxyPaths: captureProxyPaths(),
          }),
        )
      }

      default:
        throw new Error(`unknown db-worker op: ${op}`)
    }
  }

  /** Stop background work and close the store after scans/FX settle. Idempotent. */
  close(): Promise<void> {
    if (this.closeFiber) return Effect.runPromise(Fiber.join(this.closeFiber))
    this.closed = true
    this.cadenceGeneration++
    this.cadenceFiber = null
    const activeScan = this.activeScan
    if (activeScan) activeScan.aborted = true
    const backgroundScope = this.backgroundScope
    const scanScope = this.scanScope
    const currentScan = (): Fiber.Fiber<ScanMetadata, unknown> | null => activeScan?.fiber ?? null
    const closeLedger = (): void => this.ledger.close()
    const disposeRuntime = this.runtime.disposeEffect
    const shutdown = Effect.gen(function* () {
      yield* Scope.close(backgroundScope, Exit.void)
      const scan = yield* Effect.sync(currentScan)
      if (scan) yield* Fiber.join(scan).pipe(Effect.catch(() => Effect.void))
      yield* Scope.close(scanScope, Exit.void)
      yield* Effect.sync(closeLedger)
      // The borrowed facade's close does not own the connection. Release the
      // root scope and its SQLite driver only after background and scan work drain.
      yield* disposeRuntime
    })
    this.closeFiber = Effect.runFork(shutdown)
    return Effect.runPromise(Fiber.join(this.closeFiber))
  }
}
