import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'

import * as Schema from 'effect/Schema'
import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

import { slugifyCandidateName } from '../shared/lib/skills-draft.js'
import type { ComparePair } from '../shared/schemas/compare.js'
import type { ExportResult } from '../shared/schemas/export.js'
import { rendererNoticeSchema } from '../shared/schemas/ipc.js'
import {
  type LedgerMcpConnection,
  type LedgerMcpStartupMode,
  ledgerMcpStartupModeSchema,
  type LedgerMcpStatus,
} from '../shared/schemas/ledger-mcp.js'
import type { OverviewScope } from '../shared/schemas/overview.js'
import { skillsSaveRequestSchema, type SkillsSaveResult, type SkillsThresholds } from '../shared/schemas/skills.js'
import type { AcpMcpServer } from './agents/harnesses/types.js'
import { type LedgerMcpAttachment, registerAgentsIpc } from './agents/ipc.js'
import { buildLedgerMcpServer, ledgerMcpTransportFor } from './agents/ledger-mcp/config.js'
import { createSidecarPool } from './agents/ledger-mcp/pool.js'
import { startLedgerMcpHttp } from './agents/ledger-mcp/sidecar.js'
import { DbWorkerClient } from './db-worker/client.js'
import { initAppPaths } from './env.js'
import { makeMainRuntime } from './main-runtime.js'
import {
  closeOperationalLog,
  initOperationalLog,
  logCodeFor,
  logIpcError,
  safeLogOperationalEvent,
} from './operational-log.js'
import { createUpdateCheckerEffect, type UpdateCheckerEffect, type UpdateStatus } from './updates.js'

/**
 * Main process (ADR 0023): windows, dialogs, IPC plumbing, updates, and the
 * harness-agent surface. All data work — the ledger, the scan pipeline, and
 * every query-time view builder — lives on the db-worker thread behind
 * `DbWorkerClient`, so a scan or a heavy aggregation can never freeze the
 * main event loop (and with it every window). The renderer wire contract is
 * unchanged: same channels, same payloads.
 */

let updateChecker: UpdateCheckerEffect | null = null
/** Coach temp-workspace teardown (map 53): registered at IPC wiring, run on quit. */
let agentsCleanup: { reset: () => Promise<void>; dispose: () => Promise<void> } | null = null
/** The data-plane handle, set once the worker is spawned (quit path). */
let dbClient: DbWorkerClient | null = null
const mainRuntime = makeMainRuntime({
  clientVersion: app.getVersion(),
  appPath: app.getAppPath(),
  onHarnessChange: rows => broadcast('coach:harnesses-changed', rows),
})
/** App-level loopback-HTTP ledger sidecar: shared by Copilot, local external
 * MCP clients, and any future harness that rejects stdio. It remains lazy by
 * default and is prewarmed after the data worker is ready when the persisted
 * startup setting requests it. */
const sidecarPool = createSidecarPool({ spawn: ctx => startLedgerMcpHttp(ctx) })
/** The requesting window of the in-flight manual scan (progress/error routing). */
let scanRequester: WebContents | null = null

function broadcast(channel: string, data?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, data)
  }
}

/** Single IPC failure seam: operation name + short code only, never args. */
function handleLogged<T extends unknown[]>(
  channel: string,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: T) => unknown,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await listener(event, ...(args as T))
    } catch (err) {
      logIpcError(channel, err)
      throw err
    }
  })
}

function ledgerMcpContext(): { execPath: string; entryPath: string; dbPath: string } {
  return {
    execPath: process.execPath,
    entryPath: join(app.getAppPath(), 'out/main/ledger-mcp.js'),
    dbPath: join(app.getPath('userData'), 'ledger.db'),
  }
}

function ledgerMcpConnection(server: AcpMcpServer): LedgerMcpConnection {
  if (!('url' in server) || !('headers' in server)) throw new Error('ledger MCP sidecar is not using HTTP')
  const headers = Object.fromEntries(server.headers.map(header => [header.name, header.value]))
  return {
    url: server.url,
    config: JSON.stringify(
      {
        mcpServers: {
          [server.name]: { type: 'http', url: server.url, headers },
        },
      },
      null,
      2,
    ),
  }
}

async function ledgerMcpStatus(db: DbWorkerClient): Promise<LedgerMcpStatus> {
  const startupMode = (await db.request('ledger-mcp:startup:get')) as LedgerMcpStartupMode
  const server = await sidecarPool.status()
  return { startupMode, running: server !== null, url: server && 'url' in server ? server.url : null }
}

/** Relays db-worker broadcasts to windows. Manual-scan lifecycle events go to
 * the requesting window only (today's ⌘R semantics); everything else fans out
 * to every window. */
function relayWorkerEvents(db: DbWorkerClient): void {
  db.onEvent(event => {
    // Boot handshake (`ready` / `init-error`) is consumed by the client
    // itself — never relayed to windows.
    if (event.event === 'ready' || event.event === 'init-error') return
    switch (event.event) {
      case 'scan:progress':
        if (event.manual) {
          if (scanRequester && !scanRequester.isDestroyed()) scanRequester.send('scan:progress', event.progress)
        } else {
          broadcast('scan:progress', event.progress)
        }
        break
      case 'scan:error':
        if (scanRequester && !scanRequester.isDestroyed()) scanRequester.send('scan:error', event.message)
        break
      case 'store:changed':
        broadcast('store:changed', event.metadata)
        break
      case 'scan:idle':
        broadcast('scan:idle')
        break
      case 'config:changed':
        broadcast('config:changed')
        break
      case 'currency:changed':
        broadcast('currency:changed', event.currency)
        break
      case 'oplog':
        // Worker Operational-log forward (#128): filed via the shared seam
        // with the worker context — never relayed to windows.
        safeLogOperationalEvent(event.level, event.logEvent, event.fields, 'worker')
        break
    }
  })
}

function registerIpc(db: DbWorkerClient): void {
  /** Renderer tripwire forward (#130): a dropped subscription payload lands
   * here with its label + location only — never contents. Schema-validated and
   * length-capped at the schema; a malformed notice is itself an IPC error. */
  handleLogged('log:notice', (notice: unknown): { ok: true } => {
    const parsed = Schema.decodeUnknownResult(rendererNoticeSchema)(notice)
    if (parsed._tag === 'Failure') throw new Error('invalid renderer notice')
    safeLogOperationalEvent(
      'warn',
      'renderer.notice',
      { label: parsed.success.label, location: parsed.success.location },
      'renderer',
    )
    return { ok: true }
  })

  handleLogged('scan:start', async (event, options?: { provider?: string }) => {
    // First-come-wins: a concurrent second caller gets `alreadyRunning` from
    // the worker, so stealing the slot would misroute the live scan's
    // progress to a window that never started it. A dead slot is free again
    // (its window closed mid-scan while another one is still waiting).
    if (!scanRequester || scanRequester.isDestroyed()) scanRequester = event.sender
    try {
      return await db.request('scan:start', options)
    } finally {
      if (scanRequester === event.sender) scanRequester = null
    }
  })

  ipcMain.on('scan:abort', () => {
    // Fire-and-forget like the renderer's send: a dead worker must never turn
    // an abort into an unhandled rejection here.
    void db.request('scan:abort').catch(() => {})
  })

  handleLogged('cadence:get', () => db.request('cadence:get'))

  handleLogged('cadence:set', (_event, value: string) => db.request('cadence:set', value))

  handleLogged('store:status', () => db.request('store:status'))

  handleLogged('store:views', () => db.request('store:views'))

  handleLogged('store:projects', () => db.request('store:projects'))

  handleLogged('store:sessions', (_event, filter?: { project?: string; since?: string; until?: string }) =>
    db.request('store:sessions', filter),
  )

  handleLogged('sessions:view', (_event, scope: OverviewScope) => db.request('sessions:view', scope))

  handleLogged('pullRequests:view', (_event, scope: OverviewScope) => db.request('pullRequests:view', scope))

  handleLogged('spend:view', (_event, scope: OverviewScope) => db.request('spend:view', scope))

  handleLogged('models:view', (_event, scope: OverviewScope) => db.request('models:view', scope))

  handleLogged('compare:view', (_event, scope: OverviewScope, pair?: ComparePair) =>
    db.request('compare:view', scope, pair),
  )

  handleLogged('optimize:view', (_event, scope: OverviewScope) => db.request('optimize:view', scope))

  /** The Skills section's detection payload (ticket 24): pure local mining
   * of skill/bash/tool seams plus the on-disk inventory — no consent, no
   * network. Thresholds (frequency × spread) are renderer settings passed
   * per request; defaults (5 × 2) apply when absent. */
  handleLogged('skills:view', (_event, scope: OverviewScope, thresholds?: SkillsThresholds) =>
    db.request('skills:view', scope, thresholds),
  )

  /** Skills › Save (ticket 25): the ONLY write the draft board can do, and it
   * is user-initiated — the OS save dialog IS the user's confirmation, and no
   * path is ever written without it. Defaults to `.agents/skills/` in home. */
  handleLogged('skills:save', async (_event, request: unknown): Promise<SkillsSaveResult> => {
    const parsed = Schema.decodeUnknownResult(skillsSaveRequestSchema)(request)
    if (parsed._tag === 'Failure') return { ok: false, error: 'invalid save request' }
    const defaultPath = join(homedir(), '.agents', 'skills', slugifyCandidateName(parsed.success.name), 'SKILL.md')
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
      await writeFile(picked.filePath, parsed.success.content, 'utf8')
      return { ok: true, path: picked.filePath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  handleLogged('optimize:yield', (_event, scope: OverviewScope) => db.request('optimize:yield', scope))

  handleLogged('models:addAlias', (_event, model: string, aliasOf: string) =>
    db.request('models:addAlias', model, aliasOf),
  )

  handleLogged('models:getAliases', () => db.request('models:getAliases'))

  handleLogged('models:removeAlias', (_event, model: string) => db.request('models:removeAlias', model))

  handleLogged('models:getPriceOverrides', () => db.request('models:getPriceOverrides'))

  handleLogged('models:removePriceOverride', (_event, model: string) => db.request('models:removePriceOverride', model))

  handleLogged(
    'models:setPrice',
    (_event, model: string, inputPricePerMillion: number, outputPricePerMillion: number) =>
      db.request('models:setPrice', model, inputPricePerMillion, outputPricePerMillion),
  )

  /** Open a PR in the default browser. Only http(s) URLs are allowed — a
   * malformed or non-web URL is refused so a crafted label can never drive the
   * shell into an arbitrary protocol handler. */
  handleLogged('open-external', (_event, url: string) => {
    try {
      const { protocol } = new URL(url)
      if (protocol === 'https:' || protocol === 'http:') return shell.openExternal(url)
    } catch {
      /* malformed URL — refuse to open */
    }
    return undefined
  })

  /** Open the macOS Full Disk Access pane (ADR 0015). The generic
   * `open-external` channel refuses non-http(s) schemes, so the TCC pane's
   * `x-apple.systempreferences:` URL gets its own narrow handler — a no-op
   * anywhere that isn't macOS. */
  handleLogged('open-fda-settings', (): boolean => {
    if (process.platform !== 'darwin') return false
    // Best-effort like `open-external`: a refused URL must never surface as
    // an unhandled rejection.
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles').catch(() => {})
    return true
  })

  handleLogged('store:session', (_event, sessionId: string) => db.request('store:session', sessionId))

  handleLogged('store:analytics', () => db.request('store:analytics'))

  handleLogged('overview:query', (_event, scope: OverviewScope) => db.request('overview:query', scope))

  handleLogged('store:search', (_event, query: string) => db.request('store:search', query))

  handleLogged('settings:info', () => db.request('settings:info'))

  handleLogged('settings:clear', () => db.request('settings:clear'))

  handleLogged('ledger-mcp:status', () => ledgerMcpStatus(db))

  handleLogged('ledger-mcp:startup:set', async (_event, value: unknown): Promise<LedgerMcpStatus> => {
    const parsed = Schema.decodeUnknownResult(ledgerMcpStartupModeSchema)(value)
    if (parsed._tag === 'Failure') throw new Error('invalid ledger MCP startup mode')
    const startupMode = (await db.request('ledger-mcp:startup:set', parsed.success)) as LedgerMcpStartupMode
    if (startupMode === 'at-launch') {
      // Starting is best-effort: a broken bundle or unavailable DB leaves the
      // Coach able to run without grounding tools.
      await sidecarPool.connection(ledgerMcpContext())
    }
    return ledgerMcpStatus(db)
  })

  handleLogged('ledger-mcp:connection', async (): Promise<LedgerMcpConnection> => {
    await db.ready
    const server = await sidecarPool.connection(ledgerMcpContext())
    if (!server) throw new Error('ledger MCP server is unavailable')
    return ledgerMcpConnection(server)
  })

  handleLogged('ledger-mcp:token:regenerate', async (): Promise<LedgerMcpStatus> => {
    await db.ready
    await sidecarPool.regenerate(ledgerMcpContext())
    return ledgerMcpStatus(db)
  })

  handleLogged('pricing:refresh', () => db.request('pricing:refresh'))

  /** The About area's version (ADR 0012): `app.getVersion()` reads it from
   * package.json, which electron-builder also stamps into the packaged app. */
  handleLogged('app:version', () => app.getVersion())

  /** Manual "Check for updates" (ADR 0012): forces one fresh read of the
   * the Watchtower repo's GitHub Releases feed and reports whether a newer desktop
   * version exists. Never downloads or installs, and there is no background
   * schedule — this fires only when the user clicks the button. All failures
   * (offline, private repo, timeout) degrade to an informational "unable to
   * check" status rather than an error. */
  handleLogged('updates:check', async (): Promise<UpdateStatus> => {
    if (!updateChecker) throw new Error('update checker not initialised')
    return mainRuntime.runPromise(updateChecker.check())
  })

  handleLogged('currency:get', () => db.request('currency:get'))

  handleLogged('currency:set', (_event, code: string) => db.request('currency:set', code))

  /** The full ISO 4217 currency list (162 codes) for the Settings selector. */
  handleLogged('currency:list', () => db.request('currency:list'))

  /** CSV/JSON export in the selected display currency. The main process shows
   * a folder picker when no destination is supplied; the worker computes and
   * writes the files (it owns the ledger the export reads). */
  async function runExport(kind: 'csv' | 'json', destination?: string): Promise<ExportResult> {
    let target = destination
    if (!target) {
      if (kind === 'csv') {
        const picked = await dialog.showOpenDialog({
          title: 'Choose an export folder',
          properties: ['openDirectory', 'createDirectory'],
          buttonLabel: 'Export',
        })
        if (picked.canceled || picked.filePaths.length === 0) return { ok: false, error: 'cancelled' }
        target = picked.filePaths[0]
      } else {
        const picked = await dialog.showSaveDialog({
          title: 'Export JSON',
          defaultPath: 'watchtower-export.json',
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })
        if (picked.canceled || !picked.filePath) return { ok: false, error: 'cancelled' }
        target = picked.filePath
      }
    }
    return (await db.request(`export:${kind}`, target)) as ExportResult
  }

  handleLogged('export:csv', (_event, destination?: string): Promise<ExportResult> => runExport('csv', destination))
  handleLogged('export:json', (_event, destination?: string): Promise<ExportResult> => runExport('json', destination))

  // Coach + Skills agent chain (tickets 21–25): the HarnessRuntime seam's IPC
  // surface — harness listing, run ack/stream/cancel, the not-a-skill
  // dismissal store, and draft prose. The runner is lazy: the AI SDK loads on
  // the first harness-touching call, never at boot. Runs are user-initiated
  // from the unified Coach & Skills surface (ADR 0017); dismissals are a
  // ledger config table (written through the worker) so they survive clear().
  agentsCleanup = registerAgentsIpc({
    runtime: mainRuntime,
    dismissals: {
      dismiss: async (source, name, reason) => {
        await db.request('skills:dismiss', { source, name, reason })
      },
    },
    // The in-app ledger MCP server (map 53): the harness agent spawns the app
    // itself as plain node (ELECTRON_RUN_AS_NODE=1) and reads the FULL
    // lifetime ledger read-only — no scope is baked at spawn (the harness
    // filters through each tool's optional `scope` argument). Paths:
    // `process.execPath` (dev + packaged), the bundled entry under appPath,
    // and the ledger DB beside the cache.
    ledgerMcpServer: async (harnessKind: string): Promise<LedgerMcpAttachment | null> => {
      await db.ready
      // Fresh install: no ledger.db yet → no data to serve, so no MCP server
      // (its read-only open would throw on a missing file). Once the first
      // scan lands, the next run injects it.
      const context = ledgerMcpContext()
      const dbPath = context.dbPath
      if (!existsSync(dbPath)) return null
      // Harnesses that reject client-provided stdio servers (Copilot) get
      // the same ledger over the app-level loopback-HTTP sidecar instead. A null
      // (spawn failure, reset raced the spawn) degrades to no-tools (the
      // turn still runs) rather than failing the turn.
      if (ledgerMcpTransportFor(harnessKind) === 'http') {
        try {
          return await sidecarPool.acquire(context)
        } catch {
          return null
        }
      }
      return {
        server: buildLedgerMcpServer(context),
        release: () => {},
      }
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
      sandbox: true,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  const dataDir = app.getPath('userData')
  try {
    await initOperationalLog({ logDir: join(dataDir, 'logs'), isPackaged: app.isPackaged })
  } catch {
    /* logging must never break boot */
  }
  // The data plane boots first: the worker owns the ledger from here on —
  // requests simply queue on its port until its synchronous init finishes.
  const cacheDir = join(dataDir, 'cache')
  // This isolate's own copy of the `AppPaths` startup snapshot, from the same
  // value the worker gets below — so a sync discovery path reached from main
  // resolves the same cache dir as the one reached from the worker. The env
  // override still wins, exactly as it did before the snapshot existed: the
  // snapshot is initialized with the value the reader would have resolved
  // anyway, never with a value that shadows the documented override.
  initAppPaths({ cacheDir: process.env['WATCHTOWER_CACHE_DIR'] ?? cacheDir })
  const db = new DbWorkerClient(
    { dbPath: join(dataDir, 'ledger.db'), dataDir, cacheDir },
    join(__dirname, 'db-worker.js'),
  )
  relayWorkerEvents(db)
  dbClient = db
  // Built through the main runtime (ADR 0032): the checker's HttpFetch
  // dependency is provided there, so the IPC handler just runs check().
  updateChecker = await mainRuntime.runPromise(createUpdateCheckerEffect({ currentVersion: app.getVersion() }))
  registerIpc(db)
  createWindow()

  // Optional app-level prewarm: the persisted setting is read only after the
  // data worker owns the DB, so the sidecar can safely open its read-only
  // connection. A failed prewarm is non-fatal; the next Coach run or an
  // explicit copy-config action can retry on demand.
  void db.ready
    .then(async () => {
      safeLogOperationalEvent('info', 'boot.ready', {})
      safeLogOperationalEvent('info', 'worker.ready', {}, 'worker')
      const startupMode = (await db.request('ledger-mcp:startup:get')) as LedgerMcpStartupMode
      if (startupMode === 'at-launch') {
        await sidecarPool.connection(ledgerMcpContext())
      }
    })
    .catch(err => {
      safeLogOperationalEvent('error', 'boot.error', {
        code: logCodeFor(err, 'prewarm-failed'),
      })
    })

  // The worker queues requests until its synchronous init finishes, so the
  // window can paint immediately. A boot failure (unopenable ledger) cannot
  // heal — surface it once and quit instead of serving IPC errors forever.
  // The worker is never respawned in that case (client policy).
  void db.ready.then(undefined, err => {
    safeLogOperationalEvent('error', 'boot.error', { code: logCodeFor(err, 'boot-failed') })
    safeLogOperationalEvent('error', 'worker.error', { op: 'worker', code: logCodeFor(err, 'boot-failed') }, 'worker')
    dialog.showErrorBox(
      'Watchtower',
      `The local data layer failed to start and the app cannot continue.\n\n${err instanceof Error ? err.message : String(err)}`,
    )
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Wait for the owned resources before allowing Electron to exit. Repeated
// quit requests during cleanup share this shutdown instead of closing early.
let quitState: 'running' | 'closing' | 'closed' = 'running'
app.on('before-quit', event => {
  if (quitState === 'closed') return
  event.preventDefault()
  if (quitState === 'closing') return
  quitState = 'closing'
  sidecarPool.releaseAll()
  const coachShutdown = Promise.resolve()
    .then(() => agentsCleanup?.dispose())
    .finally(() => mainRuntime.dispose())
  void Promise.allSettled([coachShutdown, dbClient?.shutdown()]).then(() => {
    try {
      closeOperationalLog()
    } catch {
      /* best effort */
    }
    quitState = 'closed'
    app.quit()
  })
})
