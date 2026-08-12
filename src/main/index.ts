import { dirname, join } from 'path'
import { mkdirSync, statSync, readdirSync, existsSync } from 'fs'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { refreshPricingNow } from './pipeline/models.js'
import { resolveCadenceMs } from './cadence.js'
import {
  buildDashboardViewsFromLedger, buildProjectRowsFromLedger, querySessionRowsFromLedger, getSessionDetailFromLedger,
  buildAnalyticalViewsFromLedger, searchSessionsFromLedger, buildProjectsFromLedger,
  type DashboardViews, type SessionRow
} from './views.js'
import { runScan, ScanAbortedError, type ScanMetadata, type ScanProgress } from './pipeline/scan.js'
import { buildOverviewFromLedger, type OverviewPayload, type OverviewScope } from './overview.js'
import { buildSessionsViewFromLedger } from './sessions-view.js'
import { buildPullRequestsViewFromLedger, type PullRequestsPayload } from './pull-requests-view.js'
import { buildSpendViewFromLedger, type SpendPayload } from './spend-view.js'
import { buildModelsViewFromLedger, type ModelsPayload } from './models-view.js'
import { buildCompareViewFromLedger, type ComparePair, type ComparePayload } from './compare-view.js'
import { buildOptimizeViewFromLedger, type OptimizePayload } from './optimize-view.js'
import { buildYieldViewFromLedger, type YieldPayload } from './yield-view.js'
import { buildSkillsViewFromLedger, type SkillsPayload } from './skills-view.js'
import { slugifyCandidateName } from '../shared/lib/skills-draft.js'
import {
  DEFAULT_SKILLS_THRESHOLDS,
  skillsSaveRequestSchema,
  skillsThresholdsSchema,
  type SkillsSaveResult,
  type SkillsThresholds,
} from '../shared/schemas/skills.js'
import { createUpdateChecker, type UpdateChecker, type UpdateStatus } from './updates.js'
import { exportCsv, exportJson } from './export.js'
import { getClaudeConfigDirs } from './pipeline/providers/claude.js'
import { getRepoUrl } from './pipeline/git-remote.js'
import {
  getActiveCurrency, isValidCurrencyCode, listCurrencies, refreshFxRate,
  type ActiveCurrency, type CurrencyOption
} from './fx.js'
import type { ExportResult } from './export.js'
import type { DateRange } from './pipeline/types.js'
import { LedgerStore } from './store/ledger.js'
import type { PortInput } from './store/port.js'
import { registerAgentsIpc } from './agents/ipc.js'
import { buildLedgerMcpServer } from './agents/ledger-mcp/config.js'

let ledger: LedgerStore | null = null
/** The most recent completed scan's metadata — the `getScanStatus()` answer
 * and the `store:changed` payload (ADR 0004). In-memory only: the ledger
 * itself is the durable source of truth; boot reads it for the sentinel. */
let lastScanMetadata: ScanMetadata | null = null
let scanActive = false
let abortRequested = false
let cadenceTimer: ReturnType<typeof setInterval> | null = null
let updateChecker: UpdateChecker | null = null
/** Coach temp-workspace teardown (map 53): registered at IPC wiring, run on quit. */
let agentsCleanup: { reset: () => void } | null = null

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

function userDataPaths(): { dataDir: string; dbSize: number; dataDirSize: number; cacheDir: string; cacheSize: number } {
  const dataDir = app.getPath('userData')
  // The ledger (ledger.db) is the only database now — the old report's data.db
  // is gone, and the Settings General pane must report the live store's size.
  const dbPath = join(dataDir, 'ledger.db')
  const cacheDir = join(dataDir, 'cache')
  let dbSize = 0
  try { dbSize = statSync(dbPath).size } catch { /* no db yet */ }
  return {
    dataDir,
    dbSize,
    dataDirSize: dirSize(dataDir),
    cacheDir,
    cacheSize: dirSize(cacheDir)
  }
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

/** Tells every window the display currency's rate has been refreshed (ticket
 * 32), so the renderer can repaint money values with the fresh cached rate
 * the moment it lands — without ever polling or fetching itself. */
function broadcastCurrencyChanged(currency: ActiveCurrency): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('currency:changed', currency)
  }
}

/** The FX half of the background cadence tick (and the startup prime):
 * refresh the selected currency's cached rate when stale, and broadcast the
 * result to every window only when the rate actually changed — so a minute
 * cadence doesn't spam re-renders while the 24h cache is still fresh. */
async function refreshFxOnCadence(): Promise<void> {
  if (!ledger) return
  const before = getActiveCurrency(ledger)
  const after = await refreshFxRate(ledger, ledger.getDisplayCurrency())
  if (after.rate !== before.rate || after.updatedAt !== before.updatedAt) {
    broadcastCurrencyChanged(after)
  }
}

/** Pushes a "the store changed" event to every open window, carrying the
 * completed scan's METADATA (ADR 0004 — `reportId` is gone). The
 * renderer's single refetch trigger (ADR 0004): no renderer-side polling
 * loop; the main process alone decides when data is fresh, whether from a
 * manual (⌘R) or background-cadence scan. */
function broadcastChanged(metadata: ScanMetadata): void {
  lastScanMetadata = metadata
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('store:changed', metadata)
  }
}

/** Tells every window a config write happened (price override / model alias),
 * so the mounted view refetches with the fresh query-time config — distinct
 * from `store:changed` (ledger changed vs config changed), no rebuild, no
 * rescan (ADR 0004). */
function broadcastConfigChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('config:changed')
  }
}

/** Runs one scan pass: parse streams per-file deltas into the ledger (ticket
 * 03) and the scan returns metadata — never a `ProjectSummary[]`, never a
 * `saveReport`. Shared by the manual ⌘R-triggered path (scan:start) and the
 * background-cadence timer, so both go through identical port-in + broadcast
 * semantics. Repo URLs are resolved per unique project cwd (memoized) so the
 * ledger's per-source `repo_url` is captured at port-in without a rescan. */
async function performScan(
  options: { provider?: string } | undefined,
  emit: (progress: ScanProgress) => void
): Promise<ScanMetadata> {
  if (!ledger) throw new Error('ledger not initialised')
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
    await ledger!.portIn({ ...delta, repoUrl })
  }
  return runScan(
    { range, provider: options?.provider },
    emit,
    { isAborted: () => abortRequested },
    // Ledger port-in seam (ADR 0002): every settled session file is streamed
    // to the ledger while the parse runs. The scan's delta wrapper already
    // gates out failed parses; `unchanged` is a no-op inside portIn.
    portIn
  )
}

/** Tells every window a background scan attempt has ended without new data
 * (the scan failed silently). Distinct from `store:changed`: it carries no
 * report id and isn't an error the user is shown, but the renderer still
 * needs it to clear its non-blocking progress indicator, or it would stay
 * stuck on after a background scan that broadcast progress and then failed. */
function broadcastIdle(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('scan:idle')
  }
}

/** Fires on the configured cadence (ADR 0004). Silent on failure — the
 * user's last-known data stays visible (stale-while-revalidate) and they can
 * still trigger a manual scan via ⌘R; background scans don't surface errors
 * as intrusively as a user-initiated one would. Coalesces with any
 * already-running scan rather than overlapping it. */
async function triggerBackgroundScan(): Promise<void> {
  if (!ledger || scanActive) return
  scanActive = true
  abortRequested = false
  try {
    const metadata = await performScan(undefined, progress => broadcastProgress(progress))
    broadcastChanged(metadata)
  } catch {
    // background scans fail silently; manual ⌘R remains available
    broadcastIdle()
  } finally {
    scanActive = false
  }
}

/** Background-scan progress goes to every window too (ADR 0004's
 * non-blocking progress indicator applies regardless of which window, if
 * any, is focused when the cadence timer fires). */
function broadcastProgress(progress: ScanProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('scan:progress', progress)
  }
}

/** (Re)schedules the background-scan timer from the persisted cadence
 * setting. Called at startup and whenever the cadence config changes. */
function scheduleCadence(): void {
  if (cadenceTimer) {
    clearInterval(cadenceTimer)
    cadenceTimer = null
  }
  if (!ledger) return
  const ms = resolveCadenceMs(ledger.getRefreshCadence())
  if (ms === null) return // Manual: no background timer
  // The FX background job rides the same repurposed cadence as the scan
  // trigger (ADR 0009): each tick also refreshes the selected currency's
  // rate when it is missing or older than 24h. refreshFxRate never throws,
  // so a Frankfurter outage can never disturb the scan itself.
  cadenceTimer = setInterval(() => {
    void refreshFxOnCadence()
    void triggerBackgroundScan()
  }, ms)
}

function registerIpc(): void {
  ipcMain.handle('scan:start', async (event, options?: { provider?: string }) => {
    if (!ledger) throw new Error('ledger not initialised')
    // A scan is already in flight (background cadence or a concurrent call).
    // This is NOT a failure: its progress and store:changed events will land
    // on their own, so the renderer must not surface an error box or a retry
    // button for it — hence the explicit flag instead of an error string.
    if (scanActive) return { ok: false, alreadyRunning: true }
    scanActive = true
    abortRequested = false
    const win = BrowserWindow.fromWebContents(event.sender)
    const emit = (progress: ScanProgress): void => {
      if (win && !win.isDestroyed()) win.webContents.send('scan:progress', progress)
    }
    const fail = (message: string): void => {
      if (win && !win.isDestroyed()) win.webContents.send('scan:error', message)
    }
    try {
      const metadata = await performScan(options, emit)
      broadcastChanged(metadata)
      // The `metadata` lands on `store:changed` (broadcastChanged above); the
      // scan-result envelope itself carries only the flags scanResultSchema
      // declares, so the wire stays byte-faithful to the shared schema.
      return { ok: true }
    } catch (err) {
      fail(err instanceof ScanAbortedError ? 'scan aborted' : err instanceof Error ? err.message : String(err))
      return { ok: false, aborted: err instanceof ScanAbortedError, error: err instanceof Error ? err.message : String(err) }
    } finally {
      scanActive = false
    }
  })

  ipcMain.on('scan:abort', () => {
    abortRequested = true
  })

  ipcMain.handle('cadence:get', () => {
    if (!ledger) throw new Error('ledger not initialised')
    return ledger.getRefreshCadence()
  })

  ipcMain.handle('cadence:set', (_event, value: string) => {
    if (!ledger) throw new Error('ledger not initialised')
    ledger.setRefreshCadence(value)
    scheduleCadence()
    return ledger.getRefreshCadence()
  })

  /** Scan status (ADR 0004): the most recent completed scan's metadata,
   * or a "never scanned" sentinel when the ledger has no rows at all — the
   * same shape the renderer's boot reads, then lives off `store:changed`. The
   * `reportId` world is gone. */
  ipcMain.handle('store:status', (): { scanned: boolean; metadata?: ScanMetadata } => {
    if (!ledger) throw new Error('ledger not initialised')
    const hasRows = ledger.getSources().length > 0
    return {
      scanned: hasRows || lastScanMetadata !== null,
      ...(lastScanMetadata ? { metadata: lastScanMetadata } : {}),
    }
  })

  ipcMain.handle('store:views', (): DashboardViews | null => {
    if (!ledger) throw new Error('ledger not initialised')
    return buildDashboardViewsFromLedger(ledger)
  })

  ipcMain.handle('store:projects', () => {
    if (!ledger) throw new Error('ledger not initialised')
    return buildProjectRowsFromLedger(ledger)
  })

  ipcMain.handle('store:sessions', (_event, filter?: { project?: string; since?: string; until?: string }) => {
    if (!ledger) throw new Error('ledger not initialised')
    return querySessionRowsFromLedger(ledger, filter ?? {})
  })

  ipcMain.handle('sessions:view', (_event, scope: OverviewScope): SessionRow[] => {
    if (!ledger) throw new Error('ledger not initialised')
    return buildSessionsViewFromLedger(ledger, scope)
  })

  ipcMain.handle('pullRequests:view', (_event, scope: OverviewScope): PullRequestsPayload | null => {
    if (!ledger) throw new Error('ledger not initialised')
    return buildPullRequestsViewFromLedger(ledger, scope)
  })

  ipcMain.handle('spend:view', (_event, scope: OverviewScope): SpendPayload | null => {
    if (!ledger) throw new Error('ledger not initialised')
    return buildSpendViewFromLedger(ledger, scope)
  })

  /** The Models section's scoped payload (ADR 0008): by-model / by-task /
   * audit lenses. Built at read time from the ledger plus the CURRENT
   * alias/price-override config tables, so a quick-add write updates the
   * affected rows on the next query without a rescan. */
  ipcMain.handle('models:view', (_event, scope: OverviewScope): ModelsPayload | null => {
    if (!ledger) throw new Error('ledger not initialised')
    return buildModelsViewFromLedger(ledger, scope, {
      aliases: ledger.getModelAliases(),
      overrides: ledger.getPriceOverrides(),
    })
  })

  /** The Compare section's scoped payload (ADR 0008): a model-pair picker
   * over every detected model, plus a query-time side-by-side metrics card,
   * per-category one-shot bars, and a working-style card. The section honors
   * the selected custom date range like every other section. */
  ipcMain.handle('compare:view', (_event, scope: OverviewScope, pair?: ComparePair): ComparePayload | null => {
    if (!ledger) throw new Error('ledger not initialised')
    return buildCompareViewFromLedger(ledger, scope, pair)
  })

  /** The Optimize section's scoped payload (ADR 0008): a read-only setup-health
   * grade plus Waste/Fixes findings from the 16 ported detectors. Unlike the
   * other sections this is async (ghost detectors walk ~/.claude on disk). */
  ipcMain.handle('optimize:view', async (_event, scope: OverviewScope): Promise<OptimizePayload | null> => {
    if (!ledger) throw new Error('ledger not initialised')
    return await buildOptimizeViewFromLedger(ledger, scope)
  })

  /** The Skills section's detection payload (ticket 24): pure local mining
   * of skill/bash/tool seams plus the on-disk inventory — no consent, no
   * network. Thresholds (frequency × spread) are renderer settings passed
   * per request; defaults (5 × 2) apply when absent. */
  ipcMain.handle('skills:view', async (_event, scope: OverviewScope, thresholds?: SkillsThresholds): Promise<SkillsPayload | null> => {
    if (!ledger) throw new Error('ledger not initialised')
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
    )
  })

  /** Skills › Save (ticket 25): the ONLY write the draft board can do, and it
   * is user-initiated — the OS save dialog IS the user's confirmation, and no
   * path is ever written without it. Defaults to `.agents/skills/` in home. */
  ipcMain.handle('skills:save', async (_event, request: unknown): Promise<SkillsSaveResult> => {
    const parsed = skillsSaveRequestSchema.safeParse(request)
    if (!parsed.success) return { ok: false, error: 'invalid save request' }
    const defaultPath = join(homedir(), '.agents', 'skills', slugifyCandidateName(parsed.data.name), 'SKILL.md')
    const picked = await dialog.showSaveDialog({
      title: 'Save skill',
      defaultPath,
      filters: [{ name: 'SKILL.md', extensions: ['md'] }],
    })
    if (picked.canceled || !picked.filePath) return { ok: false, error: 'cancelled' }
    try {
      // The dialog confirmed the target — create its parent dir so the write
      // succeeds even when the nested .agents/skills/<slug>/ is brand new.
      mkdirSync(dirname(picked.filePath), { recursive: true })
      await writeFile(picked.filePath, parsed.data.content, 'utf8')
      return { ok: true, path: picked.filePath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** The Optimize section's Reverts/Abandoned payload (ADR 0008): yield
   * computed query-time from live git calls on each project's repo, only
   * fetched when that tab is actually viewed — never persisted at scan time.
   * All git failures degrade to empty, so a missing/non-git repo simply shows
   * nothing rather than erroring the section. */
  ipcMain.handle('optimize:yield', async (_event, scope: OverviewScope): Promise<YieldPayload | null> => {
    if (!ledger) throw new Error('ledger not initialised')
    return await buildYieldViewFromLedger(ledger, scope)
  })

  /** Quick-add alias (ADR 0010): map an unpriced model to a priced one,
   * writing directly to the ledger's `model_alias` config table and
   * broadcasting `config:changed` so the mounted view refetches (query-time
   * config — no rescan). */
  ipcMain.handle('models:addAlias', (_event, model: string, aliasOf: string): { ok: true } => {
    if (!ledger) throw new Error('ledger not initialised')
    if (typeof model !== 'string' || !model.trim() || typeof aliasOf !== 'string' || !aliasOf.trim()) {
      throw new Error('model and alias target must be non-empty strings')
    }
    ledger.setModelAlias(model.trim(), aliasOf.trim())
    broadcastConfigChanged()
    return { ok: true }
  })

  /** Read the current model-alias config (Settings › Model aliases CRUD). */
  ipcMain.handle('models:getAliases', (): Array<{ model: string; aliasOf: string }> => {
    if (!ledger) throw new Error('ledger not initialised')
    return ledger.getModelAliases()
  })

  /** Remove a model alias (Settings › Model aliases CRUD). */
  ipcMain.handle('models:removeAlias', (_event, model: string): { ok: true } => {
    if (!ledger) throw new Error('ledger not initialised')
    if (typeof model !== 'string' || !model.trim()) {
      throw new Error('model must be a non-empty string')
    }
    ledger.removeModelAlias(model.trim())
    broadcastConfigChanged()
    return { ok: true }
  })

  /** Read the current price-override config (Settings › Pricing CRUD). */
  ipcMain.handle('models:getPriceOverrides', (): Array<{
    model: string; inputPricePerMillion: number; outputPricePerMillion: number
  }> => {
    if (!ledger) throw new Error('ledger not initialised')
    return ledger.getPriceOverrides()
  })

  /** Remove a price override (Settings › Pricing CRUD): a pure config delete —
   * display cost reverts to the stored base on the next query (query-time
   * pricing), no row updates, no rescan. */
  ipcMain.handle('models:removePriceOverride', (_event, model: string): { ok: true } => {
    if (!ledger) throw new Error('ledger not initialised')
    if (typeof model !== 'string' || !model.trim()) {
      throw new Error('model must be a non-empty string')
    }
    ledger.removePriceOverride(model.trim())
    broadcastConfigChanged()
    return { ok: true }
  })

  /** Quick-add price override (ADR 0010): a manual price (USD per 1M tokens)
   * for a model, a pure upsert on the ledger's `price_override` config table
   * (display cost recomputes on read) plus a `config:changed` broadcast. */
  ipcMain.handle('models:setPrice', (_event, model: string, inputPricePerMillion: number, outputPricePerMillion: number): { ok: true } => {
    if (!ledger) throw new Error('ledger not initialised')
    if (typeof model !== 'string' || !model.trim()) {
      throw new Error('model must be a non-empty string')
    }
    if (!Number.isFinite(inputPricePerMillion) || inputPricePerMillion < 0
      || !Number.isFinite(outputPricePerMillion) || outputPricePerMillion < 0) {
      throw new Error('prices must be non-negative numbers')
    }
    ledger.setPriceOverride(model.trim(), { inputPricePerMillion, outputPricePerMillion })
    broadcastConfigChanged()
    return { ok: true }
  })

  /** Open a PR in the default browser. Only http(s) URLs are allowed — a
   * malformed or non-web URL is refused so a crafted label can never drive the
   * shell into an arbitrary protocol handler. */
  ipcMain.handle('open-external', (_event, url: string) => {
    try {
      const { protocol } = new URL(url)
      if (protocol === 'https:' || protocol === 'http:') return shell.openExternal(url)
    } catch { /* malformed URL — refuse to open */ }
    return undefined
  })

  /** Open the macOS Full Disk Access pane (ADR 0015). The generic
   * `open-external` channel refuses non-http(s) schemes, so the TCC pane's
   * `x-apple.systempreferences:` URL gets its own narrow handler — a no-op
   * anywhere that isn't macOS. */
  ipcMain.handle('open-fda-settings', (): boolean => {
    if (process.platform !== 'darwin') return false
    // Best-effort like `open-external`: a refused URL must never surface as
    // an unhandled rejection.
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles').catch(() => {})
    return true
  })

  ipcMain.handle('store:session', (_event, sessionId: string) => {
    if (!ledger) throw new Error('ledger not initialised')
    return getSessionDetailFromLedger(ledger, sessionId)
  })

  ipcMain.handle('store:analytics', () => {
    if (!ledger) throw new Error('ledger not initialised')
    return buildAnalyticalViewsFromLedger(ledger)
  })

  ipcMain.handle('overview:query', (_event, scope: OverviewScope): OverviewPayload | null => {
    if (!ledger) throw new Error('ledger not initialised')
    return buildOverviewFromLedger(ledger, scope)
  })

  ipcMain.handle('store:search', (_event, query: string) => {
    if (!ledger) throw new Error('ledger not initialised')
    return searchSessionsFromLedger(ledger, query)
  })

  ipcMain.handle('settings:info', async () => {
    // The Claude-config row in General is nullable: when the config dirs cannot
    // be resolved we omit the field entirely so the renderer just hides the row.
    let claudeConfigDirs: string[] | undefined
    try { claudeConfigDirs = await getClaudeConfigDirs() } catch { /* absent */ }
    return { ...userDataPaths(), claudeConfigDirs }
  })

  ipcMain.handle('settings:clear', async () => {
    if (!ledger) throw new Error('ledger not initialised')
    ledger.clear()
    lastScanMetadata = null
    let claudeConfigDirs: string[] | undefined
    try { claudeConfigDirs = await getClaudeConfigDirs() } catch { /* absent */ }
    return { ...userDataPaths(), claudeConfigDirs }
  })

  ipcMain.handle('pricing:refresh', async () => {
    try {
      await refreshPricingNow()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** The About area's version (ADR 0012): `app.getVersion()` reads it from
   * package.json, which electron-builder also stamps into the packaged app. */
  ipcMain.handle('app:version', () => app.getVersion())

  /** Manual "Check for updates" (ADR 0012): forces one fresh read of the
   * the Watchtower repo's GitHub Releases feed and reports whether a newer desktop
   * version exists. Never downloads or installs, and there is no background
   * schedule — this fires only when the user clicks the button. All failures
   * (offline, private repo, timeout) degrade to an informational "unable to
   * check" status rather than an error. */
  ipcMain.handle('updates:check', async (): Promise<UpdateStatus> => {
    if (!updateChecker) throw new Error('update checker not initialised')
    return updateChecker.check()
  })

  /** The active display currency (ADR 0009): the persisted code plus its
   * CACHED rate from the FX side-table. The renderer never calls Frankfurter
   * directly — this is its only read path, and it degrades to the last
   * cached rate (or USD) without ever touching the network. */
  ipcMain.handle('currency:get', (): ActiveCurrency => {
    if (!ledger) throw new Error('ledger not initialised')
    return getActiveCurrency(ledger)
  })

  /** Select a display currency (ADR 0009): persists the choice, kicks off a
   * non-blocking Frankfurter refresh in the background when the cached rate
   * is missing/stale, and returns the current state immediately — the app
   * keeps working on the last cached rate (or USD) while the fetch runs.
   * When the fetch lands, `currency:changed` is broadcast so every window
   * re-reads the fresh rate (this is also why the renderer never needs to
   * call Frankfurter itself). */
  ipcMain.handle('currency:set', (_event, code: string): ActiveCurrency => {
    if (!ledger) throw new Error('ledger not initialised')
    if (typeof code !== 'string' || !isValidCurrencyCode(code)) {
      throw new Error('invalid ISO 4217 currency code')
    }
    ledger.setDisplayCurrency(code)
    void refreshFxRate(ledger, code).then(broadcastCurrencyChanged)
    return getActiveCurrency(ledger)
  })

  /** The full ISO 4217 currency list (162 codes) for the Settings selector. */
  ipcMain.handle('currency:list', (): CurrencyOption[] => {
    return listCurrencies()
  })

  /** CSV/JSON export in the selected display currency (ADR 0009 seam for
   * ADR 0013's Export pane). The main process shows a folder picker when no
   * destination is supplied. Reads the FULL ledger history through the
   * aggregation layer (ADR 0013): the gate is "ledger has any rows",
   * and there is no date-range filter — exports cover full history. Cost
   * figures stay USD-anchored in the ledger; conversion is applied only to
   * the files produced here. */
  async function runExport(kind: 'csv' | 'json', destination?: string): Promise<ExportResult> {
    if (!ledger) throw new Error('ledger not initialised')
    const projects = buildProjectsFromLedger(ledger)
    if (projects.length === 0) {
      return { ok: false, error: 'no data to export yet — scan first' }
    }
    let target = destination
    if (!target) {
      if (kind === 'csv') {
        const picked = await dialog.showOpenDialog({
          title: 'Choose an export folder',
          properties: ['openDirectory', 'createDirectory'],
          buttonLabel: 'Export'
        })
        if (picked.canceled || picked.filePaths.length === 0) return { ok: false, error: 'cancelled' }
        target = picked.filePaths[0]
      } else {
        const picked = await dialog.showSaveDialog({
          title: 'Export JSON',
          defaultPath: 'watchtower-export.json',
          filters: [{ name: 'JSON', extensions: ['json'] }]
        })
        if (picked.canceled || !picked.filePath) return { ok: false, error: 'cancelled' }
        target = picked.filePath
      }
    }
    try {
      const path = kind === 'csv'
        ? await exportCsv(projects, target, ledger)
        : await exportJson(projects, target, ledger)
      return { ok: true, path }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  ipcMain.handle('export:csv', (_event, destination?: string): Promise<ExportResult> => runExport('csv', destination))
  ipcMain.handle('export:json', (_event, destination?: string): Promise<ExportResult> => runExport('json', destination))

  // Coach + Skills agent chain (tickets 21–25): the HarnessRuntime seam's IPC
  // surface — harness listing, run ack/stream/cancel, the not-a-skill
  // dismissal store, and draft prose. The runner is lazy: the AI SDK loads on
  // the first harness-touching call, never at boot. Runs are user-initiated
  // from the unified Coach & Skills surface (ADR 0017); dismissals are a
  // ledger config table so they survive clear().
  agentsCleanup = registerAgentsIpc({
    dismissals: {
      // The skills:view read goes straight to the ledger above; this source
      // carries only the write (ticket 25).
      dismiss: (source, name, reason) => ledger?.dismissSkill(source, name, reason),
    },
    // The app root: bundled ACP servers (codex) resolve from its node_modules.
    appPath: app.getAppPath(),
    // The in-app ledger MCP server (map 53): the harness agent spawns the app
    // itself as plain node (ELECTRON_RUN_AS_NODE=1) and reads the current UI
    // scope's data read-only. Paths: `process.execPath` (dev + packaged), the
    // bundled entry under appPath, and the ledger DB beside the cache.
    ledgerMcpServer: scope => {
      // Fresh install: no ledger.db yet → no data to serve, so no MCP server
      // (its read-only open would throw on a missing file). Once the first
      // scan lands, the next run injects it.
      const dbPath = join(app.getPath('userData'), 'ledger.db')
      if (!existsSync(dbPath)) return null
      return buildLedgerMcpServer({
        execPath: process.execPath,
        entryPath: join(app.getAppPath(), 'out/main/ledger-mcp.js'),
        dbPath,
      }, scope)
    },
  })
}

function createWindow(): void {
  // Dev/standalone windows get the generated brand icon (ADR 0015); packaged
  // builds carry it in the exe/dmg/AppImage, and build/ isn't shipped (files:
  // out/**), so this resolves to no icon at runtime.
  const devIcon = join(__dirname, '../../build/icon.png')
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    autoHideMenuBar: true,
    ...(existsSync(devIcon) ? { icon: devIcon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  process.env['WATCHTOWER_CACHE_DIR'] = join(app.getPath('userData'), 'cache')
  ledger = new LedgerStore(join(app.getPath('userData'), 'ledger.db'))
  updateChecker = createUpdateChecker({ currentVersion: app.getVersion() })
  registerIpc()
  createWindow()
  scheduleCadence()
  // Prime the FX side-table for the persisted display currency at startup,
  // non-blocking: the renderer reads the cached rate (or USD) meanwhile, and
  // a broadcast lands the fresh rate if the cache was stale.
  void refreshFxOnCadence()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Tear down the coach conversation's temp workspace (map 53) so a reset or a
// quit never leaks a scratch directory under the OS temp root.
app.on('before-quit', () => {
  agentsCleanup?.reset()
})
