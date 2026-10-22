import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as FiberMap from 'effect/FiberMap'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  type Event as ElectronEvent,
  globalShortcut,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  Menu,
  nativeImage,
  screen,
  Tray,
} from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

import { acceleratorFor, SHORTCUTS } from '../shared/lib/shortcuts.js'
import { type Section, sectionSchema } from '../shared/schemas/navigation.js'
import { orbPanelRequestSchema, type OrbPlacement } from '../shared/schemas/orb.js'
import { logCodeFor, safeLogOperationalEvent } from './operational-log.js'
import { clampToWorkArea, defaultOrbPosition, orbBounds, panelLayout } from './orb-geometry.js'
import { containsPoint, createHeldRequest, createPeekGate, offsetAnchor, type Point } from './orb-policy.js'
import { DEFAULT_SHELL_PREFERENCES, loadShellPreferences, saveShellPreferences } from './shell-preferences.js'

/**
 * The background shell: what keeps Watchtower alive once its window is
 * closed. Closing the main window hides it instead of quitting (the db-worker
 * keeps scanning on its cadence), a tray icon offers Open / Summon / Scan /
 * Quit, and a small always-on-top "orb" floats on the desktop. The registry's
 * global `summonOrb` shortcut (ADR 0001) brings it back even after both the
 * window and the orb were dismissed.
 *
 * The orb is two windows: the 64px orb itself, which never resizes (so it
 * never jumps), and its spend panel, created hidden alongside it so its data
 * is loaded before it is first opened. The orb page stays light — it only
 * knows the scan state and where it sits; the panel page owns the data.
 *
 * Both are shown only while the main window is not (hidden or minimized):
 * with the full app on screen they would just be clutter. Neither takes
 * focus on its own — only a click on the orb or the summon shortcut does.
 *
 * Every panel open/fold decision is made here, the first-close peek included
 * (when it opens, its note, its timer): the pages only ask and render.
 */

const isSection = Schema.is(sectionSchema)
const isPanelRequest = Schema.is(orbPanelRequestSchema)

/** How long a revealed panel may wait, transparent, for its page to report a
 * painted frame before it is made opaque regardless. */
const REVEAL_FALLBACK_MS = 200
/** How long a window may take to become ready before it is shown anyway. */
const READY_FALLBACK_MS = 2_000
/** How long an open may wait for the orb to reach the screen before it is
 * considered stale and dropped. */
const HELD_OPEN_TTL_MS = 3_000
/** A peek folds itself after this long — unless the pointer rests on the
 * panel, in which case it re-checks every `PEEK_RECHECK_MS`. */
const PEEK_MS = 6_000
const PEEK_RECHECK_MS = 1_000

/** The registry's OS-wide summon shortcut, as an Electron accelerator. */
const SUMMON_ACCELERATOR = (() => {
  const def = SHORTCUTS.find(entry => entry.action === 'summonOrb' && entry.scope === 'global')
  return def ? acceleratorFor(def.hotkey) : null
})()

/** How the panel opens: `open` is the user's own request (focused), `peek`
 * is the first-close note (inactive, folds on its own). */
type PanelMode = 'open' | 'peek'

export interface BackgroundShellOptions {
  onRendererWindow?: (window: BrowserWindow, role: 'beacon' | 'panel') => void
  preloadPath: string
  /** electron-vite's dev server URL, when running `npm run dev`. */
  rendererUrl: string | undefined
  /** Folder holding the built renderer pages (`index.html`, `orb*.html`). */
  rendererDir: string
  /** A PNG for the tray; when missing, the executable's own icon is used. */
  iconPath: string | null
  createMainWindow: () => BrowserWindow
  requestScan: () => void
}

export interface BackgroundShellHandle {
  /** Wires hide-on-close and orb visibility to a freshly created main window. */
  attachMainWindow: (win: BrowserWindow) => void
  /** Brings the full app back (creating the window if needed), optionally on a section. */
  showMainWindow: (section?: Section) => void
  /** Called from `before-quit`: from here on, closing a window really closes it. */
  markQuitting: () => void
  /** Whether the app should stay alive with no windows open. */
  keepsRunning: () => boolean
}

export class BackgroundShell extends Context.Service<BackgroundShell, BackgroundShellHandle>()(
  'watchtower/main/BackgroundShell',
) {}

class ShellTrayError extends Schema.TaggedError<ShellTrayError>()('ShellTrayError', { code: Schema.String }) {}

const trayIcon = Effect.fn('BackgroundShell.trayIcon')(function* (iconPath: string | null) {
  let image = iconPath && existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  if (image.isEmpty()) {
    image = yield* Effect.tryPromise({
      try: () => app.getFileIcon(process.execPath, { size: 'small' }),
      catch: cause => new ShellTrayError({ code: logCodeFor(cause, 'icon-failed') }),
    }).pipe(Effect.orElseSucceed(() => nativeImage.createEmpty()))
  }
  const size = process.platform === 'darwin' ? 18 : 16
  return image.isEmpty() ? image : image.resize({ width: size, height: size, quality: 'best' })
})

function live(win: BrowserWindow | null): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null
}

const createBackgroundShell = Effect.fn('BackgroundShell.acquire')(function* (options: BackgroundShellOptions) {
  const tasks = yield* FiberMap.make<string, unknown, never>()
  // Native callbacks enter fibers in this layer's captured context and scope.
  const runTask = yield* FiberMap.runtime(tasks)<never>()
  const clock = yield* Clock.Clock
  const cancel = (key: string): void => {
    runTask(key, Effect.void)
  }
  const prefsFile = join(app.getPath('userData'), 'shell-preferences.json')
  const prefs = yield* loadShellPreferences(prefsFile).pipe(
    Effect.catchTag('ShellPreferencesError', error =>
      Effect.sync(() => {
        if (error.code !== 'ENOENT')
          safeLogOperationalEvent('warn', 'shell.preferences-unavailable', { code: error.code })
        return { ...DEFAULT_SHELL_PREFERENCES }
      }),
    ),
  )
  const savePreferences = (): void => {
    runTask(
      'preferences',
      saveShellPreferences(prefsFile, prefs).pipe(
        Effect.catchTag('ShellPreferencesError', error =>
          Effect.sync(() => {
            safeLogOperationalEvent('warn', 'shell.preferences-unavailable', { code: error.code })
          }),
        ),
      ),
    )
  }
  let mainWindow: BrowserWindow | null = null
  let orbWindow: BrowserWindow | null = null
  let panelWindow: BrowserWindow | null = null
  let tray: Tray | null = null
  let quitting = false
  let anchor: Point = clampToWorkArea(prefs.orbPosition ?? defaultOrbPosition())
  /** The panel is open (or opening — see revealPanel). */
  let expanded = false
  /** The open is the first-close peek: inactive, with its note, folding on
   * its own until the user interacts with it. */
  let peeking = false
  let dragOrigin: Point | null = null
  /** The first-close peek: once per session, once the close and the panel's
   * data have both happened. */
  const peekGate = createPeekGate()
  /** An open asked for while the orb is still on its way to the screen: applied
   * when the orb shows, unless it has gone stale meanwhile. */
  const heldOpen = createHeldRequest<PanelMode>(HELD_OPEN_TTL_MS, () => clock.currentTimeMillisUnsafe())
  /** The orb is about the app being *away*: never float it during boot,
   * before the main window has been on screen once. */
  let mainWindowShown = false
  /** Set while the panel is shown but still transparent (see revealPanel). */
  let revealing = false

  function showWhenReady(win: BrowserWindow, key: string, show: () => void): void {
    cancel(key)
    if (quitting || win.isDestroyed()) return
    if (!win.webContents.isLoading()) {
      show()
      return
    }
    const ready = Effect.callback<undefined>(resume => {
      const onReady = (): void => resume(Effect.succeed(undefined))
      const onClosed = (): void => resume(Effect.interrupt)
      win.once('ready-to-show', onReady)
      win.once('closed', onClosed)
      return Effect.sync(() => {
        win.removeListener('ready-to-show', onReady)
        win.removeListener('closed', onClosed)
      })
    })
    runTask(
      key,
      Effect.raceFirst(ready, Effect.sleep(READY_FALLBACK_MS)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (!quitting && !win.isDestroyed()) show()
          }),
        ),
      ),
    )
  }

  function mainWindowAway(): boolean {
    return !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()
  }

  function orbWanted(): boolean {
    return prefs.orbEnabled && !quitting && mainWindowShown && mainWindowAway()
  }

  /** Either orb window (the orb or its panel). */
  function isOrbSurface(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return event.sender === live(orbWindow)?.webContents || event.sender === live(panelWindow)?.webContents
  }

  /** The orb window itself — the only one that drags. */
  function isOrbSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return event.sender === live(orbWindow)?.webContents
  }

  function isPanelSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return event.sender === live(panelWindow)?.webContents
  }

  function currentPlacement(): OrbPlacement {
    return panelLayout(anchor, expanded, peeking).placement
  }

  function broadcastPlacement(): OrbPlacement {
    const placement = currentPlacement()
    for (const win of [live(orbWindow), live(panelWindow)]) win?.webContents.send('orb:placement', placement)
    return placement
  }

  function clearPeekTimer(): void {
    cancel('peek')
  }

  /** The peek folds on its own — but not from under a pointer resting on it. */
  function schedulePeekFold(delayMs: number): void {
    clearPeekTimer()
    runTask(
      'peek',
      Effect.sleep(delayMs).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (!peeking) return
            const panel = live(panelWindow)
            if (panel && containsPoint(panel.getBounds(), screen.getCursorScreenPoint())) {
              schedulePeekFold(PEEK_RECHECK_MS)
              return
            }
            applyPanel(false)
          }),
        ),
      ),
    )
  }

  function finishReveal(): void {
    cancel('reveal')
    if (!revealing) return
    revealing = false
    const panel = live(panelWindow)
    if (quitting || !expanded || !panel?.isVisible()) return
    panel.setOpacity(1)
    if (peeking) {
      peekGate.shown()
      schedulePeekFold(PEEK_MS)
    }
  }

  /** Shows the hidden panel without a flicker. A hidden transparent window
   * reappears with its stale (or evicted) surface for a frame before Chromium
   * paints a fresh one — it reads as the panel opening twice. So it is shown
   * fully transparent — once its page can paint (or a fallback passes) — and
   * made opaque when the page reports a painted frame (`orb:panel-painted`),
   * or after a short fallback so it can never stay invisible. (`setOpacity` is
   * a no-op on Linux: there it simply shows.) */
  function revealPanel(panel: BrowserWindow, focus: boolean): void {
    panel.setOpacity(0)
    showWhenReady(panel, 'panel-ready', () => {
      // Folded or quitting while the page got ready: show nothing.
      if (!expanded || quitting || panel.isDestroyed()) return
      if (focus) {
        panel.show()
        panel.focus()
      } else {
        panel.showInactive()
      }
      revealing = true
      runTask('reveal', Effect.sleep(REVEAL_FALLBACK_MS).pipe(Effect.andThen(Effect.sync(finishReveal))))
    })
  }

  /** Opens (as `mode`) or folds the panel window beside the visible orb. */
  function applyPanel(open: false): OrbPlacement
  function applyPanel(open: true, mode: PanelMode): OrbPlacement
  function applyPanel(open: boolean, mode: PanelMode = 'open'): OrbPlacement {
    const panel = live(panelWindow)
    const wasOpen = expanded
    expanded = open && !!panel
    // A peek stays a peek only while nothing else asks for the panel.
    peeking = expanded && mode === 'peek' && (!wasOpen || peeking)
    clearPeekTimer()
    if (panel && expanded) {
      panel.setBounds(panelLayout(anchor, true).bounds)
      if (!panel.isVisible()) revealPanel(panel, mode === 'open')
      else {
        if (peeking && !revealing) {
          peekGate.shown()
          schedulePeekFold(PEEK_MS)
        }
        if (mode === 'open') panel.focus()
      }
    } else {
      heldOpen.clear()
      cancel('panel-ready')
      cancel('reveal')
      revealing = false
      if (panel?.isVisible()) panel.hide()
    }
    return broadcastPlacement()
  }

  /** Opens the panel as `mode` — beside a visible orb. One that arrives while
   * the orb is still on its way is held and applied when it shows. */
  function openPanel(mode: PanelMode): OrbPlacement {
    if (!orbWanted()) return currentPlacement()
    if (!live(orbWindow)?.isVisible()) {
      if (orbWanted()) heldOpen.hold(mode)
      return currentPlacement()
    }
    return applyPanel(true, mode)
  }

  function surfaceWindow(page: 'orb.html' | 'orb-panel.html', extra: BrowserWindowConstructorOptions): BrowserWindow {
    const win = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      // The orb and its panel draw their own shadows inside the window.
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'Watchtower',
      ...extra,
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        ...extra.webPreferences,
      },
    })
    win.setAlwaysOnTop(true, 'floating')
    // macOS: follow the user across Spaces and over full-screen apps.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    options.onRendererWindow?.(win, page === 'orb.html' ? 'beacon' : 'panel')
    if (options.rendererUrl) void win.loadURL(`${options.rendererUrl}/${page}`)
    else void win.loadFile(join(options.rendererDir, page))
    return win
  }

  /** Creates the orb and its (hidden) panel together, so the panel's data is
   * loaded by the time it is first opened. */
  function ensureSurfaces(): BrowserWindow {
    const existing = live(orbWindow)
    if (existing) return existing
    const orb = surfaceWindow('orb.html', orbBounds(anchor))
    orb.on('closed', () => {
      if (orbWindow === orb) orbWindow = null
    })
    orbWindow = orb

    const panel = surfaceWindow('orb-panel.html', {
      ...panelLayout(anchor, false).bounds,
      // Keep rendering while hidden, so it opens on a painted, current frame.
      webPreferences: { backgroundThrottling: false },
    })
    // Clicking anywhere else folds the panel — except a press on the orb
    // itself: there the orb decides (any click toggles, a drag folds), else
    // the panel would fold here and the same click reopen it. Decided by where
    // the cursor is, not by which window took focus — no timing to race.
    panel.on('blur', () => {
      const orbRect = live(orbWindow)?.getBounds()
      if (!expanded || (orbRect && containsPoint(orbRect, screen.getCursorScreenPoint()))) return
      applyPanel(false)
    })
    // Interacting with a peek makes it an ordinary open: no more self-fold.
    panel.on('focus', () => {
      if (!peeking) return
      peeking = false
      clearPeekTimer()
      broadcastPlacement()
    })
    panel.on('closed', () => {
      if (panelWindow === panel) panelWindow = null
    })
    panelWindow = panel
    return orb
  }

  /** Window events arrive in bursts (show → restore, minimize → hide) and
   * mid-transition `isVisible()` can lie: settle before deciding. */
  function scheduleOrbVisibility(): void {
    if (quitting) return
    runTask('visibility', Effect.sleep(150).pipe(Effect.andThen(Effect.sync(updateOrbVisibility))))
  }

  function updateOrbVisibility(): void {
    if (orbWanted()) {
      const orb = ensureSurfaces()
      if (orb.isVisible()) {
        if (peekGate.pending() && !expanded) openPanel('peek')
        return
      }
      orb.setBounds(orbBounds(anchor))
      showWhenReady(orb, 'orb-ready', () => {
        if (!orbWanted()) return // the app came back while the orb was loading
        orb.showInactive()
        // An open that arrived while the orb was on its way (if still fresh).
        const mode = heldOpen.take()
        if (mode) applyPanel(true, mode)
        else if (peekGate.pending()) applyPanel(true, 'peek')
      })
    } else {
      heldOpen.clear()
      cancel('orb-ready')
      if (!live(orbWindow)?.isVisible()) return
      if (expanded) applyPanel(false)
      live(orbWindow)?.hide()
    }
  }

  /** The main window navigates itself (`navigateToSection`): only the
   * section name crosses the wire, never a route path. The window is hidden,
   * never destroyed, while the app runs, so recreating it is a crash fallback
   * that opens on its default route (the requested section is not replayed). */
  function showMainWindow(section?: Section): void {
    if (quitting) return
    if (!mainWindow || mainWindow.isDestroyed()) {
      options.createMainWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    if (section) mainWindow.webContents.send('app:navigate', section)
  }

  function setOrbEnabled(enabled: boolean): void {
    prefs.orbEnabled = enabled
    savePreferences()
    rebuildTrayMenu()
    updateOrbVisibility()
  }

  /** The global shortcut: brings Watchtower back from wherever it went.
   * - the main window is on screen → focus it;
   * - the panel is open (or opening) → open the full app (press twice);
   * - otherwise → float the orb and open the panel focused. Not gated on the
   *   panel's data: it shows whatever the panel holds (only the orb's own
   *   first paint can delay it). Summoning a hidden orb turns "Show floating
   *   orb" back on: pressing it is asking for the orb. */
  function summon(): void {
    if (!mainWindowAway()) {
      showMainWindow()
      return
    }
    if (expanded) {
      applyPanel(false)
      showMainWindow()
      return
    }
    mainWindowShown = true
    if (!prefs.orbEnabled) setOrbEnabled(true)
    else updateOrbVisibility()
    openPanel('open')
  }

  function registerSummonShortcut(): void {
    if (!SUMMON_ACCELERATOR) return
    // Another app may own the combination: the tray still works, so a refusal
    // is logged, never fatal.
    if (!globalShortcut.register(SUMMON_ACCELERATOR, summon)) {
      safeLogOperationalEvent('warn', 'shell.shortcut-unavailable', { accelerator: SUMMON_ACCELERATOR })
    }
  }

  function rebuildTrayMenu(): void {
    if (!tray) return
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Watchtower', click: () => showMainWindow() },
        {
          label: 'Summon orb',
          // Display only: the shortcut is registered globally, not per menu.
          ...(SUMMON_ACCELERATOR ? { accelerator: SUMMON_ACCELERATOR, registerAccelerator: false } : {}),
          click: () => summon(),
        },
        { label: 'Scan now', click: () => options.requestScan() },
        { type: 'separator' },
        {
          label: 'Show floating orb',
          type: 'checkbox',
          checked: prefs.orbEnabled,
          click: item => setOrbEnabled(item.checked),
        },
        {
          label: 'Keep running when closed',
          type: 'checkbox',
          checked: prefs.runInBackground,
          click: item => {
            prefs.runInBackground = item.checked
            savePreferences()
          },
        },
        { type: 'separator' },
        { label: 'Quit Watchtower', click: () => app.quit() },
      ]),
    )
  }

  const createTray = Effect.gen(function* () {
    const icon = yield* trayIcon(options.iconPath)
    const acquired = yield* Effect.acquireRelease(
      Effect.try({
        try: () => new Tray(icon),
        catch: cause => new ShellTrayError({ code: logCodeFor(cause, 'tray-failed') }),
      }),
      resource =>
        Effect.sync(() => {
          if (tray === resource) tray = null
          resource.destroy()
        }),
    )
    tray = acquired
    acquired.setToolTip('Watchtower')
    // Windows/Linux: a left click opens the app; the menu stays on right click.
    // macOS opens the context menu on click, as menu-bar items do.
    if (process.platform !== 'darwin') acquired.on('click', () => showMainWindow())
    rebuildTrayMenu()
    return yield* Effect.never
  }).pipe(
    Effect.scoped,
    Effect.catchTag('ShellTrayError', error =>
      Effect.sync(() => {
        safeLogOperationalEvent('warn', 'shell.tray-unavailable', { code: error.code })
      }),
    ),
  )

  function registerOrbIpc(): void {
    handle('orb:placement:get', event => (isOrbSurface(event) ? currentPlacement() : null))
    handle('orb:panel:request', (event, request: unknown) => {
      if (!isOrbSurface(event) || !isPanelRequest(request)) return null
      return request === 'fold' ? applyPanel(false) : openPanel('open')
    })
    // The panel's data is in: the first-close peek may open now (once).
    listen('orb:panel-data-ready', event => {
      if (isPanelSender(event) && peekGate.dataReady()) openPanel('peek')
    })
    listen('orb:drag-start', event => {
      if (!isOrbSender(event)) return
      // The panel is anchored to the orb: a drag folds it rather than leave it behind.
      if (expanded) applyPanel(false)
      dragOrigin = { ...anchor }
    })
    listen('orb:drag-move', (event, dx: unknown, dy: unknown) => {
      if (!isOrbSender(event) || !dragOrigin || typeof dx !== 'number' || typeof dy !== 'number') return
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
      // Free movement while dragging; the clamp to the work area lands on drop.
      anchor = offsetAnchor(dragOrigin, dx, dy)
      live(orbWindow)?.setBounds(orbBounds(anchor))
    })
    listen('orb:drag-end', event => {
      if (!isOrbSender(event) || !dragOrigin) return
      dragOrigin = null
      anchor = clampToWorkArea(anchor)
      live(orbWindow)?.setBounds(orbBounds(anchor))
      broadcastPlacement()
      prefs.orbPosition = anchor
      savePreferences()
    })
    listen('orb:open-app', (event, section: unknown) => {
      if (!isOrbSurface(event)) return
      if (expanded) applyPanel(false)
      showMainWindow(isSection(section) ? section : undefined)
    })
    listen('orb:hide', event => {
      if (isOrbSurface(event)) setOrbEnabled(false)
    })
    listen('orb:quit', event => {
      if (isOrbSurface(event)) app.quit()
    })
    // The panel page painted a fresh frame after opening: reveal it.
    listen('orb:panel-painted', event => {
      if (revealing && isPanelSender(event)) finishReveal()
    })
  }

  // Monitors come and go (laptop undocked): keep the orb on a live screen.
  const onDisplayRemoved = (): void => {
    if (quitting) return
    anchor = clampToWorkArea(anchor)
    live(orbWindow)?.setBounds(orbBounds(anchor))
    if (expanded) live(panelWindow)?.setBounds(panelLayout(anchor, true).bounds)
    broadcastPlacement()
  }

  function markQuitting(): void {
    if (quitting) return
    quitting = true
    heldOpen.clear()
    for (const key of ['peek', 'visibility', 'reveal', 'orb-ready', 'panel-ready', 'tray']) cancel(key)
    if (SUMMON_ACCELERATOR) globalShortcut.unregister(SUMMON_ACCELERATOR)
    live(panelWindow)?.hide()
    live(orbWindow)?.hide()
  }

  // Remove only this shell's subscriptions; other main-process IPC stays live
  // until its own owner shuts down.
  const subscriptions: Array<() => void> = []
  const listen = (channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): void => {
    const active = (event: IpcMainEvent, ...args: unknown[]): void => {
      if (!quitting) listener(event, ...args)
    }
    ipcMain.on(channel, active)
    subscriptions.push(() => ipcMain.removeListener(channel, active))
  }
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => (quitting ? null : listener(event, ...args)))
    subscriptions.push(() => ipcMain.removeHandler(channel))
  }
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      markQuitting()
      screen.removeListener('display-removed', onDisplayRemoved)
      for (const unsubscribe of subscriptions) unsubscribe()
      live(panelWindow)?.destroy()
      live(orbWindow)?.destroy()
    }),
  )
  registerOrbIpc()
  registerSummonShortcut()
  screen.on('display-removed', onDisplayRemoved)
  runTask('tray', createTray)

  return BackgroundShell.of({
    attachMainWindow: win => {
      mainWindow = win
      const onClose = (event: ElectronEvent): void => {
        if (quitting) return
        event.preventDefault()
        if (!prefs.runInBackground) {
          app.quit()
          return
        }
        win.hide()
        // "Once" means once it can be seen: with the orb off, nothing is spent.
        if (prefs.orbEnabled && peekGate.closed()) openPanel('peek')
      }
      const onShow = (): void => {
        mainWindowShown = true
        scheduleOrbVisibility()
      }
      const onChange = (): void => scheduleOrbVisibility()
      const onClosed = (): void => {
        if (mainWindow === win) mainWindow = null
        scheduleOrbVisibility()
      }
      win.on('close', onClose)
      win.on('show', onShow)
      win.on('closed', onClosed)
      for (const change of ['hide', 'minimize', 'restore'] as const) win.on(change as 'hide', onChange)
      subscriptions.push(() => {
        win.removeListener('close', onClose)
        win.removeListener('show', onShow)
        win.removeListener('closed', onClosed)
        for (const change of ['hide', 'minimize', 'restore'] as const) win.removeListener(change as 'hide', onChange)
      })
    },
    showMainWindow,
    markQuitting,
    keepsRunning: () => !quitting && prefs.runInBackground,
  })
})

export function backgroundShellLayer(options: BackgroundShellOptions): Layer.Layer<BackgroundShell> {
  return Layer.effect(BackgroundShell, createBackgroundShell(options))
}
