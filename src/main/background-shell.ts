import * as Schema from 'effect/Schema'
import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
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
import type { OrbNotice, OrbPlacement } from '../shared/schemas/orb.js'
import { logCodeFor, safeLogOperationalEvent } from './operational-log.js'
import { clampToWorkArea, defaultOrbPosition, orbBounds, panelLayout, type Point } from './orb-geometry.js'
import { loadShellPreferences, saveShellPreferences } from './shell-preferences.js'

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
  /** Folder holding the built renderer pages (`index.html`, `orb*.html`). */
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

function live(win: BrowserWindow | null): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null
}

export function createBackgroundShell(options: BackgroundShellOptions): BackgroundShell {
  const prefsFile = join(app.getPath('userData'), 'shell-preferences.json')
  const prefs = loadShellPreferences(prefsFile)
  const savePreferences = (): void => saveShellPreferences(prefsFile, prefs)
  let mainWindow: BrowserWindow | null = null
  let orbWindow: BrowserWindow | null = null
  let panelWindow: BrowserWindow | null = null
  let tray: Tray | null = null
  let quitting = false
  let anchor: Point = clampToWorkArea(prefs.orbPosition ?? defaultOrbPosition())
  let expanded = false
  let dragOrigin: Point | null = null
  /** A notice raised before the panel page could listen (pulled on mount). */
  let pendingNotice: OrbNotice | null = null
  /** The "still watching" peek explains the orb once per session, on the
   * first close to the tray while the orb is on — not on every close. */
  let backgroundedNoticeSent = false
  /** The orb is about the app being *away*: never float it during boot,
   * before the main window has been on screen once. */
  let mainWindowShown = false
  let visibilityTimer: NodeJS.Timeout | null = null

  function mainWindowAway(): boolean {
    return !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()
  }

  /** Either orb window (the orb or its panel). */
  function isOrbSurface(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return event.sender === live(orbWindow)?.webContents || event.sender === live(panelWindow)?.webContents
  }

  /** The orb window itself — the only one that drags. */
  function isOrbSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return event.sender === live(orbWindow)?.webContents
  }

  function broadcastPlacement(placement: OrbPlacement): void {
    for (const win of [live(orbWindow), live(panelWindow)]) win?.webContents.send('orb:placement', placement)
  }

  /** Opens or folds the panel window beside the orb. `focus` is for the
   * user's own requests (a click, the summon shortcut); a peek opens inactive. */
  function setExpanded(next: boolean, focus = false): OrbPlacement {
    const panel = live(panelWindow)
    // The panel only ever opens next to a visible orb.
    expanded = next && !!panel && !!live(orbWindow)?.isVisible()
    const { bounds, placement } = panelLayout(anchor, expanded)
    if (panel && expanded) {
      panel.setBounds(bounds)
      if (focus) {
        panel.show()
        panel.focus()
      } else if (!panel.isVisible()) {
        panel.showInactive()
      }
    } else if (panel?.isVisible()) {
      panel.hide()
    }
    broadcastPlacement(placement)
    return placement
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
    // Clicking anywhere else folds the panel — except a click on the orb,
    // whose own toggle decides (else it would fold and instantly reopen).
    panel.on('blur', () => {
      setTimeout(() => {
        if (expanded && BrowserWindow.getFocusedWindow() !== live(orbWindow)) setExpanded(false)
      }, 0)
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
    if (visibilityTimer) clearTimeout(visibilityTimer)
    visibilityTimer = setTimeout(() => {
      visibilityTimer = null
      updateOrbVisibility()
    }, 150)
  }

  function updateOrbVisibility(): void {
    const wanted = prefs.orbEnabled && !quitting && mainWindowShown && mainWindowAway()
    if (wanted) {
      const orb = ensureSurfaces()
      if (orb.isVisible()) return
      orb.setBounds(orbBounds(anchor))
      showWhenReady(orb, () => orb.showInactive())
    } else if (live(orbWindow)?.isVisible()) {
      if (expanded) setExpanded(false)
      live(orbWindow)?.hide()
    }
  }

  function notifyPanel(notice: OrbNotice): void {
    if (!prefs.orbEnabled) return
    const panel = live(panelWindow)
    // The panel may not exist yet (the window's `hide` event can land after
    // this call) or may still be loading: hold the notice until it can listen.
    if (!panel || panel.webContents.isLoading()) pendingNotice = notice
    else panel.webContents.send('orb:notice', notice)
  }

  /** The main window navigates itself (`navigateToSection`): only the
   * section name crosses the wire, never a route path. The window is hidden,
   * never destroyed, while the app runs, so recreating it is a crash fallback
   * that opens on its default route (the requested section is not replayed). */
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
   * - the panel is already open → open the full app (press twice);
   * - otherwise → float the orb and have the panel open focused, so Escape
   *   or a click elsewhere folds it again. Summoning a hidden orb turns
   *   "Show floating orb" back on: pressing it is asking for the orb. */
  function summon(): void {
    if (!mainWindowAway()) {
      showMainWindow()
      return
    }
    if (expanded && live(panelWindow)?.isVisible()) {
      setExpanded(false)
      showMainWindow()
      return
    }
    mainWindowShown = true
    if (!prefs.orbEnabled) setOrbEnabled(true)
    else updateOrbVisibility()
    notifyPanel({ kind: 'summoned' })
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
    ipcMain.handle('orb:placement:get', event => (isOrbSurface(event) ? panelLayout(anchor, expanded).placement : null))
    // Pulled by the panel page once its listeners are live: a push on
    // `did-finish-load` can land before React has subscribed.
    ipcMain.handle('orb:notice:take', event => {
      if (!isOrbSurface(event)) return null
      const notice = pendingNotice
      pendingNotice = null
      return notice
    })
    ipcMain.handle('orb:expanded:set', (event, next: unknown, focus: unknown) =>
      isOrbSurface(event) ? setExpanded(next === true, focus === true) : null,
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
      live(orbWindow)?.setBounds(orbBounds(anchor))
    })
    ipcMain.on('orb:drag-end', event => {
      if (!isOrbSender(event) || !dragOrigin) return
      dragOrigin = null
      anchor = clampToWorkArea(anchor)
      live(orbWindow)?.setBounds(orbBounds(anchor))
      broadcastPlacement(panelLayout(anchor, expanded).placement)
      prefs.orbPosition = anchor
      savePreferences()
    })
    ipcMain.on('orb:open-app', (event, section: unknown) => {
      if (!isOrbSurface(event)) return
      if (expanded) setExpanded(false)
      showMainWindow(isSection(section) ? section : undefined)
    })
    ipcMain.on('orb:hide', event => {
      if (isOrbSurface(event)) setOrbEnabled(false)
    })
    ipcMain.on('orb:quit', event => {
      if (isOrbSurface(event)) app.quit()
    })
  }

  registerOrbIpc()
  registerSummonShortcut()
  // No tray (a headless session, no notification area) must not break the
  // shell: the orb and the summon shortcut still work without one.
  createTray().catch(err => {
    safeLogOperationalEvent('warn', 'shell.tray-unavailable', { code: logCodeFor(err, 'tray-failed') })
  })
  // Monitors come and go (laptop undocked): keep the orb on a live screen.
  screen.on('display-removed', () => {
    anchor = clampToWorkArea(anchor)
    live(orbWindow)?.setBounds(orbBounds(anchor))
    setExpanded(expanded)
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
        // "Once" means once it can be seen: with the orb off, nothing is spent.
        if (!backgroundedNoticeSent && prefs.orbEnabled) {
          backgroundedNoticeSent = true
          notifyPanel({ kind: 'backgrounded' })
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
      live(panelWindow)?.hide()
      live(orbWindow)?.hide()
    },
    keepsRunning: () => !quitting && prefs.runInBackground,
  }
}
