import type { WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  views: [] as Array<{
    readonly options: { webPreferences: Record<string, unknown> }
    readonly webContents: {
      emit: (name: string, ...args: unknown[]) => boolean
      popup: ((details: { url: string }) => { action: string }) | null
      close: () => void
      closed: boolean
    }
    visible: boolean
  }>,
  permissionCheck: vi.fn(),
  permissionRequest: vi.fn(),
  openExternal: vi.fn(),
  window: null as unknown,
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Contents extends EventEmitter {
    url = ''
    closed = false
    popup: ((details: { url: string }) => { action: string }) | null = null
    readonly navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: vi.fn(),
      goForward: vi.fn(),
    }
    async loadURL(url: string): Promise<void> {
      this.url = url
    }
    getURL(): string {
      return this.url
    }
    getTitle(): string {
      return 'Browser page'
    }
    isDestroyed(): boolean {
      return this.closed
    }
    isLoading(): boolean {
      return false
    }
    isAudioMuted(): boolean {
      return false
    }
    getZoomFactor(): number {
      return 1
    }
    setWindowOpenHandler(handler: typeof this.popup): void {
      this.popup = handler
    }
    close(): void {
      this.closed = true
    }
  }
  class NativeView {
    readonly webContents = new Contents()
    visible = false
    constructor(readonly options: { webPreferences: Record<string, unknown> }) {
      fake.views.push(this)
    }
    setVisible(visible: boolean): void {
      this.visible = visible
    }
    setBounds(): void {}
  }
  return {
    WebContentsView: NativeView,
    BrowserWindow: { fromWebContents: () => fake.window },
    session: {
      fromPartition: () => ({
        setPermissionCheckHandler: fake.permissionCheck,
        setPermissionRequestHandler: fake.permissionRequest,
      }),
    },
    shell: { openExternal: fake.openExternal },
  }
})

import {
  createElectronWorkspacePreviewManager,
  workspacePreviewWindow,
} from '../src/platform/electron/main/preview/electron-preview.js'
import type { WorkspacePreviewState } from '../src/shared/schemas/workspace-preview.js'

const ref = { ownerKey: 'draft-browser', tabId: 'one' }

async function harness() {
  const { EventEmitter } = await import('node:events')
  const window = Object.assign(new EventEmitter(), {
    id: 42,
    isDestroyed: () => false,
    getContentSize: () => [1200, 800],
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  })
  fake.window = window
  const sender = new EventEmitter() as unknown as WebContents
  const manager = createElectronWorkspacePreviewManager()
  const host = workspacePreviewWindow(manager, sender)
  const states: WorkspacePreviewState[] = []
  manager.open(host, { ...ref, url: 'http://localhost:3000/' })
  manager.subscribe(host, ref, state => states.push(state))
  await Promise.resolve()
  const view = fake.views[0]
  if (!view) throw new Error('Browser native view was not created')
  return { window, sender, manager, host, states, view }
}

beforeEach(() => {
  fake.views.length = 0
  vi.clearAllMocks()
})

describe('native browser isolation', () => {
  it('uses a separate browser session with sandbox and no Node or embedded webviews', async () => {
    const { view, manager } = await harness()
    expect(view.options.webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    })
    const check = fake.permissionCheck.mock.calls[0]?.[0] as (_contents: unknown, permission: string) => boolean
    expect(check(null, 'media')).toBe(false)
    expect(check(null, 'clipboard-read')).toBe(false)
    expect(check(null, 'clipboard-sanitized-write')).toBe(true)
    manager.dispose()
  })
  it('blocks privileged frame navigation and redirects', async () => {
    const { view, manager } = await harness()
    for (const name of ['will-frame-navigate', 'will-redirect']) {
      const blocked = { url: 'file:///C:/private.txt', preventDefault: vi.fn() }
      view.webContents.emit(name, blocked)
      expect(blocked.preventDefault).toHaveBeenCalledOnce()
      const allowed = { url: 'http://localhost:3000/app', preventDefault: vi.fn() }
      view.webContents.emit(name, allowed)
      expect(allowed.preventDefault).not.toHaveBeenCalled()
    }
    manager.dispose()
  })
  it('denies native popup windows and requests a normal panel tab instead', async () => {
    const { view, states, manager } = await harness()
    expect(view.webContents.popup?.({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })
    expect(states.at(-1)?.popupSequence).toBe(0)
    expect(view.webContents.popup?.({ url: 'https://example.com/' })).toEqual({ action: 'deny' })
    expect(states.at(-1)).toMatchObject({ popupSequence: 1, popupUrl: 'https://example.com/' })
    manager.dispose()
  })
  it('bridges app shortcuts while the native page has keyboard focus', async () => {
    const { view, states, manager } = await harness()
    const event = { preventDefault: vi.fn() }
    const modifier = process.platform === 'darwin' ? { meta: true, control: false } : { meta: false, control: true }
    view.webContents.emit('before-input-event', event, {
      type: 'keyDown',
      key: 'l',
      ...modifier,
      alt: false,
      shift: false,
    })
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(states.at(-1)).toMatchObject({ shortcut: 'address', shortcutSequence: 1 })
    view.webContents.emit('before-input-event', event, {
      type: 'keyDown',
      key: 'Tab',
      ...modifier,
      alt: false,
      shift: true,
    })
    expect(states.at(-1)).toMatchObject({ shortcut: 'previous-tab', shortcutSequence: 2 })
    manager.dispose()
  })
  it('hides native pages on app reload and destroys them when their owning window closes', async () => {
    const { view, window, sender, manager, host } = await harness()
    manager.layout(host, { ...ref, bounds: { x: 600, y: 80, width: 500, height: 650 }, visible: true })
    expect(view.visible).toBe(true)
    sender.emit('did-start-loading')
    expect(view.visible).toBe(false)
    window.emit('closed')
    expect(view.webContents.closed).toBe(true)
    expect(window.contentView.removeChildView).toHaveBeenCalledOnce()
  })
})
