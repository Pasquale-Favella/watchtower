import * as Schema from 'effect/Schema'

import { workspacePreviewMessages, WorkspacePreviewRpcError } from '@/shared/rpc/workspace-preview.js'
import type { WorkspaceBrowserInput, WorkspaceBrowserOperation } from '@/shared/schemas/workspace-browser.js'
import {
  normalizeWorkspacePreviewUrl,
  type WorkspacePreviewBounds,
  type WorkspacePreviewCapture,
  type WorkspacePreviewCommand,
  type WorkspacePreviewLayout,
  type WorkspacePreviewNavigate,
  type WorkspacePreviewOpen,
  type WorkspacePreviewPickedElement,
  workspacePreviewPickedElementSchema,
  type WorkspacePreviewRef,
  type WorkspacePreviewShortcut,
  type WorkspacePreviewState,
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
  readonly capture?: ((bounds?: WorkspacePreviewBounds) => Promise<WorkspacePreviewCapture>) | undefined
  readonly resetAutomation?: (() => Promise<void>) | undefined
  readonly automate?:
    | ((operation: WorkspaceBrowserOperation, input: WorkspaceBrowserInput, signal?: AbortSignal) => Promise<unknown>)
    | undefined
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
  controlGeneration: number
  agentOwner: string | null
  readonly operations: Set<AbortController>
  pickController?: AbortController
  resetAfterPick?: boolean
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
  private readonly bindings = new Map<string, { host: WorkspacePreviewWindow; ownerKey: string }>()
  private readonly tabListeners = new Map<string, Set<(tabs: readonly WorkspacePreviewState[]) => void>>()

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
      controlGeneration: 0,
      agentOwner: null,
      operations: new Set(),
      state: {
        ...request,
        ...view.snapshot(),
        error: null,
        agentPaused: false,
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
    this.publish(tab)
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
    if (request.action === 'pause-agent' || request.action === 'resume-agent') {
      tab.controlGeneration += 1
      tab.state = { ...tab.state, agentPaused: request.action === 'pause-agent' }
      for (const controller of tab.operations) controller.abort()
      this.publish(tab)
      return tab.state
    }
    if (['back', 'forward', 'reload', 'stop'].includes(request.action))
      for (const controller of tab.operations) controller.abort()
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

  async pick(
    host: WorkspacePreviewWindow,
    request: WorkspacePreviewRef,
  ): Promise<{ image: WorkspacePreviewCapture; text: string; element: WorkspacePreviewPickedElement }> {
    const tab = this.require(host, request)
    if (!tab.view.automate || tab.pickController) throw failure('unavailable')
    const wasPaused = tab.state.agentPaused
    const controlGeneration = tab.controlGeneration
    tab.state = { ...tab.state, agentPaused: true }
    for (const controller of tab.operations) controller.abort()
    const controller = new AbortController()
    tab.pickController = controller
    tab.operations.add(controller)
    const timer = setTimeout(() => controller.abort(), 60_000)
    this.publish(tab)
    try {
      const result = await tab.view.automate('pick', {}, controller.signal)
      const selected = Schema.decodeUnknownSync(
        Schema.Struct({
          ...workspacePreviewPickedElementSchema.fields,
          outerHTML: Schema.String,
          rect: Schema.Struct({ x: Schema.Finite, y: Schema.Finite, width: Schema.Finite, height: Schema.Finite }),
          viewport: Schema.Struct({ width: Schema.Finite, height: Schema.Finite }),
        }),
      )(result)
      if (controller.signal.aborted || tab.state.closed) throw failure('unavailable')
      if (!tab.view.capture) throw failure('unavailable')
      const rect = selected.rect
      const viewport = selected.viewport
      if (rect.width <= 0 || rect.height <= 0 || viewport.width <= 0 || viewport.height <= 0)
        throw failure('invalid-request')
      const x = Math.max(0, Math.floor(rect.x - 24))
      const y = Math.max(0, Math.floor(rect.y - 24))
      const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width + 24))
      const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height + 24))
      if (right <= x || bottom <= y) throw failure('invalid-request')
      const crop = { x, y, width: right - x, height: bottom - y }
      const image = await tab.view.capture(crop)
      const normalizedX = Math.max(0, (rect.x - x) / crop.width)
      const normalizedY = Math.max(0, (rect.y - y) / crop.height)
      const element: WorkspacePreviewPickedElement = {
        ...selected,
        rect: {
          x: normalizedX,
          y: normalizedY,
          width: Math.max(0, (Math.min(viewport.width, rect.x + rect.width) - Math.max(0, rect.x)) / crop.width),
          height: Math.max(0, (Math.min(viewport.height, rect.y + rect.height) - Math.max(0, rect.y)) / crop.height),
        },
      }
      return {
        image,
        element,
        text: `Browser element on ${image.url}\nSelector: ${element.selector}\nElement: ${element.role} (${element.tag})\nName: ${element.name}${element.href ? `\nLink: ${element.href}` : ''}${element.componentName ? `\nComponent: ${element.componentName}` : ''}${element.source ? `\nSource: ${element.source}` : ''}\nStyles: ${element.styles}\nText: ${element.text}\nHTML:\n${selected.outerHTML}`.slice(
          0,
          16_000,
        ),
      }
    } finally {
      clearTimeout(timer)
      tab.operations.delete(controller)
      delete tab.pickController
      if (!tab.state.closed && tab.controlGeneration === controlGeneration) {
        tab.state = { ...tab.state, agentPaused: wasPaused }
        this.publish(tab)
      }
      if (tab.resetAfterPick) {
        delete tab.resetAfterPick
        try {
          await tab.view.resetAutomation?.()
        } catch {
          // Cleanup failure must not replace the picker result or cancellation.
        }
      }
    }
  }

  cancelPick(host: WorkspacePreviewWindow, request: WorkspacePreviewRef): void {
    this.require(host, request).pickController?.abort()
  }

  async configure(
    host: WorkspacePreviewWindow,
    request: WorkspacePreviewRef & {
      readonly width?: number
      readonly height?: number
      readonly colorScheme?: 'light' | 'dark' | 'system'
    },
  ): Promise<void> {
    const tab = this.require(host, request)
    if (!tab.view.automate) throw failure('unavailable')
    for (const controller of tab.operations) controller.abort()
    if (request.colorScheme !== undefined) {
      await tab.view.automate('setColorScheme', { colorScheme: request.colorScheme })
    } else {
      await tab.view.automate('resize', {
        ...(request.width === undefined ? {} : { width: request.width }),
        ...(request.height === undefined ? {} : { height: request.height }),
      })
    }
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
    for (const controller of tab.operations) controller.abort()
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
    for (const [taskId, binding] of this.bindings) {
      if (binding.host.id === host.id && binding.ownerKey === ownerKey)
        this.bindings.set(taskId, { host, ownerKey: nextOwnerKey })
    }
    this.publishTabs(host, ownerKey)
  }

  bind(host: WorkspacePreviewWindow, ownerKey: string, taskId: string): void {
    for (const [otherTask, binding] of this.bindings) {
      if (otherTask !== taskId && binding.host.id === host.id && binding.ownerKey === ownerKey)
        throw failure('invalid-request')
    }
    const previous = this.bindings.get(taskId)
    if (previous && (previous.host.id !== host.id || previous.ownerKey !== ownerKey)) {
      if (previous.host.id !== host.id) throw failure('invalid-request')
      this.adoptOwner(host, previous.ownerKey, ownerKey)
    }
    this.bindings.set(taskId, { host, ownerKey })
    this.publishTabs(host, ownerKey)
  }

  taskBinding(taskId: string): { host: WorkspacePreviewWindow; ownerKey: string } | undefined {
    return this.bindings.get(taskId)
  }

  list(host: WorkspacePreviewWindow, ownerKey: string): readonly WorkspacePreviewState[] {
    return [...this.tabs.values()]
      .filter(tab => tab.host.id === host.id && tab.state.ownerKey === ownerKey)
      .map(tab => tab.state)
  }

  agentTabs(taskId: string, sessionId: string): readonly WorkspacePreviewState[] {
    const binding = this.bindings.get(taskId)
    if (!binding) throw failure('unavailable')
    return this.list(binding.host, binding.ownerKey).filter(state => {
      const tab = this.require(binding.host, state)
      return !state.agentPaused && (!tab.agentOwner || tab.agentOwner === sessionId)
    })
  }

  subscribeTabs(
    host: WorkspacePreviewWindow,
    ownerKey: string,
    listener: (tabs: readonly WorkspacePreviewState[]) => void,
  ): () => void {
    const id = JSON.stringify([host.id, ownerKey])
    const listeners = this.tabListeners.get(id) ?? new Set()
    this.tabListeners.set(id, listeners)
    listeners.add(listener)
    listener(this.list(host, ownerKey))
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.tabListeners.delete(id)
    }
  }

  /** The endpoint supplies Task/Session authority; tool arguments can only select tabs within it. */
  agentTab(
    taskId: string,
    sessionId: string,
    tabId?: string,
    mutate = false,
  ): { host: WorkspacePreviewWindow; ref: WorkspacePreviewRef } {
    const binding = this.bindings.get(taskId)
    if (!binding) throw failure('unavailable')
    const tabs = this.list(binding.host, binding.ownerKey)
    const candidates = tabs.filter(state => {
      const tab = this.require(binding.host, state)
      return !tab.agentOwner || tab.agentOwner === sessionId
    })
    const state = tabId ? tabs.find(tab => tab.tabId === tabId) : candidates.length === 1 ? candidates[0] : undefined
    if (!state) throw failure(tabId ? 'not-found' : 'ambiguous-tab')
    const tab = this.require(binding.host, state)
    if (state.agentPaused) throw failure('agent-paused')
    if (mutate) {
      if (tab.agentOwner && tab.agentOwner !== sessionId) throw failure('agent-owned')
      tab.agentOwner = sessionId
    }
    return { host: binding.host, ref: { ownerKey: binding.ownerKey, tabId: state.tabId } }
  }

  async automate(
    taskId: string,
    sessionId: string,
    operation: WorkspaceBrowserOperation,
    input: WorkspaceBrowserInput,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const target = this.agentTab(taskId, sessionId, input.tabId, operation !== 'snapshot')
    const tab = this.require(target.host, target.ref)
    if (!tab.view.automate) throw failure('unavailable')
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    tab.operations.add(controller)
    try {
      return await tab.view.automate(operation, input, controller.signal)
    } finally {
      signal?.removeEventListener('abort', abort)
      tab.operations.delete(controller)
    }
  }

  async releaseAgent(taskId: string, sessionId: string): Promise<void> {
    const binding = this.bindings.get(taskId)
    if (!binding) return
    const owned = this.list(binding.host, binding.ownerKey).filter(state => {
      const tab = this.tabs.get(key(binding.host, state))
      return tab?.agentOwner === sessionId
    })
    await Promise.allSettled(
      owned.map(async state => {
        const tab = this.tabs.get(key(binding.host, state))
        if (!tab) return
        for (const controller of tab.operations) {
          if (controller !== tab.pickController) controller.abort()
        }
        if (tab.pickController) {
          tab.resetAfterPick = true
          return
        }
        await tab.view.resetAutomation?.()
      }),
    )
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
    for (const [taskId, binding] of this.bindings) if (binding.host.id === windowId) this.bindings.delete(taskId)
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
    this.publishTabs(tab.host, tab.state.ownerKey)
  }

  private publishTabs(host: WorkspacePreviewWindow, ownerKey: string): void {
    for (const listener of this.tabListeners.get(JSON.stringify([host.id, ownerKey])) ?? [])
      listener(this.list(host, ownerKey))
  }

  private load(tab: BrowserTab, url: string): void {
    for (const controller of tab.operations) controller.abort()
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
