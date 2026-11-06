import { workspacePreviewMessages, WorkspacePreviewRpcError } from '@/shared/rpc/workspace-preview.js'
import {
  normalizeWorkspacePreviewUrl,
  type WorkspacePreviewBounds,
  type WorkspacePreviewCommand,
  type WorkspacePreviewLayout,
  type WorkspacePreviewNavigate,
  type WorkspacePreviewOpen,
  type WorkspacePreviewRef,
  type WorkspacePreviewShortcut,
  type WorkspacePreviewState,
  type WorkspacePreviewCapture,
} from '@/shared/schemas/workspace-preview.js'

export interface WorkspacePreviewView {
  readonly nativeView: unknown
  readonly loadURL: (url: string) => Promise<void>
  readonly setBounds: (bounds: WorkspacePreviewBounds) => void
  readonly setVisible: (visible: boolean) => void
  readonly snapshot: () => Pick<
    WorkspacePreviewState,
    'url' | 'title' | 'loading' | 'canGoBack' | 'canGoForward' | 'muted' | 'zoomFactor'
  >
  readonly command: (action: WorkspacePreviewCommand['action']) => Promise<void>
  readonly subscribe: (
    changed: () => void,
    failed: () => void,
    popup: (url: string) => void,
    shortcut: (action: WorkspacePreviewShortcut) => void,
  ) => () => void
  readonly destroy: () => void
  readonly capture?: (() => Promise<WorkspacePreviewCapture>) | undefined
}

export interface WorkspacePreviewWindow {
  readonly id: number
  readonly contentSize: () => { readonly width: number; readonly height: number }
  readonly attach: (view: WorkspacePreviewView) => void
  readonly detach: (view: WorkspacePreviewView) => void
}

export interface WorkspacePreviewAdapter {
  readonly createView: () => WorkspacePreviewView
}

interface BrowserTab {
  readonly host: WorkspacePreviewWindow
  readonly view: WorkspacePreviewView
  readonly listeners: Set<(state: WorkspacePreviewState) => void>
  unsubscribe: () => void
  state: WorkspacePreviewState
  loadGeneration: number
}

const MAX_BROWSER_TABS = 24

function failure(code: WorkspacePreviewRpcError['code']): WorkspacePreviewRpcError {
  return new WorkspacePreviewRpcError({ code, message: workspacePreviewMessages[code] })
}

function key(host: WorkspacePreviewWindow, ref: WorkspacePreviewRef): string {
  return JSON.stringify([host.id, ref.ownerKey, ref.tabId])
}

export function fitWorkspacePreviewBounds(
  bounds: WorkspacePreviewBounds,
  content: { readonly width: number; readonly height: number },
): WorkspacePreviewBounds {
  const x = Math.max(0, Math.min(Math.round(bounds.x), content.width))
  const y = Math.max(0, Math.min(Math.round(bounds.y), content.height))
  return {
    x,
    y,
    width: Math.max(0, Math.min(Math.round(bounds.width), content.width - x)),
    height: Math.max(0, Math.min(Math.round(bounds.height), content.height - y)),
  }
}

/** Owns browser pages independently of the renderer's selected chat and mounted panels. */
export class WorkspacePreviewManager {
  private readonly tabs = new Map<string, BrowserTab>()

  constructor(private readonly adapter: WorkspacePreviewAdapter) {}

  open(host: WorkspacePreviewWindow, request: WorkspacePreviewOpen): WorkspacePreviewState {
    if (request.url && normalizeWorkspacePreviewUrl(request.url) !== request.url) throw failure('invalid-request')
    const existing = this.tabs.get(key(host, request))
    if (existing) return existing.state
    if (this.tabs.size >= MAX_BROWSER_TABS) throw failure('limit-reached')
    const view = this.adapter.createView()
    const tab: BrowserTab = {
      host,
      view,
      listeners: new Set(),
      unsubscribe: () => undefined,
      loadGeneration: 0,
      state: {
        ...request,
        ...view.snapshot(),
        error: null,
        visible: false,
        closed: false,
        popupUrl: null,
        popupSequence: 0,
        shortcut: null,
        shortcutSequence: 0,
      },
    }
    const update = () => {
      if (!tab || tab.state.closed) return
      tab.state = { ...tab.state, ...view.snapshot() }
      this.publish(tab)
    }
    const failed = () => {
      if (!tab || tab.state.closed) return
      tab.state = {
        ...tab.state,
        ...view.snapshot(),
        loading: false,
        error: 'The page could not be loaded. Check the address or start the local server.',
      }
      view.setVisible(false)
      tab.state = { ...tab.state, visible: false }
      this.publish(tab)
    }
    const popup = (url: string) => {
      const normalized = normalizeWorkspacePreviewUrl(url)
      if (!tab || !normalized) return
      tab.state = { ...tab.state, popupUrl: normalized, popupSequence: tab.state.popupSequence + 1 }
      this.publish(tab)
    }
    tab.unsubscribe = view.subscribe(update, failed, popup, action => {
      tab.state = { ...tab.state, shortcut: action, shortcutSequence: tab.state.shortcutSequence + 1 }
      this.publish(tab)
    })
    this.tabs.set(key(host, request), tab)
    host.attach(view)
    view.setVisible(false)
    if (request.url) this.load(tab, request.url)
    return tab.state
  }

  navigate(host: WorkspacePreviewWindow, request: WorkspacePreviewNavigate): WorkspacePreviewState {
    const tab = this.require(host, request)
    const url = normalizeWorkspacePreviewUrl(request.url)
    if (!url) throw failure('invalid-request')
    this.load(tab, url)
    return tab.state
  }

  async command(host: WorkspacePreviewWindow, request: WorkspacePreviewCommand): Promise<WorkspacePreviewState> {
    const tab = this.require(host, request)
    if (request.action === 'reload') tab.state = { ...tab.state, error: null }
    await tab.view.command(request.action)
    tab.state = { ...tab.state, ...tab.view.snapshot() }
    this.publish(tab)
    return tab.state
  }

  async capture(host: WorkspacePreviewWindow, request: WorkspacePreviewRef): Promise<WorkspacePreviewCapture> {
    const tab = this.require(host, request)
    if (!tab.view.capture) throw failure('unavailable')
    return tab.view.capture()
  }

  layout(host: WorkspacePreviewWindow, request: WorkspacePreviewLayout): void {
    const tab = this.require(host, request)
    const bounds = fitWorkspacePreviewBounds(request.bounds, host.contentSize())
    const visible =
      request.visible && !tab.state.error && Boolean(tab.state.url) && bounds.width > 0 && bounds.height > 0
    if (visible) this.hideWindow(host.id, tab)
    tab.view.setBounds(bounds)
    tab.view.setVisible(visible)
    if (tab.state.visible !== visible) {
      tab.state = { ...tab.state, visible }
      this.publish(tab)
    }
  }

  subscribe(
    host: WorkspacePreviewWindow,
    ref: WorkspacePreviewRef,
    listener: (state: WorkspacePreviewState) => void,
  ): () => void {
    const tab = this.require(host, ref)
    tab.listeners.add(listener)
    listener(tab.state)
    return () => tab.listeners.delete(listener)
  }

  close(host: WorkspacePreviewWindow, ref: WorkspacePreviewRef): void {
    const tab = this.tabs.get(key(host, ref))
    if (!tab) return
    this.tabs.delete(key(host, ref))
    tab.state = { ...tab.state, visible: false, closed: true, loading: false }
    this.publish(tab)
    tab.listeners.clear()
    tab.unsubscribe()
    tab.view.setVisible(false)
    tab.host.detach(tab.view)
    tab.view.destroy()
  }

  adoptOwner(host: WorkspacePreviewWindow, ownerKey: string, nextOwnerKey: string): void {
    if (ownerKey === nextOwnerKey) return
    const owned = [...this.tabs.values()].filter(tab => tab.host.id === host.id && tab.state.ownerKey === ownerKey)
    if (owned.some(tab => this.tabs.has(key(host, { ownerKey: nextOwnerKey, tabId: tab.state.tabId }))))
      throw failure('invalid-request')
    for (const tab of owned) {
      this.tabs.delete(key(host, tab.state))
      tab.state = { ...tab.state, ownerKey: nextOwnerKey }
      this.tabs.set(key(host, tab.state), tab)
      this.publish(tab)
    }
  }

  hideWindow(windowId: number, except?: BrowserTab): void {
    for (const tab of this.tabs.values()) {
      if (tab === except || tab.host.id !== windowId || !tab.state.visible) continue
      tab.view.setVisible(false)
      tab.state = { ...tab.state, visible: false }
      this.publish(tab)
    }
  }

  closeWindow(windowId: number): void {
    for (const tab of [...this.tabs.values()]) if (tab.host.id === windowId) this.close(tab.host, tab.state)
  }

  dispose(): void {
    for (const tab of [...this.tabs.values()]) this.close(tab.host, tab.state)
  }

  private require(host: WorkspacePreviewWindow, ref: WorkspacePreviewRef): BrowserTab {
    const tab = this.tabs.get(key(host, ref))
    if (!tab) throw failure('not-found')
    return tab
  }

  private publish(tab: BrowserTab): void {
    for (const listener of [...tab.listeners]) listener(tab.state)
  }

  private load(tab: BrowserTab, url: string): void {
    const generation = ++tab.loadGeneration
    tab.state = { ...tab.state, url, loading: true, error: null }
    this.publish(tab)
    void tab.view.loadURL(url).then(
      () => {
        if (tab.state.closed || tab.loadGeneration !== generation) return
        tab.state = { ...tab.state, ...tab.view.snapshot(), loading: false }
        this.publish(tab)
      },
      () => {
        if (tab.state.closed || tab.loadGeneration !== generation) return
        tab.state = {
          ...tab.state,
          loading: false,
          visible: false,
          error: 'The page could not be loaded. Check the address or start the local server.',
        }
        tab.view.setVisible(false)
        this.publish(tab)
      },
    )
  }
}
