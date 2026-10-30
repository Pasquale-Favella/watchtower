import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

import * as ConfigProvider from 'effect/ConfigProvider'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as RpcServer from 'effect/rpc/RpcServer'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

import { WorkspaceProjects, WorkspaceProjectsLive } from '@/core/application/commands/workspace-projects.js'
import type { CheckoutResolver } from '@/core/ports/checkout-resolver.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { loadDetectedHarnessConnections } from '@/infrastructure/agent-harnesses/connection-catalog.js'
import { HarnessSnapshot } from '@/infrastructure/agent-harnesses/snapshot.js'
import { initAppPaths, readAppPathsEffect } from '@/infrastructure/config/environment.js'
import { CheckoutResolverLive } from '@/infrastructure/filesystem/checkout-resolver.js'
import {
  closeOperationalLog,
  initOperationalLog,
  logCodeFor,
  safeLogOperationalEvent,
} from '@/infrastructure/logging/operational-log.js'
import { createNativeApplicationCapabilities } from '@/platform/electron/main/application/native-capabilities.js'
import {
  BackgroundShell,
  type BackgroundShellHandle,
  backgroundShellLayer,
} from '@/platform/electron/main/background-shell.js'
import { createApplicationAgents } from '@/platform/electron/main/coach/ipc.js'
import { acquireElectronUpdates } from '@/platform/electron/main/electron-updates.js'
import { type MainServices, makeMainRuntime } from '@/platform/electron/main/main-runtime.js'
import { closeMainResources, createQuitCoordinator } from '@/platform/electron/main/quit-coordinator.js'
import { coachHandlers } from '@/platform/electron/main/rpc/coach-handlers.js'
import { registerElectronRpc, type RpcWindowRole } from '@/platform/electron/main/rpc/electron.js'
import { analyticsHandlers, configHandlers } from '@/platform/electron/main/rpc/handlers.js'
import {
  lifecycleHandlers,
  LifecycleHub,
  type LifecycleHubService,
  lifecycleLayer,
  type LifecyclePublishEvent,
} from '@/platform/electron/main/rpc/lifecycle.js'
import { nativeHandlers } from '@/platform/electron/main/rpc/native-handlers.js'
import { shellHandlers } from '@/platform/electron/main/rpc/shell-handlers.js'
import { lifecycleEventFromWorker } from '@/platform/electron/main/rpc/worker-events.js'
import { workspaceHandlers } from '@/platform/electron/main/rpc/workspace-handlers.js'
import { AppUpdates, updatesLayer } from '@/platform/electron/main/updates.js'
import { WorkspaceHost, WorkspaceHostLive } from '@/platform/electron/main/workspace/host.js'
import { DbWorkerClient } from '@/platform/electron/workers/client.js'
import { buildLedgerMcpServer, ledgerMcpTransportFor } from '@/platform/mcp/config.js'
import { LedgerMcpPool } from '@/platform/mcp/pool.js'
import { ApplicationRpcGroup, BeaconRpcGroup, PanelRpcGroup } from '@/shared/rpc/application.js'
import { serverProtocolLayer } from '@/shared/rpc/port-protocol.js'
import type { LedgerMcpStartupMode } from '@/shared/schemas/ledger-mcp.js'

/**
 * Main process (ADR 0023): windows, dialogs, IPC plumbing, updates, and the
 * harness-agent surface. All data work — the ledger, the scan pipeline, and
 * every query-time view builder — lives on the db-worker thread behind
 * `DbWorkerClient`, so a scan or a heavy aggregation can never freeze the
 * main event loop (and with it every window). Window lifecycle and native
 * capabilities are registered here; renderer data access uses versioned RPC.
 */

/** Coach temp-workspace teardown (map 53): registered at IPC wiring, run on quit. */
let agentsCleanup: { start: () => void; reset: () => Promise<void>; dispose: () => Promise<void> } | null = null
/** The data-plane handle, set once the worker is spawned (quit path). */
let dbClient: DbWorkerClient | null = null
const rendererRoles = new WeakMap<Electron.WebContents, RpcWindowRole>()
const rendererRpcFibers = new Set<Fiber.Fiber<never>>()
let disposeRendererRpc: (() => void) | undefined
let lifecycleHub: LifecycleHubService | undefined
const appUpdatesLayer = updatesLayer({
  currentVersion: app.getVersion(),
  source: acquireElectronUpdates({
    isPackaged: app.isPackaged,
    platform: process.platform,
    appPath: app.getAppPath(),
    executablePath: process.execPath,
    appImage: process.env['APPIMAGE'],
    onInstallError: showUpdateInstallError,
  }),
  onChange: status => {
    publishLifecycle({ _tag: 'UpdateChanged', status })
  },
  requestInstall: install => quitCoordinator.requestInstall(install),
})

const rendererLifecycleLayer = lifecycleLayer<AppUpdates | HarnessSnapshot>({
  epoch: randomUUID(),
  readSnapshot: {
    scanStatus: () => readWorkerSnapshot('store:status'),
    scanActivity: () =>
      readWorkerSnapshot('scan:active').pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Boolean)),
        Effect.map(scanning => ({ scanning, progress: null, error: null })),
      ),
    currency: () => readWorkerSnapshot('currency:get'),
    updater: () => Effect.flatMap(AppUpdates, updates => updates.status),
    harnesses: () => Effect.flatMap(HarnessSnapshot, snapshot => snapshot.current()),
  },
}).pipe(Layer.provideMerge(appUpdatesLayer))

// Only the inert host is acquired at boot. Its worker, database and drivers stay lazy.
const workspaceHostLayer = Layer.effect(
  WorkspaceHost,
  Effect.gen(function* () {
    const snapshot = yield* HarnessSnapshot
    const scope = yield* Effect.acquireRelease(Scope.make(), scope =>
      Scope.close(scope, Exit.void).pipe(
        Effect.onExit(exit =>
          Effect.sync(() => {
            const confirmed = Exit.isSuccess(exit)
            safeLogOperationalEvent(confirmed ? 'info' : 'error', 'workspace.close', {
              outcome: confirmed ? 'success' : 'failed',
              code: confirmed ? 'cleanup-confirmed' : 'cleanup-unconfirmed',
            })
          }),
        ),
      ),
    )
    const context = yield* Layer.buildWithScope(
      WorkspaceHostLive({
        filename: join(app.getPath('userData'), 'workspace.db'),
        workerPath: join(__dirname, 'workspace-worker.js'),
        runtimeExecutable: process.execPath,
        // Leave headroom inside the 15-second quit ceiling for the worker and ledger drain.
        closeDeadlineMs: 3_000,
        closeTimeoutMs: 2_000,
        loadConnections: () => loadDetectedHarnessConnections(snapshot, process.execPath),
      }),
      scope,
    )
    return Context.get(context, WorkspaceHost)
  }),
)
const workspaceStoreLayer = Layer.effect(
  WorkspaceStore,
  Effect.map(WorkspaceHost, host => host.store),
)
const workspaceLayer = WorkspaceProjectsLive.pipe(
  Layer.provideMerge(Layer.merge(CheckoutResolverLive, workspaceStoreLayer)),
  Layer.provideMerge(workspaceHostLayer),
)

const mainRuntime = makeMainRuntime(
  {
    clientVersion: app.getVersion(),
    appPath: app.getAppPath(),
    onHarnessChange: rows => {
      publishLifecycle({ _tag: 'HarnessesChanged', rows })
    },
  },
  {},
  Layer.mergeAll(
    workspaceLayer,
    backgroundShellLayer({
      onRendererWindow: (window, role) => rendererRoles.set(window.webContents, role),
      preloadPath: join(__dirname, '../preload/index.js'),
      rendererUrl: process.env['ELECTRON_RENDERER_URL'],
      rendererDir: join(__dirname, '../renderer'),
      iconPath: app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(__dirname, '../../build/icon.png'),
      createMainWindow: createWindow,
      requestScan: () => void dbClient?.request('scan:start').catch(() => {}),
    }),
    rendererLifecycleLayer,
  ),
)
/** App-level loopback-HTTP ledger sidecar: shared by Copilot, local external
 * MCP clients, and any future harness that rejects stdio. It remains lazy by
 * default and is prewarmed after the data worker is ready when the persisted
 * startup setting requests it. */
const sidecarPool = {
  connection: (context: ReturnType<typeof ledgerMcpContext>) =>
    mainRuntime.runPromise(Effect.flatMap(LedgerMcpPool, pool => pool.connection(context))),
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

function publishLifecycle(event: LifecyclePublishEvent): void {
  if (lifecycleHub) mainRuntime.runSync(lifecycleHub.publish(event))
}

function readWorkerSnapshot(operation: string): Effect.Effect<unknown, Error> {
  return Effect.tryPromise({
    try: () => {
      if (!dbClient) return Promise.reject(new Error('Data worker unavailable'))
      return dbClient.request(operation)
    },
    catch: () => new Error('Data worker unavailable'),
  })
}

function ledgerMcpContext(): { execPath: string; entryPath: string; dbPath: string } {
  return {
    execPath: process.execPath,
    entryPath: join(app.getAppPath(), 'out/main/ledger-mcp.js'),
    dbPath: join(app.getPath('userData'), 'ledger.db'),
  }
}

/** The lifecycle hub projects worker events to each authenticated window role. */
function relayWorkerEvents(db: DbWorkerClient): void {
  db.onReplaced(() => {
    if (lifecycleHub) mainRuntime.runSync(lifecycleHub.workerReplaced)
  })
  db.onEvent(event => {
    const lifecycle = lifecycleEventFromWorker(event)
    if (lifecycle._tag === 'Failure') {
      safeLogOperationalEvent('warn', 'rpc.worker-event.invalid', {
        op: lifecycle.failure.event,
        code: lifecycle.failure.code,
      })
    } else if (lifecycle.success) publishLifecycle(lifecycle.success)
    if (event.event === 'oplog') safeLogOperationalEvent(event.level, event.logEvent, event.fields, 'worker')
  })
}

function registerApplicationAgents(db: DbWorkerClient): ReturnType<typeof createApplicationAgents> {
  // One coordinator owns harness runs and their conversation workspace.
  return createApplicationAgents({
    runtime: mainRuntime,
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

  rendererRoles.set(mainWindow.webContents, 'app')
  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    agentsCleanup?.start()
  })
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
  lifecycleHub = await mainRuntime.runPromise(LifecycleHub)
  const db = new DbWorkerClient(
    { dbPath: join(dataDir, 'ledger.db'), dataDir, cacheDir: appPathSnapshot.cacheDir },
    join(__dirname, 'db-worker.js'),
  )
  relayWorkerEvents(db)
  dbClient = db
  const agents = registerApplicationAgents(db)
  agentsCleanup = agents
  const nativeCapabilities = createNativeApplicationCapabilities(
    {
      worker: db,
      version: app.getVersion(),
      skillDirectory: join(homedir(), '.agents', 'skills'),
      exportDirectory: () => {
        try {
          return app.getPath('documents')
        } catch {
          return homedir()
        }
      },
      ledgerMcpContext,
      showSaveDialog: options => dialog.showSaveDialog(options),
    },
    {
      getCoachHarnesses: () => agents.native.list,
      refreshCoachHarnesses: () => agents.native.refresh,
      inspectCoachHarness: agents.native.inspect,
      openCoachLoginTerminal: agents.native.openLoginTerminal,
    },
  )
  disposeRendererRpc = registerElectronRpc({
    ipcMain,
    resolveRole: ({ webContents, url }) => {
      const role = rendererRoles.get(webContents)
      if (!role) return undefined
      const filename = { app: 'index.html', panel: 'orb-panel.html', beacon: 'orb.html' }[role]
      const rendererUrl = process.env['ELECTRON_RENDERER_URL']
      const expected = rendererUrl
        ? role === 'app'
          ? new URL(rendererUrl).href
          : new URL(filename, `${rendererUrl.replace(/\/$/, '')}/`).href
        : pathToFileURL(join(__dirname, '../renderer', filename)).href
      return new URL(url).href === expected ? role : undefined
    },
    onConnection: (port, role, sender) => {
      const handlers = Layer.mergeAll(
        analyticsHandlers(db, role === 'panel' ? 'panel' : 'app'),
        configHandlers(
          db,
          Effect.flatMap(LifecycleHub, hub => hub.currentConfigRevision),
          Effect.flatMap(LifecycleHub, hub => hub.currentLedgerGeneration),
        ),
        lifecycleHandlers,
        nativeHandlers(nativeCapabilities),
        shellHandlers(sender),
      )
      const protocol = serverProtocolLayer(port)
      const options = { disableTracing: true, disableFatalDefects: true } as const
      const provideHandlers = Effect.provide(Layer.merge(handlers, protocol))
      let program: Effect.Effect<
        never,
        never,
        | LifecycleHub
        | MainServices
        | AppUpdates
        | BackgroundShell
        | WorkspaceHost
        | WorkspaceProjects
        | CheckoutResolver
      >
      switch (role) {
        case 'app':
          program = RpcServer.make(ApplicationRpcGroup, options).pipe(
            Effect.provide(Layer.merge(coachHandlers(agents.native), workspaceHandlers())),
            provideHandlers,
          )
          break
        case 'panel':
          program = RpcServer.make(PanelRpcGroup, options).pipe(provideHandlers)
          break
        case 'beacon':
          program = RpcServer.make(BeaconRpcGroup, options).pipe(provideHandlers)
          break
      }
      const fiber = mainRuntime.runFork(program)
      rendererRpcFibers.add(fiber)
      fiber.addObserver(() => rendererRpcFibers.delete(fiber))
      return () => fiber.interruptUnsafe()
    },
  })
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
    disposeRendererRpc?.()
    await Promise.all(Array.from(rendererRpcFibers, fiber => mainRuntime.runPromise(Fiber.interrupt(fiber))))
    try {
      await closeMainResources({
        stopCoach: () =>
          mainRuntime
            .runPromise(Effect.flatMap(LedgerMcpPool, pool => pool.releaseAll()))
            .finally(() => agentsCleanup?.dispose()),
        stopWorker: () => dbClient?.shutdown() ?? Promise.resolve(),
        disposeRuntime: () => mainRuntime.dispose(),
      })
    } finally {
      try {
        closeOperationalLog()
      } catch {
        /* best effort */
      }
    }
  },
  quit: () => app.quit(),
  installFailed: showUpdateInstallError,
})
app.on('before-quit', quitCoordinator.beforeQuit)
