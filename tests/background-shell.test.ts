import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import { app, BrowserWindow, globalShortcut, ipcMain, screen, Tray } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BackgroundShell, backgroundShellLayer } from '../src/platform/electron/main/background-shell.js'
import { type ShellEvent, ShellRpcError } from '../src/shared/rpc/shell.js'

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

vi.mock('../src/platform/electron/main/shell-preferences.js', async () => {
  const actual = await vi.importActual<typeof import('../src/platform/electron/main/shell-preferences.js')>(
    '../src/platform/electron/main/shell-preferences.js',
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

function captureShellEvents(
  runtime: ManagedRuntime.ManagedRuntime<BackgroundShell | TestClock.TestClock, never>,
  shell: import('../src/platform/electron/main/background-shell.js').BackgroundShellHandle,
  sender: Electron.WebContents,
): { events: ShellEvent[]; stop: () => Promise<void> } {
  const events: ShellEvent[] = []
  const fiber = runtime.runFork(Stream.runForEach(shell.events(sender), event => Effect.sync(() => events.push(event))))
  return { events, stop: () => runtime.runPromise(Fiber.interrupt(fiber)) }
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

  it('removes shell event, screen and main-window listeners and pending readiness work on disposal', async () => {
    const { runtime, main, advance } = await startShell()
    surfaces.loading = true
    main.close()
    await advance(150)
    const orb = surfaces.windows[1]
    expect(orb.listenerCount('ready-to-show')).toBe(1)
    await runtime.dispose()
    for (const channel of [
      'orb:panel-data-ready',
      'orb:panel-painted',
      'orb:panel:request',
      'orb:placement:get',
      'orb:drag-start',
      'orb:drag-move',
      'orb:drag-end',
      'orb:open-app',
      'orb:hide',
      'orb:quit',
      'open-external',
      'open-fda-settings',
      'log:notice',
      'app:navigate',
    ]) {
      expect(ipcMain.listenerCount(channel)).toBe(0)
    }
    expect(screen.listenerCount('display-removed')).toBe(0)
    expect(main.listenerCount('close')).toBe(0)
    expect(orb.listenerCount('ready-to-show')).toBe(0)
    expect(orb.isDestroyed()).toBe(true)
    expect(surfaces.windows[2].isDestroyed()).toBe(true)
  })

  it('retains a first-close explanation when data arrives after the main window returned', async () => {
    const { shell, runtime, main, advance } = await startShell()
    main.close()
    await advance(150)
    const [orb, panel] = surfaces.windows.slice(1)
    const shellEvents = captureShellEvents(runtime, shell, panel.webContents)
    await vi.waitFor(() => expect(shellEvents.events[0]).toEqual({ _tag: 'Ready', placement: expect.any(Object) }))
    shell.showMainWindow()
    await advance(150)
    shell.command(panel.webContents, { _tag: 'PanelDataReady' })
    expect(panel.isVisible()).toBe(false)
    main.close()
    await advance(150)
    expect(orb.isVisible()).toBe(true)
    expect(panel.isVisible()).toBe(true)
    await vi.waitFor(() =>
      expect(shellEvents.events).toContainEqual({
        _tag: 'Placement',
        placement: expect.objectContaining({ expanded: true, peek: true }),
      }),
    )
    await advance(200)
    await advance(6000)
    expect(panel.isVisible()).toBe(false)
    shell.showMainWindow()
    await advance(150)
    main.close()
    await advance(150)
    expect(panel.isVisible()).toBe(false)
    await shellEvents.stop()
  })

  it('holds a hovered peek, then folds it on the next clock-controlled recheck', async () => {
    const { shell, main, advance } = await startShell()
    main.close()
    await advance(150)
    const [, panel] = surfaces.windows.slice(1)
    shell.command(panel.webContents, { _tag: 'PanelDataReady' })
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
    shell.command(panel.webContents, { _tag: 'PanelDataReady' })
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

  it('enforces beacon drag and panel paint/data-ready roles for RPC commands', async () => {
    const { shell, main, advance } = await startShell()
    main.close()
    await advance(150)
    const [orb, panel] = surfaces.windows.slice(1)

    expect(() => shell.command(panel.webContents, { _tag: 'DragStart' })).toThrow(
      expect.objectContaining({ _tag: 'ShellRpcError', code: 'unauthorized' }),
    )
    expect(() => shell.command(orb.webContents, { _tag: 'PanelPainted' })).toThrow(
      expect.objectContaining({ _tag: 'ShellRpcError', code: 'unauthorized' }),
    )
    expect(() => shell.command(orb.webContents, { _tag: 'PanelDataReady' })).toThrow(
      expect.objectContaining({ _tag: 'ShellRpcError', code: 'unauthorized' }),
    )

    expect(() => shell.command(orb.webContents, { _tag: 'DragStart' })).not.toThrow()
    expect(() => shell.command(orb.webContents, { _tag: 'DragEnd' })).not.toThrow()
    await advance(0)
  })

  it('sends Ready before section navigation and releases the event listener on interruption', async () => {
    const { shell, runtime, main } = await startShell()
    const shellEvents = captureShellEvents(runtime, shell, main.webContents)
    await vi.waitFor(() => expect(shellEvents.events[0]).toEqual({ _tag: 'Ready', placement: null }))

    shell.showMainWindow('models')
    await vi.waitFor(() => expect(shellEvents.events[1]).toEqual({ _tag: 'Navigate', section: 'models' }))
    expect(shellEvents.events.slice(0, 2)).toEqual([
      { _tag: 'Ready', placement: null },
      { _tag: 'Navigate', section: 'models' },
    ])

    const countBeforeInterruption = shellEvents.events.length
    await shellEvents.stop()
    shell.showMainWindow('sessions')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(shellEvents.events).toHaveLength(countBeforeInterruption)
  })

  it('fails a shell event subscriber that exceeds its bounded navigation queue', async () => {
    const { shell, runtime, main } = await startShell()
    let resolveReady!: () => void
    let releaseReady!: () => void
    const ready = new Promise<void>(resolve => (resolveReady = resolve))
    const held = new Promise<void>(resolve => (releaseReady = resolve))
    const events = shell.events(main.webContents).pipe(
      Stream.tap(event =>
        event._tag === 'Ready'
          ? Effect.promise(() => {
              resolveReady()
              return held
            })
          : Effect.void,
      ),
    )
    const collecting = runtime.runPromise(Stream.runCollect(events))
    await ready
    for (let index = 0; index < 300; index++) shell.showMainWindow('models')
    releaseReady()

    await expect(collecting).rejects.toMatchObject(
      new ShellRpcError({ code: 'lagged', message: 'Shell subscriber fell behind' }),
    )
  })
})
