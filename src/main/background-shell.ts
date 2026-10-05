import * as Schema from 'effect/Schema'
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  type IpcMainEvent,
  Menu,
  type NativeImage,
  nativeImage,
  screen,
  Tray,
} from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import { type Section, sectionSchema } from '../shared/schemas/navigation.js'
import {
  ORB_PANEL_SIZE,
  ORB_SIZE,
  ORB_SUMMON_SHORTCUT,
  type OrbNotice,
  type OrbPlacement,
} from '../shared/schemas/orb.js'
import { safeLogOperationalEvent } from './operational-log.js'

/**
 * The background shell: what keeps Watchtower alive once its window is
 * closed. Closing the main window hides it instead of quitting (the db-worker
 * keeps scanning on its cadence), a tray icon offers Open / Scan / Quit, and a
 * small always-on-top "orb" floats on the desktop — draggable, with a hint
 * panel that can reopen the full app on the section a hint is about. A global
 * shortcut (ORB_SUMMON_SHORTCUT) summons it back even after both the window
 * and the orb were dismissed.
 *
 * The orb is shown only while the main window is not (hidden or minimized):
 * with the full app on screen it would just be clutter.
 */

interface ShellPreferences {
  /** Close hides the window and keeps the app in the tray. */
  runInBackground: boolean
  /** Show the floating orb while the main window is away. */
  orbEnabled: boolean
  /** Top-left of the orb circle in screen DIPs; null = default corner. */
  orbPosition: { x: number; y: number } | null
}

const isSection = Schema.is(sectionSchema)

const DEFAULT_PREFERENCES: ShellPreferences = { runInBackground: true, orbEnabled: true, orbPosition: null }

/** Gap kept between the orb and the work-area edge. */
const EDGE_MARGIN = 12

export interface BackgroundShellOptions {
  preloadPath: string
  /** electron-vite's dev server URL, when running `npm run dev`. */
  rendererUrl: string | undefined
  /** Folder holding the built renderer pages (`index.html`, `orb.html`). */
  rendererDir: string
  /** A PNG for the tray; when missing, the executable's own icon is used. */
  iconPath: string | null
  createMainWindow: () => BrowserWindow
  requestScan: () => void
}

export interface BackgroundShell {
  /** Wires hide-on-close and orb visibility to a freshly created main window. */
  attachMainWindow: (win: BrowserWindow) => void
  /** Brings the full app back (creating the window if needed), optionally on a section. */
  showMainWindow: (section?: Section) => void
  /** Called from `before-quit`: from here on, closing a window really closes it. */
  markQuitting: () => void
  /** Whether the app should stay alive with no windows open. */
  keepsRunning: () => boolean
}

function loadPreferences(file: string): ShellPreferences {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ShellPreferences>
    const position = raw.orbPosition
    return {
      runInBackground: typeof raw.runInBackground === 'boolean' ? raw.runInBackground : true,
      orbEnabled: typeof raw.orbEnabled === 'boolean' ? raw.orbEnabled : true,
      orbPosition:
        position && Number.isFinite(position.x) && Number.isFinite(position.y)
          ? { x: Math.round(position.x), y: Math.round(position.y) }
          : null,
    }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

function clampToWorkArea(point: { x: number; y: number }): { x: number; y: number } {
  const area = screen.getDisplayNearestPoint({
    x: Math.round(point.x + ORB_SIZE / 2),
    y: Math.round(point.y + ORB_SIZE / 2),
  }).workArea
  return {
    x: Math.round(Math.min(Math.max(point.x, area.x + EDGE_MARGIN), area.x + area.width - ORB_SIZE - EDGE_MARGIN)),
    y: Math.round(Math.min(Math.max(point.y, area.y + EDGE_MARGIN), area.y + area.height - ORB_SIZE - EDGE_MARGIN)),
  }
}

function defaultOrbPosition(): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: area.x + area.width - ORB_SIZE - EDGE_MARGIN * 2,
    y: area.y + area.height - ORB_SIZE - EDGE_MARGIN * 6,
  }
}

/** Window bounds for the orb at `anchor`. Expanded, the panel grows toward
 * the display's centre so it never runs off the edge the orb is parked on. */
function orbLayout(
  anchor: { x: number; y: number },
  expanded: boolean,
): { bounds: Electron.Rectangle; placement: OrbPlacement } {
  const area = screen.getDisplayNearestPoint({ x: anchor.x + ORB_SIZE / 2, y: anchor.y + ORB_SIZE / 2 }).workArea
  const onRight = anchor.x + ORB_SIZE / 2 > area.x + area.width / 2
  const onBottom = anchor.y + ORB_SIZE / 2 > area.y + area.height / 2
  const placement: OrbPlacement = {
    expanded,
    horizontal: onRight ? 'right' : 'left',
    vertical: onBottom ? 'bottom' : 'top',
  }
  if (!expanded) return { bounds: { x: anchor.x, y: anchor.y, width: ORB_SIZE, height: ORB_SIZE }, placement }
  const { width, height } = ORB_PANEL_SIZE
  return {
    bounds: {
      x: Math.round(onRight ? anchor.x + ORB_SIZE - width : anchor.x),
      y: Math.round(onBottom ? anchor.y + ORB_SIZE - height : anchor.y),
      width,
      height,
    },
    placement,
  }
}

async function trayIcon(iconPath: string | null): Promise<NativeImage> {
  let image = iconPath && existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  if (image.isEmpty()) {
    try {
      image = await app.getFileIcon(process.execPath, { size: 'small' })
    } catch {
      /* an empty tray image is still a working (if invisible) tray */
    }
  }
  const size = process.platform === 'darwin' ? 18 : 16
  return image.isEmpty() ? image : image.resize({ width: size, height: size, quality: 'best' })
}

export function createBackgroundShell(options: BackgroundShellOptions): BackgroundShell {
  const prefsFile = join(app.getPath('userData'), 'shell-preferences.json')
  const prefs = loadPreferences(prefsFile)
  let mainWindow: BrowserWindow | null = null
  let orbWindow: BrowserWindow | null = null
  let tray: Tray | null = null
  let quitting = false
  let anchor = clampToWorkArea(prefs.orbPosition ?? defaultOrbPosition())
  let expanded = false
  let dragOrigin: { x: number; y: number } | null = null
  /** A notice raised before the orb page finished loading. */
  let pendingNotice: OrbNotice | null = null
  /** The orb is about the app being *away*: never float it during boot,
   * before the main window has been on screen once. */
  let mainWindowShown = false
  let visibilityTimer: NodeJS.Timeout | null = null

  function savePreferences(): void {
    try {
      writeFileSync(prefsFile, JSON.stringify(prefs, null, 2), 'utf8')
    } catch {
      /* preferences are a convenience — never break the shell over them */
    }
  }

  function mainWindowAway(): boolean {
    return !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()
  }

  function isOrbSender(event: IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
    return !!orbWindow && !orbWindow.isDestroyed() && event.sender === orbWindow.webContents
  }

  function applyOrbLayout(): OrbPlacement {
    const { bounds, placement } = orbLayout(anchor, expanded)
    if (orbWindow && !orbWindow.isDestroyed()) {
      orbWindow.setBounds(bounds)
      orbWindow.webContents.send('orb:placement', placement)
    }
    return placement
  }

  function setExpanded(next: boolean): OrbPlacement {
    expanded = next
    return applyOrbLayout()
  }

  function ensureOrbWindow(): BrowserWindow {
    if (orbWindow && !orbWindow.isDestroyed()) return orbWindow
    const { bounds } = orbLayout(anchor, false)
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'Watchtower',
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // Clicking anywhere else folds the panel back into the orb.
    win.on('blur', () => {
      if (expanded) setExpanded(false)
    })
    win.on('closed', () => {
      if (orbWindow === win) orbWindow = null
    })
    if (options.rendererUrl) void win.loadURL(`${options.rendererUrl}/orb.html`)
    else void win.loadFile(join(options.rendererDir, 'orb.html'))
    orbWindow = win
    return win
  }

  /** Window events arrive in bursts (show → restore, minimize → hide) and
   * mid-transition `isVisible()` can lie: settle before deciding. */
  function scheduleOrbVisibility(): void {
    if (visibilityTimer) clearTimeout(visibilityTimer)
    visibilityTimer = setTimeout(() => {
      visibilityTimer = null
      updateOrbVisibility()
    }, 150)
  }

  function updateOrbVisibility(): void {
    const wanted = prefs.orbEnabled && !quitting && mainWindowShown && mainWindowAway()
    if (wanted) {
      const win = ensureOrbWindow()
      if (!win.isVisible()) {
        expanded = false
        applyOrbLayout()
        // Never steal focus from whatever the user is doing.
        if (win.webContents.isLoading()) win.once('ready-to-show', () => win.showInactive())
        else win.showInactive()
      }
    } else if (orbWindow && !orbWindow.isDestroyed() && orbWindow.isVisible()) {
      expanded = false
      orbWindow.hide()
    }
  }

  function notifyOrb(notice: OrbNotice): void {
    if (!prefs.orbEnabled) return
    // The orb may not exist yet (the window's `hide` event can land after
    // this call) or may still be loading: hold the notice until it can listen.
    if (!orbWindow || orbWindow.isDestroyed() || orbWindow.webContents.isLoading()) pendingNotice = notice
    else orbWindow.webContents.send('orb:notice', notice)
  }

  /** The main window navigates itself (`navigateToSection`): only the
   * section name crosses the wire, never a route path. */
  function showMainWindow(section?: Section): void {
    if (!mainWindow || mainWindow.isDestroyed()) {
      const win = options.createMainWindow()
      if (section) win.webContents.once('did-finish-load', () => win.webContents.send('app:navigate', section))
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    if (section) mainWindow.webContents.send('app:navigate', section)
  }

  /** The global shortcut: brings Watchtower back from wherever it went.
   * - the main window is on screen → focus it;
   * - the orb panel is already open → open the full app (press twice);
   * - otherwise → float the orb (re-enabling it if it was hidden), unfold its
   *   panel and focus it, so Escape or a click elsewhere folds it again. */
  function summon(): void {
    if (!mainWindowAway()) {
      showMainWindow()
      return
    }
    if (expanded && orbWindow && !orbWindow.isDestroyed() && orbWindow.isVisible()) {
      setExpanded(false)
      showMainWindow()
      return
    }
    if (!prefs.orbEnabled) {
      prefs.orbEnabled = true
      savePreferences()
      rebuildTrayMenu()
    }
    mainWindowShown = true
    updateOrbVisibility()
    const win = ensureOrbWindow()
    const focus = (): void => {
      win.show()
      win.focus()
    }
    if (win.webContents.isLoading()) win.once('ready-to-show', focus)
    else focus()
    notifyOrb({ kind: 'summoned' })
  }

  function registerSummonShortcut(): void {
    // Another app may own the combination: the tray still works, so a refusal
    // is logged, never fatal.
    if (!globalShortcut.register(ORB_SUMMON_SHORTCUT.accelerator, summon)) {
      safeLogOperationalEvent('warn', 'shell.shortcut-unavailable', { accelerator: ORB_SUMMON_SHORTCUT.accelerator })
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
          accelerator: ORB_SUMMON_SHORTCUT.accelerator,
          registerAccelerator: false,
          click: () => summon(),
        },
        { label: 'Scan now', click: () => options.requestScan() },
        { type: 'separator' },
        {
          label: 'Show floating orb',
          type: 'checkbox',
          checked: prefs.orbEnabled,
          click: item => {
            prefs.orbEnabled = item.checked
            savePreferences()
            updateOrbVisibility()
          },
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

  async function createTray(): Promise<void> {
    tray = new Tray(await trayIcon(options.iconPath))
    tray.setToolTip('Watchtower')
    // Windows/Linux: a left click opens the app; the menu stays on right click.
    // macOS opens the context menu on click, as menu-bar items do.
    if (process.platform !== 'darwin') tray.on('click', () => showMainWindow())
    rebuildTrayMenu()
  }

  function registerOrbIpc(): void {
    ipcMain.handle('orb:placement:get', event => (isOrbSender(event) ? orbLayout(anchor, expanded).placement : null))
    // Pulled by the orb page once its listeners are live: a push on
    // `did-finish-load` can land before React has subscribed.
    ipcMain.handle('orb:notice:take', event => {
      if (!isOrbSender(event)) return null
      const notice = pendingNotice
      pendingNotice = null
      return notice
    })
    ipcMain.handle('orb:expanded:set', (event, next: unknown) =>
      isOrbSender(event) ? setExpanded(next === true) : null,
    )
    ipcMain.on('orb:drag-start', event => {
      if (!isOrbSender(event)) return
      if (expanded) setExpanded(false)
      dragOrigin = { ...anchor }
    })
    ipcMain.on('orb:drag-move', (event, dx: unknown, dy: unknown) => {
      if (!isOrbSender(event) || !dragOrigin || typeof dx !== 'number' || typeof dy !== 'number') return
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
      // Free movement while dragging; the clamp to the work area lands on drop.
      anchor = { x: Math.round(dragOrigin.x + dx), y: Math.round(dragOrigin.y + dy) }
      orbWindow?.setBounds({ x: anchor.x, y: anchor.y, width: ORB_SIZE, height: ORB_SIZE })
    })
    ipcMain.on('orb:drag-end', event => {
      if (!isOrbSender(event) || !dragOrigin) return
      dragOrigin = null
      anchor = clampToWorkArea(anchor)
      applyOrbLayout()
      prefs.orbPosition = anchor
      savePreferences()
    })
    ipcMain.on('orb:open-app', (event, section: unknown) => {
      if (!isOrbSender(event)) return
      if (expanded) setExpanded(false)
      showMainWindow(isSection(section) ? section : undefined)
    })
    ipcMain.on('orb:hide', event => {
      if (!isOrbSender(event)) return
      prefs.orbEnabled = false
      savePreferences()
      rebuildTrayMenu()
      updateOrbVisibility()
    })
    ipcMain.on('orb:quit', event => {
      if (isOrbSender(event)) app.quit()
    })
  }

  registerOrbIpc()
  registerSummonShortcut()
  void createTray()
  // Monitors come and go (laptop undocked): keep the orb on a live screen.
  screen.on('display-removed', () => {
    anchor = clampToWorkArea(anchor)
    applyOrbLayout()
  })

  return {
    attachMainWindow: win => {
      mainWindow = win
      win.on('close', event => {
        if (quitting) return
        event.preventDefault()
        if (!prefs.runInBackground) {
          app.quit()
          return
        }
        win.hide()
        notifyOrb({ kind: 'backgrounded' })
      })
      win.on('show', () => {
        mainWindowShown = true
        scheduleOrbVisibility()
      })
      for (const change of ['hide', 'minimize', 'restore'] as const) {
        win.on(change as 'hide', () => scheduleOrbVisibility())
      }
      win.on('closed', () => {
        if (mainWindow === win) mainWindow = null
        scheduleOrbVisibility()
      })
    },
    showMainWindow,
    markQuitting: () => {
      quitting = true
      globalShortcut.unregister(ORB_SUMMON_SHORTCUT.accelerator)
      if (orbWindow && !orbWindow.isDestroyed()) orbWindow.hide()
    },
    keepsRunning: () => !quitting && prefs.runInBackground,
  }
}
