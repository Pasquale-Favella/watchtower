import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as TestClock from 'effect/testing/TestClock'
import { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BackgroundShell, backgroundShellLayer } from '../src/main/background-shell.js'

const surfaces = vi.hoisted(() => ({ windows: [] as BrowserWindow[], loading: false }))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const image = {
    isEmpty: () => false,
    resize() {
      return this
    },
  }
  class Window extends EventEmitter {
    visible = false
    destroyed = false
    opacity = 1
    bounds = { x: 0, y: 0, width: 64, height: 64 }
    webContents = { isLoading: () => surfaces.loading, send: vi.fn() }
    constructor(options: Partial<Electron.BrowserWindowConstructorOptions> = {}) {
      super()
      this.bounds = { ...this.bounds, ...options }
      surfaces.windows.push(this as unknown as BrowserWindow)
    }
    isDestroyed() {
      return this.destroyed
    }
    isVisible() {
      return this.visible
    }
    isMinimized() {
      return false
    }
    getBounds() {
      return this.bounds
    }
    setBounds(bounds: Electron.Rectangle) {
      this.bounds = bounds
    }
    setOpacity(opacity: number) {
      this.opacity = opacity
    }
    getOpacity() {
      return this.opacity
    }
    show() {
      this.visible = true
      this.emit('show')
    }
    showInactive() {
      this.visible = true
    }
    hide() {
      this.visible = false
      this.emit('hide')
    }
    focus() {
      this.emit('focus')
    }
    restore() {}
    destroy() {
      this.destroyed = true
      this.visible = false
      this.emit('closed')
    }
    close() {
      let prevented = false
      this.emit('close', {
        preventDefault: () => {
          prevented = true
        },
      })
      if (!prevented) this.destroy()
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    loadFile() {
      return Promise.resolve()
    }
    loadURL() {
      return Promise.resolve()
    }
  }
  const ipc = Object.assign(new EventEmitter(), { handle: vi.fn(), removeHandler: vi.fn() })
  return {
    app: { getPath: () => '/unused', getFileIcon: vi.fn(async () => image), quit: vi.fn() },
    BrowserWindow: Window,
    ipcMain: ipc,
    screen: Object.assign(new EventEmitter(), {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }),
      getCursorScreenPoint: vi.fn(() => ({ x: -1000, y: -1000 })),
    }),
    globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
    Menu: { buildFromTemplate: vi.fn(template => template) },
    Tray: vi.fn(function () {
      return { setToolTip: vi.fn(), setContextMenu: vi.fn(), on: vi.fn(), destroy: vi.fn() }
    }),
    nativeImage: { createEmpty: () => ({ isEmpty: () => true }), createFromPath: () => image },
  }
})

vi.mock('../src/main/shell-preferences.js', async () => {
  const actual = await vi.importActual<typeof import('../src/main/shell-preferences.js')>(
    '../src/main/shell-preferences.js',
  )
  return {
    ...actual,
    loadShellPreferences: () => Effect.succeed({ ...actual.DEFAULT_SHELL_PREFERENCES }),
    saveShellPreferences: () => Effect.void,
  }
})

const runtimes: Array<ManagedRuntime.ManagedRuntime<BackgroundShell | TestClock.TestClock, never>> = []
async function startShell() {
  const runtime = ManagedRuntime.make(
    backgroundShellLayer({
      preloadPath: '/preload.js',
      rendererUrl: undefined,
      rendererDir: '/renderer',
      iconPath: null,
      createMainWindow: () => new BrowserWindow(),
      requestScan: vi.fn(),
    }).pipe(Layer.provideMerge(TestClock.layer())),
  )
  runtimes.push(runtime)
  const shell = await runtime.runPromise(BackgroundShell)
  const main = new BrowserWindow()
  shell.attachMainWindow(main)
  main.show()
  const advance = (milliseconds: number) => runtime.runPromise(TestClock.adjust(milliseconds))
  return { runtime, shell, main, advance }
}

beforeEach(() => {
  surfaces.windows = []
  surfaces.loading = false
  vi.clearAllMocks()
})
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
})

describe('main-scoped background shell', () => {
  it('does not acquire a tray after shutdown interrupts pending icon loading', async () => {
    let resolveIcon!: (image: Electron.NativeImage) => void
    vi.mocked(app.getFileIcon).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveIcon = resolve
        }),
    )
    const { shell, runtime } = await startShell()
    shell.markQuitting()
    await runtime.dispose()
    resolveIcon({ isEmpty: () => true } as Electron.NativeImage)
    await Promise.resolve()
    expect(Tray).not.toHaveBeenCalled()
    expect(globalShortcut.unregister).toHaveBeenCalledOnce()
  })

  it('removes IPC, screen and main-window listeners and pending readiness work on disposal', async () => {
    const { runtime, main, advance } = await startShell()
    surfaces.loading = true
    main.close()
    await advance(150)
    const orb = surfaces.windows[1]
    expect(orb.listenerCount('ready-to-show')).toBe(1)
    await runtime.dispose()
    expect(ipcMain.listenerCount('orb:panel-data-ready')).toBe(0)
    expect(screen.listenerCount('display-removed')).toBe(0)
    expect(main.listenerCount('close')).toBe(0)
    expect(orb.listenerCount('ready-to-show')).toBe(0)
    expect(orb.isDestroyed()).toBe(true)
    expect(surfaces.windows[2].isDestroyed()).toBe(true)
  })

  it('retains a first-close explanation when data arrives after the main window returned', async () => {
    const { shell, main, advance } = await startShell()
    main.close()
    await advance(150)
    const [orb, panel] = surfaces.windows.slice(1)
    shell.showMainWindow()
    await advance(150)
    ipcMain.emit('orb:panel-data-ready', { sender: panel.webContents })
    expect(panel.isVisible()).toBe(false)
    main.close()
    await advance(150)
    expect(orb.isVisible()).toBe(true)
    expect(panel.isVisible()).toBe(true)
    expect(vi.mocked(panel.webContents.send).mock.calls.at(-1)).toEqual([
      'orb:placement',
      expect.objectContaining({ expanded: true, peek: true }),
    ])
    await advance(200)
    await advance(6000)
    expect(panel.isVisible()).toBe(false)
    shell.showMainWindow()
    await advance(150)
    main.close()
    await advance(150)
    expect(panel.isVisible()).toBe(false)
  })

  it('holds a hovered peek, then folds it on the next clock-controlled recheck', async () => {
    const { main, advance } = await startShell()
    main.close()
    await advance(150)
    const panel = surfaces.windows[2]
    ipcMain.emit('orb:panel-data-ready', { sender: panel.webContents })
    await advance(200)
    const bounds = panel.getBounds()
    vi.mocked(screen.getCursorScreenPoint).mockReturnValueOnce({ x: bounds.x + 1, y: bounds.y + 1 })
    await advance(6000)
    expect(panel.isVisible()).toBe(true)
    await advance(1000)
    expect(panel.isVisible()).toBe(false)
  })

  it('does not consume the explanation when the app returns during the transparent reveal', async () => {
    const { main, shell, advance } = await startShell()
    main.close()
    await advance(150)
    const panel = surfaces.windows[2]
    ipcMain.emit('orb:panel-data-ready', { sender: panel.webContents })
    expect(panel.getOpacity()).toBe(0)
    shell.showMainWindow()
    await advance(150)
    await advance(200)
    main.close()
    await advance(150)
    expect(panel.isVisible()).toBe(true)
    await advance(200)
    await advance(6000)
    expect(panel.isVisible()).toBe(false)
  })

  it('destroys an acquired tray exactly once when the owner closes', async () => {
    const { runtime } = await startShell()
    await vi.waitFor(() => expect(Tray).toHaveBeenCalledOnce())
    const tray = vi.mocked(Tray).mock.results[0].value as Tray
    await runtime.dispose()
    await runtime.dispose()
    expect(tray.destroy).toHaveBeenCalledOnce()
  })
})
