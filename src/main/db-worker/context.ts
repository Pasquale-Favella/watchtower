import { dirname, join } from 'path'
import { mkdirSync, statSync, readdirSync } from 'fs'
import { writeFile } from 'node:fs/promises'
import { refreshPricingNow } from '../pipeline/models.js'
import { resolveCadenceMs } from '../cadence.js'
import {
  buildDashboardViewsFromLedger, buildProjectRowsFromLedger, querySessionRowsFromLedger, getSessionDetailFromLedger,
  buildAnalyticalViewsFromLedger, searchSessionsFromLedger, buildProjectsFromLedger,
  type SessionRow,
} from '../views.js'
import { runScan, ScanAbortedError, type ScanMetadata, type ScanProgress } from '../pipeline/scan.js'
import { buildOverviewFromLedger, type OverviewScope } from '../overview.js'
import { buildSessionsViewFromLedger } from '../sessions-view.js'
import { buildPullRequestsViewFromLedger, type PullRequestsPayload } from '../pull-requests-view.js'
import { buildSpendViewFromLedger, type SpendPayload } from '../spend-view.js'
import { buildModelsViewFromLedger, type ModelsPayload } from '../models-view.js'
import { buildCompareViewFromLedger, type ComparePair, type ComparePayload } from '../compare-view.js'
import { buildOptimizeViewFromLedger, type OptimizePayload } from '../optimize-view.js'
import { buildYieldViewFromLedger, type YieldPayload } from '../yield-view.js'
import { buildSkillsViewFromLedger, type SkillsPayload } from '../skills-view.js'
import {
  DEFAULT_SKILLS_THRESHOLDS,
  skillsThresholdsSchema,
  type SkillsThresholds,
} from '../../shared/schemas/skills.js'
import { exportCsv, exportJson } from '../export.js'
import { getClaudeConfigDirs } from '../pipeline/providers/claude.js'
import { getRepoUrl } from '../pipeline/git-remote.js'
import {
  getActiveCurrency, isValidCurrencyCode, listCurrencies, refreshFxRate,
  type ActiveCurrency, type CurrencyOption,
} from '../fx.js'
import type { ExportResult } from '../export.js'
import type { DateRange } from '../pipeline/types.js'
import { LedgerStore } from '../store/ledger.js'
import type { PortInput } from '../store/port.js'
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

/**
 * Everything the old main process owned around the ledger, now running on the
 * db-worker thread: the store itself, the scan lifecycle, the background
 * cadence, and every query-time view builder. The main process only forwards
 * renderer IPC here and relays the emitted broadcasts to windows — so a scan
 * or a heavy aggregation blocks this thread, never the main event loop.
 */
export class DbWorkerContext {
  private ledger: LedgerStore
  private dataDir: string
  private cacheDir: string
  private emit: DbWorkerEmit
  /** The most recent completed scan's metadata — the `getScanStatus()` answer
   * and the `store:changed` payload (ADR 0004). In-memory only. */
  private lastScanMetadata: ScanMetadata | null = null
  private scanActive = false
  private abortRequested = false
  /** True while the in-flight scan was started manually (⌘R): its progress
   * and error events belong to the requesting window only. */
  private manualScan = false
  private cadenceTimer: ReturnType<typeof setInterval> | null = null
  private closed = false

  constructor(init: DbWorkerData, emit: DbWorkerEmit) {
    this.dataDir = init.dataDir
    this.cacheDir = init.cacheDir
    this.emit = emit
    mkdirSync(dirname(init.dbPath), { recursive: true })
    this.ledger = new LedgerStore(init.dbPath)
    this.scheduleCadence()
    // Prime the FX side-table for the persisted display currency at startup,
    // non-blocking: readers use the cached rate (or USD) meanwhile, and an
    // event lands the fresh rate if the cache was stale.
    void this.refreshFxOnCadence()
  }

  // ── Scan pipeline ───────────────────────────────────────────────────

  /** Runs one scan pass: parse streams per-file deltas into the ledger (ticket
   * 03) and the scan returns metadata — never a `ProjectSummary[]`, never a
   * `saveReport`. Shared by the manual ⌘R-triggered path and the
   * background-cadence timer, so both go through identical port-in + broadcast
   * semantics. Repo URLs are resolved per unique project cwd (memoized) so the
   * ledger's per-source `repo_url` is captured at port-in without a rescan. */
  private async performScan(
    options: { provider?: string } | undefined,
    emit: (progress: ScanProgress) => void,
  ): Promise<ScanMetadata> {
    const range = lifetimeRange()
    const repoUrlCache = new Map<string, Promise<string | undefined>>()
    const portIn = async (delta: PortInput): Promise<void> => {
      if (delta.cachedFile.failed) return
      const cwd = delta.cachedFile.canonicalCwd
      let repoUrl: string | undefined
      if (cwd) {
        let lookup = repoUrlCache.get(cwd)
        if (!lookup) {
          lookup = getRepoUrl(cwd)
          repoUrlCache.set(cwd, lookup)
        }
        repoUrl = await lookup
      }
      this.ledger.portIn({ ...delta, repoUrl })
    }
    return runScan(
      { range, provider: options?.provider },
      emit,
      { isAborted: () => this.abortRequested },
      // Ledger port-in seam (ADR 0002): every settled session file is streamed
      // to the ledger while the parse runs. The scan's delta wrapper already
      // gates out failed parses; `unchanged` is a no-op inside portIn.
      portIn,
    )
  }

  /** Fires on the configured cadence (ADR 0004). Silent on failure — the
   * user's last-known data stays visible (stale-while-revalidate) and they can
   * still trigger a manual scan via ⌘R; background scans don't surface errors
   * as intrusively as a user-initiated one would. Coalesces with any
   * already-running scan rather than overlapping it. */
  private async triggerBackgroundScan(): Promise<void> {
    if (this.scanActive) return
    this.scanActive = true
    this.manualScan = false
    this.abortRequested = false
    try {
      const metadata = await this.performScan(undefined, progress =>
        this.emit({ event: 'scan:progress', manual: false, progress }))
      this.lastScanMetadata = metadata
      this.emit({ event: 'store:changed', metadata })
    } catch {
      // background scans fail silently; manual ⌘R remains available
      this.emit({ event: 'scan:idle' })
    } finally {
      this.scanActive = false
    }
  }

  /** (Re)schedules the background-scan timer from the persisted cadence
   * setting. Called at startup and whenever the cadence config changes. */
  private scheduleCadence(): void {
    if (this.cadenceTimer) {
      clearInterval(this.cadenceTimer)
      this.cadenceTimer = null
    }
    const ms = resolveCadenceMs(this.ledger.getRefreshCadence())
    if (ms === null) return // Manual: no background timer
    // The FX background job rides the same repurposed cadence as the scan
    // trigger (ADR 0009): each tick also refreshes the selected currency's
    // rate when it is missing or older than 24h. refreshFxRate never throws,
    // so a Frankfurter outage can never disturb the scan itself.
    this.cadenceTimer = setInterval(() => {
      void this.refreshFxOnCadence()
      void this.triggerBackgroundScan()
    }, ms)
  }

  /** The FX half of the background cadence tick (and the startup prime):
   * refresh the selected currency's cached rate when stale, and emit the
   * result only when the rate actually changed — so a minute cadence doesn't
   * spam re-renders while the 24h cache is still fresh. */
  private async refreshFxOnCadence(): Promise<void> {
    const before = getActiveCurrency(this.ledger)
    const after = await refreshFxRate(this.ledger, this.ledger.getDisplayCurrency())
    if (after.rate !== before.rate || after.updatedAt !== before.updatedAt) {
      this.emit({ event: 'currency:changed', currency: after })
    }
  }

  // ── Settings helpers ────────────────────────────────────────────────

  private userDataPaths(): { dataDir: string; dbSize: number; dataDirSize: number; cacheDir: string; cacheSize: number } {
    const dbPath = join(this.dataDir, 'ledger.db')
    let dbSize = 0
    try { dbSize = statSync(dbPath).size } catch { /* no db yet */ }
    return {
      dataDir: this.dataDir,
      dbSize,
      dataDirSize: dirSize(this.dataDir),
      cacheDir: this.cacheDir,
      cacheSize: dirSize(this.cacheDir),
    }
  }

  private async settingsInfo(): Promise<{ dataDir: string; dbSize: number; dataDirSize: number; cacheDir: string; cacheSize: number; claudeConfigDirs?: string[] }> {
    // The Claude-config row in General is nullable: when the config dirs cannot
    // be resolved we omit the field entirely so the renderer just hides the row.
    let claudeConfigDirs: string[] | undefined
    try { claudeConfigDirs = await getClaudeConfigDirs() } catch { /* absent */ }
    return { ...this.userDataPaths(), claudeConfigDirs }
  }

  /** CSV/JSON export in the selected display currency (ADR 0009 seam for
   * ADR 0013's Export pane). The destination is always resolved — the main
   * process shows the folder/file picker before calling. Reads the FULL
   * ledger history through the aggregation layer (ADR 0013): the gate is
   * "ledger has any rows", and there is no date-range filter — exports cover
   * full history. Cost figures stay USD-anchored in the ledger; conversion is
   * applied only to the files produced here. */
  private async runExport(kind: 'csv' | 'json', target: string): Promise<ExportResult> {
    const projects = buildProjectsFromLedger(this.ledger)
    if (projects.length === 0) {
      return { ok: false, error: 'no data to export yet — scan first' }
    }
    try {
      const path = kind === 'csv'
        ? await exportCsv(projects, target, this.ledger)
        : await exportJson(projects, target, this.ledger)
      return { ok: true, path }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ── Op dispatch (one arm per renderer IPC channel that touches data) ──

  async dispatch(op: string, args: unknown[]): Promise<unknown> {
    const ledger = this.ledger
    switch (op) {
      case 'scan:start': {
        const options = args[0] as { provider?: string } | undefined
        // A scan is already in flight (background cadence or a concurrent call).
        // This is NOT a failure: its progress and store:changed events will land
        // on their own, so the renderer must not surface an error box or a retry
        // button for it — hence the explicit flag instead of an error string.
        if (this.scanActive) return { ok: false, alreadyRunning: true }
        this.scanActive = true
        this.manualScan = true
        this.abortRequested = false
        try {
          const metadata = await this.performScan(options, progress =>
            this.emit({ event: 'scan:progress', manual: true, progress }))
          this.lastScanMetadata = metadata
          this.emit({ event: 'store:changed', metadata })
          // The `metadata` lands on `store:changed`; the scan-result envelope
          // itself carries only the flags scanResultSchema declares, so the
          // wire stays byte-faithful to the shared schema.
          return { ok: true }
        } catch (err) {
          const message = err instanceof ScanAbortedError
            ? 'scan aborted'
            : err instanceof Error ? err.message : String(err)
          this.emit({ event: 'scan:error', manual: true, message })
          return { ok: false, aborted: err instanceof ScanAbortedError, error: err instanceof Error ? err.message : String(err) }
        } finally {
          this.scanActive = false
        }
      }

      case 'scan:abort':
        this.abortRequested = true
        return null

      /** Graceful shutdown (quit path): stop the cadence and checkpoint +
       * close the ledger. Best-effort — quitting never blocks on it. */
      case 'shutdown':
        this.close()
        return null

      case 'cadence:get':
        return ledger.getRefreshCadence()

      case 'cadence:set': {
        const value = args[0] as string
        ledger.setRefreshCadence(value)
        this.scheduleCadence()
        return ledger.getRefreshCadence()
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
        return buildDashboardViewsFromLedger(ledger)

      case 'store:projects':
        return buildProjectRowsFromLedger(ledger)

      case 'store:sessions': {
        const filter = (args[0] ?? {}) as { project?: string; since?: string; until?: string }
        return querySessionRowsFromLedger(ledger, filter)
      }

      case 'sessions:view': {
        const scope = args[0] as OverviewScope
        return buildSessionsViewFromLedger(ledger, scope) satisfies SessionRow[]
      }

      case 'pullRequests:view': {
        const scope = args[0] as OverviewScope
        return buildPullRequestsViewFromLedger(ledger, scope) satisfies PullRequestsPayload | null
      }

      case 'spend:view': {
        const scope = args[0] as OverviewScope
        return buildSpendViewFromLedger(ledger, scope) satisfies SpendPayload | null
      }

      /** The Models section's scoped payload (ADR 0008): by-model / by-task /
       * audit lenses. Built at read time from the ledger plus the CURRENT
       * alias/price-override config tables, so a quick-add write updates the
       * affected rows on the next query without a rescan. */
      case 'models:view': {
        const scope = args[0] as OverviewScope
        return buildModelsViewFromLedger(ledger, scope, {
          aliases: ledger.getModelAliases(),
          overrides: ledger.getPriceOverrides(),
        }) satisfies ModelsPayload | null
      }

      /** The Compare section's scoped payload (ADR 0008): a model-pair picker
       * over every detected model, plus a query-time side-by-side metrics card,
       * per-category one-shot bars, and a working-style card. */
      case 'compare:view': {
        const scope = args[0] as OverviewScope
        const pair = args[1] as ComparePair | undefined
        return buildCompareViewFromLedger(ledger, scope, pair) satisfies ComparePayload | null
      }

      /** The Optimize section's scoped payload (ADR 0008): a read-only setup-health
       * grade plus Waste/Fixes findings from the 16 ported detectors. Unlike the
       * other sections this is async (ghost detectors walk ~/.claude on disk). */
      case 'optimize:view': {
        const scope = args[0] as OverviewScope
        return await buildOptimizeViewFromLedger(ledger, scope) satisfies OptimizePayload | null
      }

      /** The Skills section's detection payload (ticket 24): pure local mining
       * of skill/bash/tool seams plus the on-disk inventory — no consent, no
       * network. Thresholds (frequency × spread) are renderer settings passed
       * per request; defaults (5 × 2) apply when absent. */
      case 'skills:view': {
        const scope = args[0] as OverviewScope
        const thresholds = args[1] as SkillsThresholds | undefined
        // Tripwire (ADR 0005): IPC args are `unknown` — safeParse applies the
        // schema's .int().min(1) guards and .default()s, falling back to the
        // defaults on garbage so a malformed renderer value can never flip every
        // pattern into a draft.
        const parsed = skillsThresholdsSchema.safeParse(thresholds)
        // Dismissals ride every fetch (ticket 25): the not-a-skill store filters
        // rejected patterns out of drafts AND opportunities before the gate.
        return await buildSkillsViewFromLedger(
          ledger,
          scope,
          parsed.success ? parsed.data : DEFAULT_SKILLS_THRESHOLDS,
          { dismissals: ledger.getSkillDismissals() },
        ) satisfies SkillsPayload | null
      }

      /** Not-a-skill dismissal write (ticket 25): a ledger config-table upsert,
       * so dismissals survive `clear()`. */
      case 'skills:dismiss': {
        const req = args[0] as { source: 'skill' | 'bash' | 'tool'; name: string; reason: string }
        ledger.dismissSkill(req.source, req.name, req.reason)
        return { ok: true }
      }

      /** The Optimize section's Reverts/Abandoned payload (ADR 0008): yield
       * computed query-time from live git calls on each project's repo, only
       * fetched when that Section is actually viewed — never persisted at scan time.
       * All git failures degrade to empty, so a missing/non-git repo simply shows
       * nothing rather than erroring the section. */
      case 'optimize:yield': {
        const scope = args[0] as OverviewScope
        return await buildYieldViewFromLedger(ledger, scope) satisfies YieldPayload | null
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
        if (!Number.isFinite(inputPricePerMillion) || inputPricePerMillion < 0
          || !Number.isFinite(outputPricePerMillion) || outputPricePerMillion < 0) {
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
        return buildAnalyticalViewsFromLedger(ledger)

      case 'overview:query': {
        const scope = args[0] as OverviewScope
        return buildOverviewFromLedger(ledger, scope)
      }

      case 'store:search': {
        const query = args[0] as string
        return searchSessionsFromLedger(ledger, query)
      }

      case 'settings:info':
        return this.settingsInfo()

      case 'settings:clear': {
        ledger.clear()
        this.lastScanMetadata = null
        return this.settingsInfo()
      }

      /** Pricing-table live refresh. NOTE: the pricing table is module-level
       * in-memory state (pipeline/models.ts), so the refresh MUST run on the
       * thread that scans — this worker — or it would update a copy nothing
       * reads. */
      case 'pricing:refresh': {
        try {
          await refreshPricingNow()
          return { ok: true }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
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
        ledger.setDisplayCurrency(code)
        void refreshFxRate(ledger, code).then(currency => this.emit({ event: 'currency:changed', currency }))
        return getActiveCurrency(ledger) satisfies ActiveCurrency
      }

      /** The full ISO 4217 currency list (162 codes) for the Settings selector. */
      case 'currency:list':
        return listCurrencies() satisfies CurrencyOption[]

      case 'export:csv': {
        const target = args[0] as string
        return this.runExport('csv', target)
      }

      case 'export:json': {
        const target = args[0] as string
        return this.runExport('json', target)
      }

      default:
        throw new Error(`unknown db-worker op: ${op}`)
    }
  }

  /** Test + shutdown seam: stop the cadence and close the store (lets
   * temp-dir fixtures clean up on Windows). Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.cadenceTimer) {
      clearInterval(this.cadenceTimer)
      this.cadenceTimer = null
    }
    this.ledger.close()
  }
}
