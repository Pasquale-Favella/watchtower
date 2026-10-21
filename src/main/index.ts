import { homedir } from 'node:os'

import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

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
import type { UpdateStatus } from '../shared/schemas/updates.js'
import type { AcpMcpServer } from './agents/harnesses/types.js'
import { registerAgentsIpc } from './agents/ipc.js'
import { buildLedgerMcpServer, ledgerMcpTransportFor } from './agents/ledger-mcp/config.js'
import { LedgerMcpPool } from './agents/ledger-mcp/pool.js'
import { exportCsvZip as exportCsvZipEffect } from './application/export-csv-zip.js'
import { saveSkill } from './application/save-skill.js'
import { BackgroundShell, type BackgroundShellHandle, backgroundShellLayer } from './background-shell.js'
import { DbWorkerClient } from './db-worker/client.js'
import { acquireElectronUpdates } from './electron-updates.js'
import { initAppPaths, readAppPathsEffect } from './env.js'
import { exportStamp } from './export-zip.js'
import { makeMainRuntime } from './main-runtime.js'
import {
  closeOperationalLog,
  initOperationalLog,
  logCodeFor,
  logIpcError,
  safeLogOperationalEvent,
} from './operational-log.js'
import { createQuitCoordinator } from './quit-coordinator.js'
import { AppUpdates, updatesLayer } from './updates.js'

/**
 * Main process (ADR 0023): windows, dialogs, IPC plumbing, updates, and the
 * harness-agent surface. All data work — the ledger, the scan pipeline, and
 * every query-time view builder — lives on the db-worker thread behind
 * `DbWorkerClient`, so a scan or a heavy aggregation can never freeze the
 * main event loop (and with it every window). The renderer wire contract is
 * unchanged: same channels, same payloads.
 */

/** Coach temp-workspace teardown (map 53): registered at IPC wiring, run on quit. */
let agentsCleanup: { reset: () => Promise<void>; dispose: () => Promise<void> } | null = null
/** The data-plane handle, set once the worker is spawned (quit path). */
let dbClient: DbWorkerClient | null = null
const mainRuntime = makeMainRuntime(
  {
    clientVersion: app.getVersion(),
    appPath: app.getAppPath(),
    onHarnessChange: rows => broadcast('coach:harnesses-changed', rows),
  },
  {},
  Layer.merge(
    backgroundShellLayer({
      preloadPath: join(__dirname, '../preload/index.js'),
      rendererUrl: process.env['ELECTRON_RENDERER_URL'],
      rendererDir: join(__dirname, '../renderer'),
      iconPath: app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(__dirname, '../../build/icon.png'),
      createMainWindow: createWindow,
      requestScan: () => void dbClient?.request('scan:start').catch(() => {}),
    }),
    updatesLayer({
      currentVersion: app.getVersion(),
      source: acquireElectronUpdates({
        isPackaged: app.isPackaged,
        platform: process.platform,
        appPath: app.getAppPath(),
        executablePath: process.execPath,
        appImage: process.env['APPIMAGE'],
        onInstallError: showUpdateInstallError,
      }),
      onChange: status => broadcast('updates:changed', status),
      requestInstall: install => quitCoordinator.requestInstall(install),
    }),
  ),
)
/** App-level loopback-HTTP ledger sidecar: shared by Copilot, local external
 * MCP clients, and any future harness that rejects stdio. It remains lazy by
 * default and is prewarmed after the data worker is ready when the persisted
 * startup setting requests it. */
const sidecarPool = {
  connection: (context: ReturnType<typeof ledgerMcpContext>) =>
    mainRuntime.runPromise(Effect.flatMap(LedgerMcpPool, pool => pool.connection(context))),
  regenerate: (context: ReturnType<typeof ledgerMcpContext>) =>
    mainRuntime.runPromise(Effect.flatMap(LedgerMcpPool, pool => pool.regenerate(context))),
  status: () => mainRuntime.runPromise(Effect.flatMap(LedgerMcpPool, pool => pool.status())),
}
/** Tray + floating orb + hide-on-close (set once the app is ready). */
let backgroundShell: BackgroundShellHandle | null = null

// One Watchtower per profile: with the app living in the tray, launching it
// again must bring the existing window back rather than boot a second ledger
// owner. The e2e suite runs each launch on its own `--user-data-dir`, so its
// instances never contend for this lock.
const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) app.quit()
app.on('second-instance', () => backgroundShell?.showMainWindow())

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

/** Relays db-worker broadcasts to windows. Everything fans out to every
 * window — scan lifecycle included, manual or background: with the orb there
 * are several windows, and a scan one of them starts is the app's scan, so
 * every window must show it (and refetch on the same `store:changed`). */
function relayWorkerEvents(db: DbWorkerClient): void {
  db.onEvent(event => {
    // Boot handshake (`ready` / `init-error`) is consumed by the client
    // itself — never relayed to windows.
    if (event.event === 'ready' || event.event === 'init-error') return
    switch (event.event) {
      case 'scan:progress':
        broadcast('scan:progress', event.progress)
        break
      case 'scan:error':
        broadcast('scan:error', event.message)
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

  handleLogged('scan:start', (_event, options?: { provider?: string }) => db.request('scan:start', options))

  /** Whether a scan is in flight — asked of the worker, which owns the scan
   * (ADR 0023). A window's bootstrap reads it once, then follows the
   * broadcast lifecycle events. */
  handleLogged('scan:active', () => db.request('scan:active'))

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
    return mainRuntime.runPromise(
      saveSkill(picked.filePath, parsed.success.content).pipe(
        Effect.map(path => ({ ok: true as const, path })),
        Effect.catchTag('SaveSkillError', error => Effect.succeed({ ok: false as const, error: error.message })),
      ),
    )
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

  handleLogged('store:session', (_event, sessionId: string, sourceId?: number) =>
    sourceId === undefined ? db.request('store:session', sessionId) : db.request('store:session', sessionId, sourceId),
  )

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

  for (const [channel, command] of [
    ['updates:status', 'status'],
    ['updates:check', 'check'],
    ['updates:download', 'download'],
    ['updates:install', 'install'],
  ] as const) {
    handleLogged(channel, (): Promise<UpdateStatus> =>
      mainRuntime.runPromise(Effect.flatMap(AppUpdates, updates => updates[command])),
    )
  }

  handleLogged('currency:get', () => db.request('currency:get'))

  handleLogged('currency:set', (_event, code: string) => db.request('currency:set', code))

  /** The full ISO 4217 currency list (162 codes) for the Settings selector. */
  handleLogged('currency:list', () => db.request('currency:list'))

  /** The natural place for a user-facing export artifact: Documents (or home
   * when the platform lacks the Documents role). Only used as the DEFAULT in
   * the save dialog — the user always confirms the final path. */
  function defaultExportBase(): string {
    try {
      return app.getPath('documents')
    } catch {
      return homedir()
    }
  }

  function exportCsvZip(stamp: string): Promise<ExportResult> {
    return mainRuntime.runPromise(
      exportCsvZipEffect(stamp, {
        defaultDirectory: defaultExportBase(),
        showSaveDialog: defaultPath =>
          dialog.showSaveDialog({
            title: 'Export CSV',
            defaultPath,
            filters: [{ name: 'ZIP', extensions: ['zip'] }],
          }),
        requestCsvFolder: staging => db.request('export:csv', staging) as Promise<ExportResult>,
      }),
    )
  }

  /** Uses explicit destinations for scripted exports and dialogs for UI exports. */
  async function runExport(kind: 'csv' | 'json', destination?: string): Promise<ExportResult> {
    if (destination) return (await db.request(`export:${kind}`, destination)) as ExportResult
    const stamp = exportStamp()
    if (kind === 'csv') return exportCsvZip(stamp)
    const picked = await dialog.showSaveDialog({
      title: 'Export JSON',
      defaultPath: 'watchtower-export.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true }
    return (await db.request('export:json', picked.filePath)) as ExportResult
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
    ledgerMcpServer: harnessKind =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({ try: () => db.ready, catch: error => error })
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
          return yield* Effect.flatMap(LedgerMcpPool, pool => pool.acquire(context))
        }
        return {
          server: buildLedgerMcpServer(context),
          release: () => {},
        }
      }),
  })
}

// Dev/standalone windows get the generated brand icon (ADR 0015); packaged
// builds carry it in the exe/dmg/AppImage, and build/ isn't shipped (files:
// out/**), so this resolves to no icon at runtime.
const devIcon = join(__dirname, '../../build/icon.png')

function createWindow(): BrowserWindow {
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
  backgroundShell?.attachMainWindow(mainWindow)

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return mainWindow
}

app.whenReady().then(async () => {
  if (!hasInstanceLock) return
  const dataDir = app.getPath('userData')
  try {
    await initOperationalLog({ logDir: join(dataDir, 'logs'), isPackaged: app.isPackaged })
  } catch {
    /* logging must never break boot */
  }
  // The data plane boots first: the worker owns the ledger from here on —
  // requests simply queue on its port until its synchronous init finishes.
  const cacheDir = join(dataDir, 'cache')
  // Capture the full sync-path snapshot once through this isolate's existing
  // application runtime. Pass its resolved cache directory to the worker so
  // both isolates use the same cache root.
  const appPathSnapshot = await mainRuntime.runPromise(
    readAppPathsEffect(cacheDir).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
    ),
  )
  initAppPaths(appPathSnapshot)
  const db = new DbWorkerClient(
    { dbPath: join(dataDir, 'ledger.db'), dataDir, cacheDir: appPathSnapshot.cacheDir },
    join(__dirname, 'db-worker.js'),
  )
  relayWorkerEvents(db)
  dbClient = db
  registerIpc(db)
  backgroundShell = await mainRuntime.runPromise(BackgroundShell)
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

  // macOS dock click: bring the (possibly hidden) window back.
  app.on('activate', () => backgroundShell?.showMainWindow())
})

app.on('window-all-closed', () => {
  // Living in the tray: with no window left (the orb disabled) the app keeps
  // running until the user quits from the tray.
  if (backgroundShell?.keepsRunning()) return
  if (process.platform !== 'darwin') app.quit()
})

// Wait for the owned resources before allowing Electron to exit. Repeated
// quit requests during cleanup share this shutdown instead of closing early.
function showUpdateInstallError(): void {
  dialog.showErrorBox(
    'Watchtower update',
    'The update could not be installed. Download the latest release from https://github.com/Pasquale-Favella/watchtower/releases/latest and install it manually. Your local data is retained.',
  )
  app.exit(1)
}

const quitCoordinator = createQuitCoordinator({
  markQuitting: () => backgroundShell?.markQuitting(),
  cleanup: async () => {
    const coachShutdown = mainRuntime
      .runPromise(Effect.flatMap(LedgerMcpPool, pool => pool.releaseAll()))
      .finally(() => agentsCleanup?.dispose())
      .finally(() => mainRuntime.dispose())
    const results = await Promise.allSettled([coachShutdown, dbClient?.shutdown()])
    try {
      closeOperationalLog()
    } catch {
      /* best effort */
    }
    if (results.some(result => result.status === 'rejected')) throw new Error('Shutdown failed')
  },
  quit: () => app.quit(),
  installFailed: showUpdateInstallError,
})
app.on('before-quit', quitCoordinator.beforeQuit)
