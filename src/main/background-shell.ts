import * as Schema from 'effect/Schema'
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  Menu,
  type NativeImage,
  nativeImage,
  screen,
  Tray,
} from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

import { acceleratorFor, SHORTCUTS } from '../shared/lib/shortcuts.js'
import { type Section, sectionSchema } from '../shared/schemas/navigation.js'
import { ORB_SIZE, type OrbNotice, type OrbPlacement } from '../shared/schemas/orb.js'
import { safeLogOperationalEvent } from './operational-log.js'
import { clampToWorkArea, defaultOrbPosition, orbLayout, type Point } from './orb-geometry.js'
import { loadShellPreferences, saveShellPreferences } from './shell-preferences.js'

/**
 * The background shell: what keeps Watchtower alive once its window is
 * closed. Closing the main window hides it instead of quitting (the db-worker
 * keeps scanning on its cadence), a tray icon offers Open / Summon / Scan /
 * Quit, and a small always-on-top "orb" floats on the desktop — draggable,
 * with a spend panel that can reopen the full app on a section. The registry's
 * global `summonOrb` shortcut (ADR 0001) brings it back even after both the
 * window and the orb were dismissed.
 *
 * The orb is shown only while the main window is not (hidden or minimized):
 * with the full app on screen it would just be clutter. It never takes focus
 * on its own — only the summon shortcut, an explicit request, focuses it.
 */

const isSection = Schema.is(sectionSchema)

/** The registry's OS-wide summon shortcut, as an Electron accelerator. */
const SUMMON_ACCELERATOR = (() => {
  const def = SHORTCUTS.find(entry => entry.action === 'summonOrb' && entry.scope === 'global')
  return def ? acceleratorFor(def.hotkey) : null
})()

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

/** Runs `show` now, or once the window's page can paint. */
function showWhenReady(win: BrowserWindow, show: () => void): void {
  if (win.webContents.isLoading()) win.once('ready-to-show', show)
  else show()
}

export function createBackgroundShell(options: BackgroundShellOptions): BackgroundShell {
  const prefsFile = join(app.getPath('userData'), 'shell-preferences.json')
  const prefs = loadShellPreferences(prefsFile)
  const savePreferences = (): void => saveShellPreferences(prefsFile, prefs)
  let mainWindow: BrowserWindow | null = null
  let orbWindow: BrowserWindow | null = null
  let tray: Tray | null = null
  let quitting = false
  let anchor: Point = clampToWorkArea(prefs.orbPosition ?? defaultOrbPosition())
  let expanded = false
  let dragOrigin: Point | null = null
  /** A notice raised before the orb page could listen (pulled on mount). */
  let pendingNotice: OrbNotice | null = null
  /** The "still watching" peek explains the orb once per session, on the
   * first close to the tray — not on every close. */
  let backgroundedNoticeSent = false
  /** The orb is about the app being *away*: never float it during boot,
   * before the main window has been on screen once. */
  let mainWindowShown = false
  let visibilityTimer: NodeJS.Timeout | null = null

  function mainWindowAway(): boolean {
    return !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()
  }

  function liveOrb(): BrowserWindow | null {
    return orbWindow && !orbWindow.isDestroyed() ? orbWindow : null
  }

  function isOrbSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return event.sender === liveOrb()?.webContents
  }

  function applyOrbLayout(): OrbPlacement {
    const { bounds, placement } = orbLayout(anchor, expanded)
    const orb = liveOrb()
    if (orb) {
      orb.setBounds(bounds)
      orb.webContents.send('orb:placement', placement)
    }
    return placement
  }

  function setExpanded(next: boolean): OrbPlacement {
    expanded = next
    return applyOrbLayout()
  }

  function ensureOrbWindow(): BrowserWindow {
    const existing = liveOrb()
    if (existing) return existing
    const win = new BrowserWindow({
      ...orbLayout(anchor, false).bounds,
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
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    win.setAlwaysOnTop(true, 'floating')
    // macOS: follow the user across Spaces and over full-screen apps.
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
      if (win.isVisible()) return
      // Keep `expanded` as it stands: a notice may already have asked to
      // unfold while the orb was still hidden (it is reset on hide, below).
      applyOrbLayout()
      showWhenReady(win, () => win.showInactive())
    } else {
      const orb = liveOrb()
      if (!orb?.isVisible()) return
      expanded = false
      orb.hide()
    }
  }

  function notifyOrb(notice: OrbNotice): void {
    if (!prefs.orbEnabled) return
    const orb = liveOrb()
    // The orb may not exist yet (the window's `hide` event can land after
    // this call) or may still be loading: hold the notice until it can listen.
    if (!orb || orb.webContents.isLoading()) pendingNotice = notice
    else orb.webContents.send('orb:notice', notice)
  }

  /** The main window navigates itself (`navigateToSection`): only the
   * section name crosses the wire, never a route path. The window is hidden,
   * never destroyed, while the app runs, so recreating it is a crash fallback
   * that simply opens on its default route. */
  function showMainWindow(section?: Section): void {
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
   * - the orb panel is already open → open the full app (press twice);
   * - otherwise → float the orb, unfold its panel and focus it, so Escape or
   *   a click elsewhere folds it again. Summoning a hidden orb turns
   *   "Show floating orb" back on: pressing it is asking for the orb. */
  function summon(): void {
    if (!mainWindowAway()) {
      showMainWindow()
      return
    }
    if (expanded && liveOrb()?.isVisible()) {
      setExpanded(false)
      showMainWindow()
      return
    }
    mainWindowShown = true
    if (!prefs.orbEnabled) setOrbEnabled(true)
    else updateOrbVisibility()
    const win = ensureOrbWindow()
    showWhenReady(win, () => {
      win.show()
      win.focus()
    })
    notifyOrb({ kind: 'summoned' })
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
      liveOrb()?.setBounds({ ...anchor, width: ORB_SIZE, height: ORB_SIZE })
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
      if (isOrbSender(event)) setOrbEnabled(false)
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
        if (!backgroundedNoticeSent) {
          backgroundedNoticeSent = true
          notifyOrb({ kind: 'backgrounded' })
        }
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
      if (SUMMON_ACCELERATOR) globalShortcut.unregister(SUMMON_ACCELERATOR)
      liveOrb()?.hide()
    },
    keepsRunning: () => !quitting && prefs.runInBackground,
  }
}
