import { dirname, join } from 'path'
import { mkdirSync, existsSync } from 'fs'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { app, BrowserWindow, ipcMain, shell, dialog, type WebContents } from 'electron'
import { slugifyCandidateName } from '../shared/lib/skills-draft.js'
import {
  skillsSaveRequestSchema,
  type SkillsSaveResult,
  type SkillsThresholds,
} from '../shared/schemas/skills.js'
import { createUpdateChecker, type UpdateChecker, type UpdateStatus } from './updates.js'
import type { ExportResult } from './export.js'
import type { OverviewScope } from './overview.js'
import type { ComparePair } from './compare-view.js'
import { registerAgentsIpc } from './agents/ipc.js'
import { buildLedgerMcpServer } from './agents/ledger-mcp/config.js'
import { DbWorkerClient } from './db-worker/client.js'

/**
 * Main process (ADR 0023): windows, dialogs, IPC plumbing, updates, and the
 * harness-agent surface. All data work — the ledger, the scan pipeline, and
 * every query-time view builder — lives on the db-worker thread behind
 * `DbWorkerClient`, so a scan or a heavy aggregation can never freeze the
 * main event loop (and with it every window). The renderer wire contract is
 * unchanged: same channels, same payloads.
 */

let updateChecker: UpdateChecker | null = null
/** Coach temp-workspace teardown (map 53): registered at IPC wiring, run on quit. */
let agentsCleanup: { reset: () => Promise<void> } | null = null
/** The data-plane handle, set once the worker is spawned (quit path). */
let dbClient: DbWorkerClient | null = null
/** The requesting window of the in-flight manual scan (progress/error routing). */
let scanRequester: WebContents | null = null

function broadcast(channel: string, data?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, data)
  }
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
    }
  })
}

function registerIpc(db: DbWorkerClient): void {
  ipcMain.handle('scan:start', async (event, options?: { provider?: string }) => {
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

  ipcMain.handle('cadence:get', () => db.request('cadence:get'))

  ipcMain.handle('cadence:set', (_event, value: string) => db.request('cadence:set', value))

  ipcMain.handle('store:status', () => db.request('store:status'))

  ipcMain.handle('store:views', () => db.request('store:views'))

  ipcMain.handle('store:projects', () => db.request('store:projects'))

  ipcMain.handle('store:sessions', (_event, filter?: { project?: string; since?: string; until?: string }) =>
    db.request('store:sessions', filter))

  ipcMain.handle('sessions:view', (_event, scope: OverviewScope) => db.request('sessions:view', scope))

  ipcMain.handle('pullRequests:view', (_event, scope: OverviewScope) => db.request('pullRequests:view', scope))

  ipcMain.handle('spend:view', (_event, scope: OverviewScope) => db.request('spend:view', scope))

  ipcMain.handle('models:view', (_event, scope: OverviewScope) => db.request('models:view', scope))

  ipcMain.handle('compare:view', (_event, scope: OverviewScope, pair?: ComparePair) =>
    db.request('compare:view', scope, pair))

  ipcMain.handle('optimize:view', (_event, scope: OverviewScope) => db.request('optimize:view', scope))

  /** The Skills section's detection payload (ticket 24): pure local mining
   * of skill/bash/tool seams plus the on-disk inventory — no consent, no
   * network. Thresholds (frequency × spread) are renderer settings passed
   * per request; defaults (5 × 2) apply when absent. */
  ipcMain.handle('skills:view', (_event, scope: OverviewScope, thresholds?: SkillsThresholds) =>
    db.request('skills:view', scope, thresholds))

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

  ipcMain.handle('optimize:yield', (_event, scope: OverviewScope) => db.request('optimize:yield', scope))

  ipcMain.handle('models:addAlias', (_event, model: string, aliasOf: string) =>
    db.request('models:addAlias', model, aliasOf))

  ipcMain.handle('models:getAliases', () => db.request('models:getAliases'))

  ipcMain.handle('models:removeAlias', (_event, model: string) => db.request('models:removeAlias', model))

  ipcMain.handle('models:getPriceOverrides', () => db.request('models:getPriceOverrides'))

  ipcMain.handle('models:removePriceOverride', (_event, model: string) =>
    db.request('models:removePriceOverride', model))

  ipcMain.handle('models:setPrice', (_event, model: string, inputPricePerMillion: number, outputPricePerMillion: number) =>
    db.request('models:setPrice', model, inputPricePerMillion, outputPricePerMillion))

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

  ipcMain.handle('store:session', (_event, sessionId: string) => db.request('store:session', sessionId))

  ipcMain.handle('store:analytics', () => db.request('store:analytics'))

  ipcMain.handle('overview:query', (_event, scope: OverviewScope) => db.request('overview:query', scope))

  ipcMain.handle('store:search', (_event, query: string) => db.request('store:search', query))

  ipcMain.handle('settings:info', () => db.request('settings:info'))

  ipcMain.handle('settings:clear', () => db.request('settings:clear'))

  ipcMain.handle('pricing:refresh', () => db.request('pricing:refresh'))

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

  ipcMain.handle('currency:get', () => db.request('currency:get'))

  ipcMain.handle('currency:set', (_event, code: string) => db.request('currency:set', code))

  /** The full ISO 4217 currency list (162 codes) for the Settings selector. */
  ipcMain.handle('currency:list', () => db.request('currency:list'))

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
    return (await db.request(`export:${kind}`, target)) as ExportResult
  }

  ipcMain.handle('export:csv', (_event, destination?: string): Promise<ExportResult> => runExport('csv', destination))
  ipcMain.handle('export:json', (_event, destination?: string): Promise<ExportResult> => runExport('json', destination))

  // Coach + Skills agent chain (tickets 21–25): the HarnessRuntime seam's IPC
  // surface — harness listing, run ack/stream/cancel, the not-a-skill
  // dismissal store, and draft prose. The runner is lazy: the AI SDK loads on
  // the first harness-touching call, never at boot. Runs are user-initiated
  // from the unified Coach & Skills surface (ADR 0017); dismissals are a
  // ledger config table (written through the worker) so they survive clear().
  agentsCleanup = registerAgentsIpc({
    dismissals: {
      dismiss: async (source, name, reason) => {
        await db.request('skills:dismiss', { source, name, reason })
      },
    },
    // The app root: bundled ACP servers (codex) resolve from its node_modules.
    appPath: app.getAppPath(),
    // The in-app ledger MCP server (map 53): the harness agent spawns the app
    // itself as plain node (ELECTRON_RUN_AS_NODE=1) and reads the FULL
    // lifetime ledger read-only — no scope is baked at spawn (the harness
    // filters through each tool's optional `scope` argument). Paths:
    // `process.execPath` (dev + packaged), the bundled entry under appPath,
    // and the ledger DB beside the cache.
    ledgerMcpServer: () => {
      // Fresh install: no ledger.db yet → no data to serve, so no MCP server
      // (its read-only open would throw on a missing file). Once the first
      // scan lands, the next run injects it.
      const dbPath = join(app.getPath('userData'), 'ledger.db')
      if (!existsSync(dbPath)) return null
      return buildLedgerMcpServer({
        execPath: process.execPath,
        entryPath: join(app.getAppPath(), 'out/main/ledger-mcp.js'),
        dbPath,
      })
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
  const dataDir = app.getPath('userData')
  // The data plane boots first: the worker owns the ledger from here on —
  // requests simply queue on its port until its synchronous init finishes.
  const db = new DbWorkerClient(
    { dbPath: join(dataDir, 'ledger.db'), dataDir, cacheDir: join(dataDir, 'cache') },
    join(__dirname, 'db-worker.js'),
  )
  relayWorkerEvents(db)
  dbClient = db
  updateChecker = createUpdateChecker({ currentVersion: app.getVersion() })
  registerIpc(db)
  createWindow()

  // The worker queues requests until its synchronous init finishes, so the
  // window can paint immediately. A boot failure (unopenable ledger) cannot
  // heal — surface it once and quit instead of serving IPC errors forever.
  // The worker is never respawned in that case (client policy).
  void db.ready.then(undefined, err => {
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

// Tear down the coach conversation's temp workspace (map 53) so a reset or a
// quit never leaks a scratch directory under the OS temp root. Best-effort:
// the runner awaits run teardowns and retries the delete, and a leftover
// scratch dir is cleaned by the OS — quitting must never block on it. The
// data worker gets the same best-effort treatment: a chance to checkpoint
// and close the ledger before the process dies.
app.on('before-quit', () => {
  void agentsCleanup?.reset()
  void dbClient?.shutdown().catch(() => {})
})
