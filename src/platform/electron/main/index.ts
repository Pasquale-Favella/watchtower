import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

import * as ConfigProvider from 'effect/ConfigProvider'
import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as RpcServer from 'effect/rpc/RpcServer'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync } from 'fs'
import { isAbsolute, join, relative, sep } from 'path'

import { findProjectCheckout, SCRATCH_PROJECT_ID } from '@/core/application/commands/scratch-checkouts.js'
import { WorkspaceCheckouts, WorkspaceCheckoutsLive } from '@/core/application/commands/workspace-checkouts.js'
import { WorkspaceProjectSetupLive } from '@/core/application/commands/workspace-project-setup.js'
import { WorkspaceProjects, WorkspaceProjectsLive } from '@/core/application/commands/workspace-projects.js'
import {
  enrichSideChatPrompt,
  SideChatPersistence,
  WorkspaceSideChats,
  WorkspaceSideChatsLive,
} from '@/core/application/commands/workspace-side-chats.js'
import { AgentDriverError, type AgentSessionContext } from '@/core/ports/agent-driver.js'
import type { CheckoutActions } from '@/core/ports/checkout-actions.js'
import { CheckoutInspection, CheckoutInspectionError } from '@/core/ports/checkout-inspection.js'
import { type CheckoutResolver, CheckoutResolverError } from '@/core/ports/checkout-resolver.js'
import type { TerminalHost } from '@/core/ports/terminal-host.js'
import type { WorkspaceDevices } from '@/core/ports/workspace-devices.js'
import type { WorkspacePullRequests } from '@/core/ports/workspace-pull-requests.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { createDetectedHarnessConnectionCatalog } from '@/infrastructure/agent-harnesses/connection-catalog.js'
import { discoverNativeHarnessExecutables } from '@/infrastructure/agent-harnesses/native-executables.js'
import { HarnessSnapshot } from '@/infrastructure/agent-harnesses/snapshot.js'
import { initAppPaths, readAppPathsEffect } from '@/infrastructure/config/environment.js'
import { CheckoutBranchesLive } from '@/infrastructure/filesystem/checkout-branches.js'
import { CheckoutResolverLive } from '@/infrastructure/filesystem/checkout-resolver.js'
import { ProjectProvisionerLive } from '@/infrastructure/filesystem/project-provisioner.js'
import {
  closeOperationalLog,
  initOperationalLog,
  logCodeFor,
  safeLogOperationalEvent,
} from '@/infrastructure/logging/operational-log.js'
import { NodePlatformLive } from '@/infrastructure/platform/platform-live.js'
import { CommandRunnerLive } from '@/infrastructure/process/command-runner.js'
import { TerminalHostLive } from '@/infrastructure/terminal/terminal-host.js'
import { CheckoutActionsLive } from '@/infrastructure/workspace/checkout-actions.js'
import { WorkspaceDevicesLive } from '@/infrastructure/workspace/devices.js'
import { createPromptAttachmentStore } from '@/infrastructure/workspace/prompt-attachments.js'
import { WorkspacePullRequestsLive } from '@/infrastructure/workspace/pull-requests.js'
import { sideChatPersistenceLayer } from '@/infrastructure/workspace/side-chat-store.js'
import { createNativeApplicationCapabilities } from '@/platform/electron/main/application/native-capabilities.js'
import {
  BackgroundShell,
  type BackgroundShellHandle,
  backgroundShellLayer,
} from '@/platform/electron/main/background-shell.js'
import { acquireElectronUpdates } from '@/platform/electron/main/electron-updates.js'
import { type MainServices, makeMainRuntime } from '@/platform/electron/main/main-runtime.js'
import { acquireBrowserMcp } from '@/platform/electron/main/preview/browser-mcp.js'
import {
  createElectronWorkspacePreviewManager,
  workspacePreviewWindow,
} from '@/platform/electron/main/preview/electron-preview.js'
import { closeMainResources, createQuitCoordinator, settleWithin } from '@/platform/electron/main/quit-coordinator.js'
import { checkoutActionsHandlers } from '@/platform/electron/main/rpc/checkout-actions-handlers.js'
import { checkoutInspectionHandlers } from '@/platform/electron/main/rpc/checkout-inspection-handlers.js'
import { checkoutNavigationHandlers } from '@/platform/electron/main/rpc/checkout-navigation-handlers.js'
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
import { sourceControlHandlers } from '@/platform/electron/main/rpc/source-control-handlers.js'
import { terminalHandlers } from '@/platform/electron/main/rpc/terminal-handlers.js'
import { lifecycleEventFromWorker } from '@/platform/electron/main/rpc/worker-events.js'
import { workspaceDelegationHandlers } from '@/platform/electron/main/rpc/workspace-delegation-handlers.js'
import { workspaceDeviceHandlers } from '@/platform/electron/main/rpc/workspace-device-handlers.js'
import { workspaceHandlers } from '@/platform/electron/main/rpc/workspace-handlers.js'
import { workspacePreviewHandlers } from '@/platform/electron/main/rpc/workspace-preview-handlers.js'
import { workspacePullRequestHandlers } from '@/platform/electron/main/rpc/workspace-pull-request-handlers.js'
import { workspaceSideChatHandlers } from '@/platform/electron/main/rpc/workspace-side-chat-handlers.js'
import { AppUpdates, updatesLayer } from '@/platform/electron/main/updates.js'
import {
  type CheckoutPathFailure,
  guardGitCheckoutPath,
  resolveCheckoutPath,
  resolveTaskCheckoutPath,
} from '@/platform/electron/main/workspace/checkout-paths.js'
import { COACH_PROJECT_ID, ensureCoachProject } from '@/platform/electron/main/workspace/coach-project.js'
import { WorkspaceHost, WorkspaceHostLive } from '@/platform/electron/main/workspace/host.js'
import { createPromptReferenceFiles } from '@/platform/electron/main/workspace/prompt-references.js'
import { ensureScratchProject } from '@/platform/electron/main/workspace/scratch-project.js'
import { checkoutInspectionWorkerLayer } from '@/platform/electron/workers/checkout/client.js'
import { DbWorkerClient } from '@/platform/electron/workers/client.js'
import { acquireLedgerMcp, ledgerMcpWithStdio } from '@/platform/mcp/ledger-endpoint.js'
import { LocalLedgerMcp } from '@/platform/mcp/local-ledger-mcp.js'
import { createLedgerMcpQueries } from '@/platform/mcp/query-api.js'
import { ApplicationRpcGroup, BeaconRpcGroup, PanelRpcGroup } from '@/shared/rpc/application.js'
import { CheckoutInspectionRpcError } from '@/shared/rpc/checkout-inspection.js'
import { serverProtocolLayer } from '@/shared/rpc/port-protocol.js'
import { TerminalRpcError, terminalRpcMessages } from '@/shared/rpc/terminal.js'
import { pullRequestRpcMessages, WorkspacePullRequestRpcError } from '@/shared/rpc/workspace-pull-requests.js'
import type { CheckoutScope } from '@/shared/schemas/checkout-inspection.js'
import type { LedgerMcpStartupMode } from '@/shared/schemas/ledger-mcp.js'
import type { ProjectId, TaskId, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'
import type { WorkspaceCheckout } from '@/shared/schemas/workspace.js'
import type { WorkspaceProjectDetail } from '@/shared/schemas/workspace-store.js'

/**
 * Main process (ADR 0023): windows, dialogs, IPC plumbing, updates, and the
 * harness-agent surface. All data work — the ledger, the scan pipeline, and
 * every query-time view builder — lives on the db-worker thread behind
 * `DbWorkerClient`, so a scan or a heavy aggregation can never freeze the
 * main event loop (and with it every window). Window lifecycle and native
 * capabilities are registered here; renderer data access uses versioned RPC.
 */

/** The delayed harness-snapshot detection fiber: started once the main window shows, interrupted on quit. */
let harnessSnapshotStartup: Fiber.Fiber<void> | undefined
let harnessSnapshotDisposed = false
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

const sideChatStorageLayer = sideChatPersistenceLayer(join(app.getPath('userData'), 'workspace', 'side-chats'))

const resolveRegisteredCheckout = Effect.fnUntraced(function* (request: CheckoutScope) {
  const host = yield* WorkspaceHost
  const detail = yield* host.ensureOpen.pipe(
    Effect.andThen(Effect.suspend(() => host.store.getProject(request.projectId, { checkoutId: request.checkoutId }))),
    Effect.mapError((error): CheckoutPathFailure => (error.code === 'not-found' ? 'not-found' : 'unavailable')),
  )
  const checkout = findProjectCheckout(detail, request.checkoutId ?? detail.mainCheckout.id)
  if (!checkout || detail.project.archivedAt) return yield* Effect.fail<CheckoutPathFailure>('not-found')
  return {
    path: checkout.path,
    directory: checkout.kind === 'directory' || detail.project.isCoach === true || detail.project.isScratch === true,
  }
})

const resolveRegisteredCheckoutPath = (request: CheckoutScope) =>
  resolveRegisteredCheckout(request).pipe(Effect.map(checkout => checkout.path))

const resolveGitCheckoutPath = guardGitCheckoutPath(resolveRegisteredCheckoutPath)

const resolveWorkspaceTerminalTaskCwd = Effect.fnUntraced(function* (
  taskId: TaskId,
  requestedCheckoutId?: WorkspaceCheckoutId,
) {
  const host = yield* WorkspaceHost
  yield* host.ensureOpen
  const snapshot = yield* host.store.readTaskSnapshot(taskId, 1)
  if (snapshot.task.projectId !== SCRATCH_PROJECT_ID) return yield* resolveTaskCheckoutPath(taskId, requestedCheckoutId)
  if (snapshot.task.status === 'archived') return yield* Effect.fail('unavailable' as const)
  const latest = snapshot.runContexts?.[0]?.checkoutId
  const checkoutId =
    latest ?? (yield* host.store.readTaskDetail(taskId, { limit: 1 })).conversations[0]?.inheritedCheckoutId
  // An unsent scratch draft uses the root. Its new Task will use a different folder.
  if (!checkoutId && requestedCheckoutId)
    return yield* new TerminalRpcError({ code: 'conflict', message: terminalRpcMessages.conflict })
  if (!checkoutId) return yield* Effect.fail('unavailable' as const)
  return yield* resolveRegisteredCheckoutPath({ projectId: SCRATCH_PROJECT_ID, checkoutId })
})

const workspaceCheckoutInspectionHandlers = Layer.unwrap(
  Effect.gen(function* () {
    const host = yield* WorkspaceHost
    const inspection = yield* CheckoutInspection
    // No project and Coach work in plain managed folders. Git never runs below their roots, even when a legacy
    // Git-backed folder still has a repository.
    const managedRoots = [
      {
        projectId: SCRATCH_PROJECT_ID,
        managed: (detail: WorkspaceProjectDetail) => detail.project.isScratch,
        name: 'No project',
      },
      {
        projectId: COACH_PROJECT_ID,
        managed: (detail: WorkspaceProjectDetail) => detail.project.isCoach,
        name: 'Coach',
      },
    ] as const
    const gitOnly = <A>(path: string, inspect: Effect.Effect<A, CheckoutInspectionError>) =>
      Effect.gen(function* () {
        for (const { projectId, managed, name } of managedRoots) {
          const detail = yield* host.store
            .getProject(projectId, { limit: 1 })
            .pipe(
              Effect.catch(error =>
                error.code === 'not-found'
                  ? Effect.succeed(null)
                  : Effect.fail(
                      new CheckoutInspectionError({ code: 'unavailable', message: `Cannot check the ${name} root.` }),
                    ),
              ),
            )
          if (detail && managed(detail)) {
            const fromRoot = relative(detail.mainCheckout.path, path)
            if (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
              return yield* new CheckoutInspectionError({
                code: 'not-repository',
                message: `Git inspection is unavailable for ${name}.`,
              })
          }
        }
        return yield* inspect
      })
    const withoutScratchGit = CheckoutInspection.of({
      ...inspection,
      diffPreview: (path, source) => gitOnly(path, inspection.diffPreview(path, source)),
      filePatch: (path, request) => gitOnly(path, inspection.filePatch(path, request)),
      branches: path => gitOnly(path, inspection.branches(path)),
      commits: path => gitOnly(path, inspection.commits(path)),
    })
    return checkoutInspectionHandlers({
      resolveCheckoutPath: request =>
        resolveRegisteredCheckout(request).pipe(
          Effect.mapError(code =>
            code === 'not-found'
              ? new CheckoutInspectionRpcError({ code, message: 'Checkout record was not found.' })
              : new CheckoutInspectionRpcError({ code, message: 'Checkout inspection is unavailable.' }),
          ),
        ),
    }).pipe(Layer.provide(Layer.succeed(CheckoutInspection, withoutScratchGit)))
  }),
)

// Only the inert host is acquired at boot. Its worker, database and drivers stay lazy.
const workspaceHostLayer = Layer.effect(
  WorkspaceHost,
  Effect.gen(function* () {
    const snapshot = yield* HarnessSnapshot
    const sideChatStorage = yield* SideChatPersistence
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
        prepareSession: (context): Effect.Effect<AgentSessionContext, AgentDriverError, Scope.Scope> => {
          // Coaching reads the usage ledger and nothing else: no browser, and the host adds no orchestrator.
          if (context.projectId === COACH_PROJECT_ID) {
            const worker = dbClient
            if (!worker)
              return Effect.fail(new AgentDriverError({ code: 'invalid-state', message: 'The ledger is not ready.' }))
            return acquireLedgerMcp(createLedgerMcpQueries(worker), request => mainRuntime.runPromise(request)).pipe(
              Effect.map(endpoint => ({
                ...context,
                mcpEndpoints: [
                  ...(context.mcpEndpoints ?? []),
                  ledgerMcpWithStdio(endpoint, process.execPath, join(__dirname, 'ledger-mcp-proxy.js')),
                ],
              })),
            )
          }
          const manager = workspacePreviewManager
          if (!manager) return Effect.succeed(context)
          return acquireBrowserMcp(
            {
              manager,
              context,
              artifactDirectory: join(app.getPath('userData'), 'workspace', 'browser-recordings'),
              host: () => {
                const window = BrowserWindow.getAllWindows().find(
                  window => rendererRoles.get(window.webContents) === 'app',
                )
                if (!window)
                  throw new AgentDriverError({ code: 'invalid-state', message: 'Open Workspace to use the browser.' })
                return workspacePreviewWindow(manager, window.webContents)
              },
            },
            request => mainRuntime.runPromise(request),
          ).pipe(
            Effect.map(prepared => ({
              ...prepared,
              // The browser endpoint keeps its stdio bridge for harnesses that accept only stdio servers.
              mcpEndpoints: prepared.mcpEndpoints.map(endpoint => ({
                ...endpoint,
                stdio: {
                  command: process.execPath,
                  args: [join(__dirname, 'browser-mcp-proxy.js')],
                  env: [
                    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
                    { name: 'WATCHTOWER_BROWSER_MCP_URL', value: endpoint.url },
                    { name: 'WATCHTOWER_BROWSER_MCP_TOKEN', value: endpoint.token },
                  ],
                },
              })),
            })),
          )
        },
        orchestratorStdio: endpoint => ({
          command: process.execPath,
          args: [join(__dirname, 'orchestrator-mcp-proxy.js')],
          env: [
            { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
            { name: 'WATCHTOWER_ORCHESTRATOR_MCP_URL', value: endpoint.url },
            { name: 'WATCHTOWER_ORCHESTRATOR_MCP_TOKEN', value: endpoint.token },
          ],
        }),
        // Explicit types keep this callback from inferring through the runtime that consumes it.
        runOrchestration: <A, E>(request: Effect.Effect<A, E>): Promise<A> => mainRuntime.runPromise(request),
        // The explicit return type keeps this callback from inferring through the runtime that consumes it.
        createWorktree: (request): Effect.Effect<WorkspaceCheckout, unknown> =>
          Effect.tryPromise({
            try: () =>
              mainRuntime.runPromise(
                Effect.flatMap(WorkspaceCheckouts, checkouts => checkouts.createWorktree(request)),
              ),
            catch: error => error,
          }),
        enrichPrompt: (claim, store) =>
          enrichSideChatPrompt(claim.taskId, claim.prompt, claim.nativeSessionId).pipe(
            Effect.provideService(SideChatPersistence, sideChatStorage),
            Effect.provideService(WorkspaceStore, store),
            Effect.mapError(
              () =>
                new AgentDriverError({ code: 'invalid-state', message: 'The side chat context could not be read.' }),
            ),
          ),
        resolveAttachments: references =>
          Effect.tryPromise({
            try: () =>
              createPromptAttachmentStore(join(app.getPath('userData'), 'workspace', 'attachments')).resolve(
                references,
              ),
            catch: () =>
              new AgentDriverError({
                code: 'invalid-state',
                message: 'A saved attachment is missing or failed integrity validation.',
              }),
          }),
        filename: join(app.getPath('userData'), 'workspace.db'),
        prewarmConnections: true,
        workerPath: join(__dirname, 'workspace-worker.js'),
        runtimeExecutable: process.execPath,
        // Leave headroom inside the 15-second quit ceiling for the worker and ledger drain.
        closeDeadlineMs: 3_000,
        closeTimeoutMs: 2_000,
        loadConnectionCatalog: () =>
          Effect.gen(function* () {
            const nativeExecutables = yield* discoverNativeHarnessExecutables()
            const rows = yield* snapshot.list()
            const instances = yield* Effect.forEach(rows, row => snapshot.get(row.instanceId))
            return yield* Effect.try({
              try: () =>
                createDetectedHarnessConnectionCatalog({
                  instances: instances.filter(instance => instance !== undefined),
                  runtimeExecutable: process.execPath,
                  nativeExecutables,
                }),
              catch: error => error,
            })
          }).pipe(Effect.provide(NodePlatformLive)),
      }),
      scope,
    )
    return Context.get(context, WorkspaceHost)
  }),
).pipe(Layer.provide(sideChatStorageLayer))
const workspaceStoreLayer = Layer.effect(
  WorkspaceStore,
  Effect.map(WorkspaceHost, host => host.store),
)
const workspaceCheckoutsLayer = Layer.effect(
  WorkspaceCheckouts,
  Effect.map(WorkspaceCheckouts, checkouts => {
    const gitUnavailable = (projectId: ProjectId) =>
      projectId === SCRATCH_PROJECT_ID || projectId === COACH_PROJECT_ID
        ? new CheckoutResolverError({
            code: 'not-a-repository',
            message: `Git is unavailable for ${projectId === COACH_PROJECT_ID ? 'Coach' : 'No project'}.`,
          })
        : null
    return WorkspaceCheckouts.of({
      branches: request => {
        const refused = gitUnavailable(request.projectId)
        return refused ? Effect.fail(refused) : checkouts.branches(request)
      },
      switchBranch: request => {
        const refused = gitUnavailable(request.projectId)
        return refused ? Effect.fail(refused) : checkouts.switchBranch(request)
      },
      createWorktree: request => {
        const refused = gitUnavailable(request.projectId)
        return refused ? Effect.fail(refused) : checkouts.createWorktree(request)
      },
    })
  }),
).pipe(Layer.provide(WorkspaceCheckoutsLive(join(app.getPath('userData'), 'worktrees'))))
const workspaceLayer = WorkspaceProjectSetupLive.pipe(
  Layer.provideMerge(WorkspaceProjectsLive),
  Layer.provideMerge(WorkspaceSideChatsLive.pipe(Layer.provide(sideChatStorageLayer))),
  Layer.provideMerge(workspaceCheckoutsLayer),
  Layer.provideMerge(
    Layer.mergeAll(
      CheckoutResolverLive,
      CheckoutBranchesLive,
      checkoutInspectionWorkerLayer(join(__dirname, 'checkout-worker.js')),
      CheckoutActionsLive,
      WorkspaceDevicesLive,
      WorkspacePullRequestsLive,
      ProjectProvisionerLive,
      workspaceStoreLayer,
    ),
  ),
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
    TerminalHostLive,
  ),
)
/** Tray + floating orb + hide-on-close (set once the app is ready). */
let backgroundShell: BackgroundShellHandle | null = null

// One Watchtower per profile: with the app living in the tray, launching it
// again must bring the existing window back rather than boot a second ledger
// owner. The e2e suite runs each launch on its own `--user-data-dir`, so its
// instances never contend for this lock.
const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) app.quit()
app.on('second-instance', () => backgroundShell?.showMainWindow())
// Renderers never open their own windows; external links go through the http(s)-only shell RPC.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
})

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

/** Starts the connection catalog's harness detection shortly after the first paint. */
function startHarnessSnapshot(): void {
  if (harnessSnapshotDisposed || harnessSnapshotStartup) return
  harnessSnapshotStartup = mainRuntime.runFork(
    Effect.flatMap(HarnessSnapshot, snapshot =>
      Effect.sleep(Duration.millis(1500)).pipe(
        Effect.andThen(snapshot.start()),
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => snapshot.shutdown()),
      ),
    ).pipe(Effect.catchCause(() => Effect.void)),
  )
}

/** Runs during quit, before the main runtime is disposed. */
async function stopHarnessSnapshot(): Promise<void> {
  harnessSnapshotDisposed = true
  if (harnessSnapshotStartup) await mainRuntime.runPromise(Fiber.interrupt(harnessSnapshotStartup))
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
    startHarnessSnapshot()
  })
  backgroundShell?.attachMainWindow(mainWindow)

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return mainWindow
}

let workspacePreviewManager: ReturnType<typeof createElectronWorkspacePreviewManager> | undefined

app.whenReady().then(async () => {
  if (!hasInstanceLock) return
  const dataDir = app.getPath('userData')
  const previews = createElectronWorkspacePreviewManager()
  workspacePreviewManager = previews
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
  const nativeCapabilities = createNativeApplicationCapabilities({
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
    showSaveDialog: options => dialog.showSaveDialog(options),
  })
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
        | CheckoutInspection
        | CheckoutActions
        | TerminalHost
        | WorkspaceDevices
        | WorkspacePullRequests
        | WorkspaceSideChats
      >
      switch (role) {
        case 'app':
          program = RpcServer.make(ApplicationRpcGroup, options).pipe(
            Effect.provide(
              Layer.mergeAll(
                workspaceHandlers<Effect.Services<ReturnType<typeof ensureScratchProject | typeof ensureCoachProject>>>(
                  {
                    attachments: createPromptAttachmentStore(join(app.getPath('userData'), 'workspace', 'attachments')),
                    promptReferences: createPromptReferenceFiles(
                      join(app.getPath('userData'), 'workspace', 'prompt-references'),
                    ),
                    chooseProjectDirectory: () =>
                      Effect.tryPromise({
                        try: async () => {
                          const selected = await dialog.showOpenDialog({
                            title: 'Open a Project',
                            properties: ['openDirectory'],
                          })
                          return selected.canceled ? null : (selected.filePaths[0] ?? null)
                        },
                        catch: error => error,
                      }),
                    prepareScratchProject: store =>
                      ensureScratchProject(store, join(app.getPath('userData'), 'workspace', 'scratch')),
                    prepareCoachProject: store =>
                      ensureCoachProject(store, join(app.getPath('userData'), 'workspace', 'coach')),
                  },
                ),
                Layer.unwrap(
                  Effect.map(WorkspaceHost, host =>
                    terminalHandlers({
                      resolveTaskCwd: (taskId, checkoutId) =>
                        resolveWorkspaceTerminalTaskCwd(taskId, checkoutId).pipe(
                          Effect.provideService(WorkspaceHost, host),
                          Effect.mapError(error =>
                            error instanceof TerminalRpcError
                              ? error
                              : new TerminalRpcError({
                                  code: 'cwd-unavailable',
                                  message: 'The Task checkout is unavailable.',
                                }),
                          ),
                        ),
                      resolveDraftCwd: target =>
                        Effect.gen(function* () {
                          yield* host.ensureOpen
                          if (target.projectId) {
                            return yield* resolveCheckoutPath({
                              projectId: target.projectId,
                              ...(target.checkoutId ? { checkoutId: target.checkoutId } : {}),
                            })
                          }
                          const scratch = yield* ensureScratchProject(
                            host.store,
                            join(app.getPath('userData'), 'workspace', 'scratch'),
                          )
                          return scratch.mainCheckout.path
                        }).pipe(
                          Effect.provideService(WorkspaceHost, host),
                          Effect.mapError(
                            () =>
                              new TerminalRpcError({
                                code: 'cwd-unavailable',
                                message: 'The Task checkout is unavailable.',
                              }),
                          ),
                        ),
                    }),
                  ),
                ),
                workspaceCheckoutInspectionHandlers,
                checkoutActionsHandlers({ resolveCheckoutPath: resolveGitCheckoutPath }),
                checkoutNavigationHandlers({ resolveCheckoutPath: resolveRegisteredCheckoutPath }),
                workspacePreviewHandlers(previews, sender),
                workspaceDeviceHandlers(),
                sourceControlHandlers.pipe(Layer.provide(CommandRunnerLive), Layer.provide(NodePlatformLive)),
                workspacePullRequestHandlers({
                  resolveCheckoutPath: scope =>
                    resolveGitCheckoutPath(scope).pipe(
                      Effect.mapError(
                        () =>
                          new WorkspacePullRequestRpcError({
                            code: 'not-found',
                            message: pullRequestRpcMessages['not-found'],
                          }),
                      ),
                    ),
                }),
                workspaceSideChatHandlers,
                workspaceDelegationHandlers,
              ),
            ),
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

  // Prewarm the local MCP endpoint after the data worker is ready when requested.
  void db.ready
    .then(async () => {
      safeLogOperationalEvent('info', 'boot.ready', {})
      safeLogOperationalEvent('info', 'worker.ready', {}, 'worker')
      const startupMode = (await db.request('ledger-mcp:startup:get')) as LedgerMcpStartupMode
      if (startupMode === 'at-launch') {
        await mainRuntime.runPromise(
          Effect.flatMap(LocalLedgerMcp, local => local.connection(createLedgerMcpQueries(db))),
        )
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

/** Renderer RPC requests in flight get this long to unwind before the data plane closes under them. */
const RENDERER_RPC_DRAIN_MS = 1_500

const quitCoordinator = createQuitCoordinator({
  markQuitting: () => backgroundShell?.markQuitting(),
  cleanup: async () => {
    disposeRendererRpc?.()
    workspacePreviewManager?.dispose()
    await settleWithin(
      Promise.all(Array.from(rendererRpcFibers, fiber => mainRuntime.runPromise(Fiber.interrupt(fiber)))),
      RENDERER_RPC_DRAIN_MS,
    )
    try {
      await closeMainResources({
        stopCoach: () =>
          mainRuntime
            .runPromise(Effect.flatMap(LocalLedgerMcp, local => local.shutdown()))
            .finally(() => stopHarnessSnapshot()),
        stopWorker: () => dbClient?.shutdown() ?? Promise.resolve(),
        disposeRuntime: () => mainRuntime.dispose(),
      })
    } catch (error) {
      safeLogOperationalEvent('error', 'app.shutdown', {
        outcome: 'failed',
        code: logCodeFor(error, 'resources-unconfirmed'),
      })
      throw error
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
