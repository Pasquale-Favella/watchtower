import * as Schema from 'effect/Schema'
import { describe, expect, it, vi } from 'vitest'

import {
  fitWorkspacePreviewBounds,
  WorkspacePreviewManager,
  type WorkspacePreviewView,
  type WorkspacePreviewWindow,
} from '../src/platform/electron/main/preview/preview-manager.js'
import {
  readWorkspacePreviewUrl,
  rememberWorkspacePreviewUrl,
} from '../src/renderer/features/workspace/browser-preview/preview-storage.js'
import { WorkspacePreviewRpcError } from '../src/shared/rpc/workspace-preview.js'
import {
  normalizeWorkspacePreviewUrl,
  type WorkspacePreviewAction,
  type WorkspacePreviewBounds,
  type WorkspacePreviewState,
  workspacePreviewUrlSchema,
} from '../src/shared/schemas/workspace-preview.js'

const ref = { ownerKey: 'draft-1', tabId: 'browser-1' }
const other = { ownerKey: 'draft-1', tabId: 'browser-2' }
const bounds = { x: 640, y: 80, width: 560, height: 700 }

class FakeView implements WorkspacePreviewView {
  readonly nativeView = {}
  readonly loads: string[] = []
  readonly actions: WorkspacePreviewAction[] = []
  readonly destroyed = vi.fn()
  visible = false
  bounds: WorkspacePreviewBounds | null = null
  url = ''
  title = ''
  loading = false
  muted = false
  zoomFactor = 1
  changed: () => void = () => undefined
  failed: () => void = () => undefined
  popup: (url: string) => void = () => undefined
  readonly unsubscribed = vi.fn()
  readonly failure = false

  async loadURL(url: string): Promise<void> {
    this.loads.push(url)
    this.url = url
    this.title = `Page ${this.loads.length}`
  }
  setBounds(bounds: WorkspacePreviewBounds): void {
    this.bounds = bounds
  }
  setVisible(visible: boolean): void {
    this.visible = visible
  }
  snapshot(): ReturnType<WorkspacePreviewView['snapshot']> {
    return {
      url: this.url,
      title: this.title,
      loading: this.loading,
      canGoBack: this.loads.length > 1,
      canGoForward: false,
      muted: this.muted,
      zoomFactor: this.zoomFactor,
    }
  }
  async command(action: WorkspacePreviewAction): Promise<void> {
    this.actions.push(action)
    if (action === 'toggle-mute') this.muted = !this.muted
    if (action === 'zoom-in') this.zoomFactor += 0.1
  }
  subscribe(changed: () => void, failed: () => void, popup: (url: string) => void): () => void {
    this.changed = changed
    this.failed = failed
    this.popup = popup
    return this.unsubscribed
  }
  destroy(): void {
    this.destroyed()
  }
}

function harness() {
  const views: FakeView[] = []
  const manager = new WorkspacePreviewManager({
    createView: () => {
      const view = new FakeView()
      views.push(view)
      return view
    },
  })
  const host: WorkspacePreviewWindow = {
    id: 1,
    contentSize: () => ({ width: 1200, height: 800 }),
    attach: vi.fn(),
    detach: vi.fn(),
  }
  return { manager, views, host }
}

function firstView(views: FakeView[]): FakeView {
  const view = views[0]
  if (!view) throw new Error('No browser view was created')
  return view
}

describe('workspace preview URLs', () => {
  it('normalizes local development addresses and normal web addresses', () => {
    expect(normalizeWorkspacePreviewUrl('localhost:3000')).toBe('http://localhost:3000/')
    expect(normalizeWorkspacePreviewUrl('127.0.0.1:4173/page?q=one')).toBe('http://127.0.0.1:4173/page?q=one')
    expect(normalizeWorkspacePreviewUrl('[::1]:3000')).toBe('http://[::1]:3000/')
    expect(normalizeWorkspacePreviewUrl('example.com/app')).toBe('https://example.com/app')
    expect(normalizeWorkspacePreviewUrl('https://example.com')).toBe('https://example.com/')
  })
  it.each([
    'file:///C:/private.txt',
    'javascript:alert(1)',
    'data:text/html,hello',
    'chrome://settings',
    'devtools://devtools',
    'https://name:password@example.com',
    'http://example.com/\0x',
    '',
  ])('refuses privileged or malformed URL %s', value => {
    expect(normalizeWorkspacePreviewUrl(value)).toBeNull()
    expect(Schema.is(workspacePreviewUrlSchema)(value)).toBe(false)
  })
  it('requires normalized addresses at the RPC boundary', () => {
    expect(Schema.is(workspacePreviewUrlSchema)('localhost:3000')).toBe(false)
    expect(Schema.is(workspacePreviewUrlSchema)('http://localhost:3000/')).toBe(true)
  })
})

describe('workspace browser ownership and layout', () => {
  it('opens one app-owned page per window, owner and tab', async () => {
    const { manager, views, host } = harness()
    manager.open(host, { ...ref, url: 'http://localhost:3000/' })
    await Promise.resolve()
    manager.open(host, { ...ref, url: 'https://example.com/' })
    expect(views).toHaveLength(1)
    expect(firstView(views).loads).toEqual(['http://localhost:3000/'])
    manager.open({ ...host, id: 2 }, ref)
    expect(views).toHaveLength(2)
    expect(host.attach).toHaveBeenCalledTimes(2)
  })
  it('keeps page and navigation state when hidden or its renderer detaches', async () => {
    const { manager, views, host } = harness()
    manager.open(host, { ...ref, url: 'http://localhost:3000/' })
    await Promise.resolve()
    const states: WorkspacePreviewState[] = []
    const detach = manager.subscribe(host, ref, state => states.push(state))
    manager.navigate(host, { ...ref, url: 'http://localhost:3000/second' })
    await Promise.resolve()
    manager.layout(host, { ...ref, bounds, visible: true })
    manager.layout(host, { ...ref, bounds, visible: false })
    detach()
    const reopened = manager.open(host, ref)
    expect(reopened.url).toBe('http://localhost:3000/second')
    expect(reopened.canGoBack).toBe(true)
    expect(reopened.visible).toBe(false)
    expect(firstView(views).destroyed).not.toHaveBeenCalled()
    expect(states.at(-1)?.visible).toBe(false)
  })
  it('shows only one native page in a window and clamps its bounds', async () => {
    const { manager, views, host } = harness()
    manager.open(host, { ...ref, url: 'http://localhost:3000/' })
    manager.open(host, { ...other, url: 'http://localhost:4000/' })
    await Promise.resolve()
    manager.layout(host, { ...ref, bounds, visible: true })
    expect(firstView(views).visible).toBe(true)
    manager.layout(host, { ...other, bounds: { x: 1100, y: 750, width: 1000, height: 1000 }, visible: true })
    expect(firstView(views).visible).toBe(false)
    expect(views[1]?.visible).toBe(true)
    expect(views[1]?.bounds).toEqual({ x: 1100, y: 750, width: 100, height: 50 })
    manager.hideWindow(host.id)
    expect(views[1]?.visible).toBe(false)
  })
  it('never displays an empty page or a failed navigation above app UI', async () => {
    const { manager, views, host } = harness()
    manager.open(host, ref)
    manager.layout(host, { ...ref, bounds, visible: true })
    expect(firstView(views).visible).toBe(false)
    manager.navigate(host, { ...ref, url: 'http://localhost:3000/' })
    await Promise.resolve()
    manager.layout(host, { ...ref, bounds, visible: true })
    firstView(views).failed()
    expect(firstView(views).visible).toBe(false)
    expect(manager.open(host, ref).error).toContain('could not be loaded')
    manager.layout(host, { ...ref, bounds, visible: true })
    expect(firstView(views).visible).toBe(false)
  })
  it('adopts a draft page without losing history or recreating its native view', async () => {
    const { manager, views, host } = harness()
    manager.open(host, { ...ref, url: 'http://localhost:3000/' })
    await Promise.resolve()
    manager.adoptOwner(host, ref.ownerKey, 'task-1')
    expect(manager.open(host, { ownerKey: 'task-1', tabId: ref.tabId }).url).toBe('http://localhost:3000/')
    expect(views).toHaveLength(1)
    expect(() => manager.subscribe(host, ref, () => undefined)).toThrow(WorkspacePreviewRpcError)
  })
  it('does not overwrite an existing task tab during adoption', () => {
    const { manager, views, host } = harness()
    manager.open(host, ref)
    manager.open(host, { ...ref, ownerKey: 'task-1' })
    expect(() => manager.adoptOwner(host, ref.ownerKey, 'task-1')).toThrow(WorkspacePreviewRpcError)
    expect(manager.open(host, ref).closed).toBe(false)
    expect(views).toHaveLength(2)
  })
  it('forwards normal popup links as tab requests and refuses privileged links', () => {
    const { manager, views, host } = harness()
    manager.open(host, ref)
    firstView(views).popup('file:///private.txt')
    expect(manager.open(host, ref).popupSequence).toBe(0)
    firstView(views).popup('https://example.com/')
    expect(manager.open(host, ref)).toMatchObject({ popupSequence: 1, popupUrl: 'https://example.com/' })
  })
  it('closes only the requested page and releases all its subscriptions', () => {
    const { manager, views, host } = harness()
    manager.open(host, ref)
    manager.open(host, other)
    manager.close(host, ref)
    expect(firstView(views).destroyed).toHaveBeenCalledOnce()
    expect(firstView(views).unsubscribed).toHaveBeenCalledOnce()
    expect(views[1]?.destroyed).not.toHaveBeenCalled()
    expect(host.detach).toHaveBeenCalledOnce()
    manager.dispose()
    expect(views[1]?.destroyed).toHaveBeenCalledOnce()
  })
  it('rejects unsafe initial URLs before allocating a native page', () => {
    const { manager, views, host } = harness()
    expect(() => manager.open(host, { ...ref, url: 'file:///private.txt' })).toThrow(WorkspacePreviewRpcError)
    expect(views).toHaveLength(0)
  })
  it('forwards browser commands to the owned page', async () => {
    const { manager, views, host } = harness()
    manager.open(host, ref)
    expect(await manager.command(host, { ...ref, action: 'toggle-mute' })).toMatchObject({ muted: true })
    expect(await manager.command(host, { ...ref, action: 'zoom-in' })).toMatchObject({ zoomFactor: 1.1 })
    expect(firstView(views).actions).toEqual(['toggle-mute', 'zoom-in'])
  })
  it('fits browser bounds to the actual window contents', () => {
    expect(
      fitWorkspacePreviewBounds({ x: 2000, y: 900, width: 500, height: 500 }, { width: 1200, height: 800 }),
    ).toEqual({ x: 1200, y: 800, width: 0, height: 0 })
  })
})

describe('browser URL restoration', () => {
  function storage() {
    const values = new Map<string, string>()
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value)
      },
    }
  }
  it('stores the latest normalized URL independently for each tab and owner', () => {
    const saved = storage()
    rememberWorkspacePreviewUrl(saved, ref, 'http://localhost:3000/')
    rememberWorkspacePreviewUrl(saved, other, 'https://example.com/')
    expect(readWorkspacePreviewUrl(saved, ref)).toBe('http://localhost:3000/')
    expect(readWorkspacePreviewUrl(saved, other)).toBe('https://example.com/')
    expect(readWorkspacePreviewUrl(saved, { ...ref, ownerKey: 'task-other' })).toBeUndefined()
    rememberWorkspacePreviewUrl(saved, ref, 'file:///private.txt')
    expect(readWorkspacePreviewUrl(saved, ref)).toBe('http://localhost:3000/')
  })
  it('keeps only the last hundred remembered tabs and tolerates unavailable storage', () => {
    const saved = storage()
    for (let index = 0; index < 101; index++)
      rememberWorkspacePreviewUrl(saved, { ...ref, tabId: `tab-${index}` }, `http://localhost:3000/${index}`)
    expect(readWorkspacePreviewUrl(saved, { ...ref, tabId: 'tab-0' })).toBeUndefined()
    expect(readWorkspacePreviewUrl(saved, { ...ref, tabId: 'tab-100' })).toBe('http://localhost:3000/100')
    expect(readWorkspacePreviewUrl(null, ref)).toBeUndefined()
    expect(() =>
      rememberWorkspacePreviewUrl(
        {
          getItem: () => {
            throw new Error('blocked')
          },
          setItem: () => {
            throw new Error('blocked')
          },
        },
        ref,
        'http://localhost:3000/',
      ),
    ).not.toThrow()
  })
})
