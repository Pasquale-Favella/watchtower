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
import { orbPanelRequestSchema, type OrbPlacement } from '../shared/schemas/orb.js'
import { logCodeFor, safeLogOperationalEvent } from './operational-log.js'
import { clampToWorkArea, defaultOrbPosition, orbBounds, panelLayout } from './orb-geometry.js'
import { containsPoint, createHeldRequest, createPeekGate, offsetAnchor, type Point } from './orb-policy.js'
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

/** Runs `show` once the window's page can paint — or after a fallback, so a
 * page that never reports ready cannot leave the window unshown forever. */
function showWhenReady(win: BrowserWindow, show: () => void): void {
  if (!win.webContents.isLoading()) {
    show()
    return
  }
  let done = false
  const once = (): void => {
    if (done || win.isDestroyed()) return
    done = true
    clearTimeout(fallback)
    show()
  }
  const fallback = setTimeout(once, READY_FALLBACK_MS)
  win.once('ready-to-show', once)
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
  /** The panel is open (or opening — see revealPanel). */
  let expanded = false
  /** The open is the first-close peek: inactive, with its note, folding on
   * its own until the user interacts with it. */
  let peeking = false
  let peekTimer: NodeJS.Timeout | null = null
  let dragOrigin: Point | null = null
  /** The first-close peek: once per session, once the close and the panel's
   * data have both happened. */
  const peekGate = createPeekGate()
  /** An open asked for while the orb is still on its way to the screen: applied
   * when the orb shows, unless it has gone stale meanwhile. */
  const heldOpen = createHeldRequest<PanelMode>(HELD_OPEN_TTL_MS)
  /** The orb is about the app being *away*: never float it during boot,
   * before the main window has been on screen once. */
  let mainWindowShown = false
  let visibilityTimer: NodeJS.Timeout | null = null
  /** Set while the panel is shown but still transparent (see revealPanel). */
  let revealTimer: NodeJS.Timeout | null = null

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
    if (peekTimer) clearTimeout(peekTimer)
    peekTimer = null
  }

  /** The peek folds on its own — but not from under a pointer resting on it. */
  function schedulePeekFold(delayMs: number): void {
    clearPeekTimer()
    peekTimer = setTimeout(() => {
      peekTimer = null
      if (!peeking) return
      const panel = live(panelWindow)
      if (panel && containsPoint(panel.getBounds(), screen.getCursorScreenPoint())) {
        schedulePeekFold(PEEK_RECHECK_MS)
        return
      }
      applyPanel(false)
    }, delayMs)
  }

  function finishReveal(): void {
    if (revealTimer) clearTimeout(revealTimer)
    revealTimer = null
    live(panelWindow)?.setOpacity(1)
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
    showWhenReady(panel, () => {
      // Folded or quitting while the page got ready: show nothing.
      if (!expanded || quitting || panel.isDestroyed()) return
      if (focus) {
        panel.show()
        panel.focus()
      } else {
        panel.showInactive()
      }
      if (revealTimer) clearTimeout(revealTimer)
      revealTimer = setTimeout(finishReveal, REVEAL_FALLBACK_MS)
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
    if (peeking) schedulePeekFold(PEEK_MS)
    if (panel && expanded) {
      panel.setBounds(panelLayout(anchor, true).bounds)
      if (!panel.isVisible()) revealPanel(panel, mode === 'open')
      else if (mode === 'open') panel.focus()
    } else {
      heldOpen.clear()
      if (revealTimer) clearTimeout(revealTimer)
      revealTimer = null
      if (panel?.isVisible()) panel.hide()
    }
    return broadcastPlacement()
  }

  /** Opens the panel as `mode` — beside a visible orb. One that arrives while
   * the orb is still on its way is held and applied when it shows. */
  function openPanel(mode: PanelMode): OrbPlacement {
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
    if (visibilityTimer) clearTimeout(visibilityTimer)
    visibilityTimer = setTimeout(() => {
      visibilityTimer = null
      updateOrbVisibility()
    }, 150)
  }

  function updateOrbVisibility(): void {
    if (orbWanted()) {
      const orb = ensureSurfaces()
      if (orb.isVisible()) return
      orb.setBounds(orbBounds(anchor))
      showWhenReady(orb, () => {
        if (!orbWanted()) return // the app came back while the orb was loading
        orb.showInactive()
        // An open that arrived while the orb was on its way (if still fresh).
        const mode = heldOpen.take()
        if (mode) applyPanel(true, mode)
      })
    } else {
      heldOpen.clear()
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

  async function createTray(): Promise<void> {
    tray = new Tray(await trayIcon(options.iconPath))
    tray.setToolTip('Watchtower')
    // Windows/Linux: a left click opens the app; the menu stays on right click.
    // macOS opens the context menu on click, as menu-bar items do.
    if (process.platform !== 'darwin') tray.on('click', () => showMainWindow())
    rebuildTrayMenu()
  }

  function registerOrbIpc(): void {
    ipcMain.handle('orb:placement:get', event => (isOrbSurface(event) ? currentPlacement() : null))
    ipcMain.handle('orb:panel:request', (event, request: unknown) => {
      if (!isOrbSurface(event) || !isPanelRequest(request)) return null
      return request === 'fold' ? applyPanel(false) : openPanel('open')
    })
    // The panel's data is in: the first-close peek may open now (once).
    ipcMain.on('orb:panel-data-ready', event => {
      if (isPanelSender(event) && peekGate.dataReady()) openPanel('peek')
    })
    ipcMain.on('orb:drag-start', event => {
      if (!isOrbSender(event)) return
      // The panel is anchored to the orb: a drag folds it rather than leave it behind.
      if (expanded) applyPanel(false)
      dragOrigin = { ...anchor }
    })
    ipcMain.on('orb:drag-move', (event, dx: unknown, dy: unknown) => {
      if (!isOrbSender(event) || !dragOrigin || typeof dx !== 'number' || typeof dy !== 'number') return
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
      // Free movement while dragging; the clamp to the work area lands on drop.
      anchor = offsetAnchor(dragOrigin, dx, dy)
      live(orbWindow)?.setBounds(orbBounds(anchor))
    })
    ipcMain.on('orb:drag-end', event => {
      if (!isOrbSender(event) || !dragOrigin) return
      dragOrigin = null
      anchor = clampToWorkArea(anchor)
      live(orbWindow)?.setBounds(orbBounds(anchor))
      broadcastPlacement()
      prefs.orbPosition = anchor
      savePreferences()
    })
    ipcMain.on('orb:open-app', (event, section: unknown) => {
      if (!isOrbSurface(event)) return
      if (expanded) applyPanel(false)
      showMainWindow(isSection(section) ? section : undefined)
    })
    ipcMain.on('orb:hide', event => {
      if (isOrbSurface(event)) setOrbEnabled(false)
    })
    ipcMain.on('orb:quit', event => {
      if (isOrbSurface(event)) app.quit()
    })
    // The panel page painted a fresh frame after opening: reveal it.
    ipcMain.on('orb:panel-painted', event => {
      if (revealTimer && isPanelSender(event)) finishReveal()
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
    if (expanded) live(panelWindow)?.setBounds(panelLayout(anchor, true).bounds)
    broadcastPlacement()
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
        if (prefs.orbEnabled && peekGate.closed()) openPanel('peek')
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
      clearPeekTimer()
      if (SUMMON_ACCELERATOR) globalShortcut.unregister(SUMMON_ACCELERATOR)
      live(panelWindow)?.hide()
      live(orbWindow)?.hide()
    },
    keepsRunning: () => !quitting && prefs.runInBackground,
  }
}
