import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Scope from 'effect/Scope'
import { describe, expect, it, vi } from 'vitest'

import type { AgentSessionContext } from '@/core/ports/agent-driver.js'
import { acquireBrowserMcp, checkoutBrowserFiles } from '@/platform/electron/main/preview/browser-mcp.js'
import {
  WorkspacePreviewManager,
  type WorkspacePreviewView,
  type WorkspacePreviewWindow,
} from '@/platform/electron/main/preview/preview-manager.js'
import type { WorkspaceBrowserInput, WorkspaceBrowserOperation } from '@/shared/schemas/workspace-browser.js'
import type { WorkspacePreviewAction } from '@/shared/schemas/workspace-preview.js'

class FakeBrowserView implements WorkspacePreviewView {
  readonly nativeView = {}
  readonly loads: string[] = []
  readonly actions: WorkspacePreviewAction[] = []
  visible = false
  url = ''
  title = ''
  loading = false
  automationStarted = false
  automationAborted = false
  readonly resetAutomation = vi.fn(async () => undefined)

  async loadURL(url: string): Promise<void> {
    this.loads.push(url)
    this.url = url
    this.title = `Page ${this.loads.length}`
  }
  setBounds(): void {}
  setVisible(visible: boolean): void {
    this.visible = visible
  }
  snapshot(): ReturnType<WorkspacePreviewView['snapshot']> {
    return {
      url: this.url,
      title: this.title,
      loading: this.loading,
      canGoBack: false,
      canGoForward: false,
      muted: false,
      zoomFactor: 1,
    }
  }
  async command(action: WorkspacePreviewAction): Promise<void> {
    this.actions.push(action)
  }
  subscribe(): () => void {
    return () => undefined
  }
  async capture(): Promise<{ dataUrl: string; width: number; height: number; url: string }> {
    return { dataUrl: 'data:image/png;base64,aGVsbG8=', width: 1, height: 1, url: this.url }
  }
  async automate(
    operation: WorkspaceBrowserOperation,
    input: WorkspaceBrowserInput,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (operation === 'waitFor' && input.text === 'block') {
      this.automationStarted = true
      return new Promise((_, reject) => {
        if (signal?.aborted) return reject(new Error('aborted'))
        signal?.addEventListener(
          'abort',
          () => {
            this.automationAborted = true
            reject(new Error('aborted'))
          },
          { once: true },
        )
      })
    }
    if (operation === 'snapshot')
      return {
        url: this.url,
        title: this.title,
        visibleText: 'Fixture page',
        interactiveElements: [],
        accessibilityTree: '',
        viewport: { width: 800, height: 600 },
        console: [],
        network: [],
        dialog: null,
      }
    return { operation, tabId: input.tabId ?? null }
  }
  destroy(): void {}
}

const context: AgentSessionContext = {
  sessionId: 'session-browser' as AgentSessionContext['sessionId'],
  projectId: 'project-browser' as AgentSessionContext['projectId'],
  taskId: 'task-browser' as AgentSessionContext['taskId'],
  conversationId: 'conversation-browser' as AgentSessionContext['conversationId'],
  checkoutId: 'checkout-browser' as AgentSessionContext['checkoutId'],
  workspacePath: 'C:/workspace',
  generation: 3,
}

function makeHarness() {
  const views: FakeBrowserView[] = []
  const manager = new WorkspacePreviewManager({
    createView: () => {
      const view = new FakeBrowserView()
      views.push(view)
      return view
    },
  })
  const host: WorkspacePreviewWindow = {
    id: 3,
    contentSize: () => ({ width: 1024, height: 768 }),
    attach: vi.fn(),
    detach: vi.fn(),
  }
  return { manager, host, views }
}

async function openMcpEndpoint(manager: WorkspacePreviewManager, host: WorkspacePreviewWindow) {
  const scope = await Effect.runPromise(Scope.make())
  const prepared = await Effect.runPromise(
    acquireBrowserMcp(
      {
        manager,
        context,
        host: () => host,
        artifactDirectory: tmpdir(),
      },
      request => Effect.runPromise(request),
    ).pipe(Effect.provideService(Scope.Scope, scope)),
  )
  const browserMcp = prepared.browserMcp
  if (!browserMcp) throw new Error('Browser MCP endpoint was not prepared.')
  return { scope, browserMcp }
}

function mcpClient(url: string, token: string): { client: Client; transport: StreamableHTTPClientTransport } {
  const client = new Client({ name: 'watchtower-browser-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  return { client, transport }
}

function textContent(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('content' in result) || !Array.isArray(result.content))
    return ''
  const item = result.content.find(
    (content): content is { readonly type: 'text'; readonly text: string } =>
      typeof content === 'object' &&
      content !== null &&
      'type' in content &&
      content.type === 'text' &&
      'text' in content &&
      typeof content.text === 'string',
  )
  return item?.text ?? ''
}

describe('task-scoped browser MCP endpoint', () => {
  it('serves tools over authenticated loopback HTTP and revokes access when its Scope closes', async () => {
    const { manager, host, views } = makeHarness()
    const { scope, browserMcp } = await openMcpEndpoint(manager, host)
    const endpoint = new URL(browserMcp.url)
    const denied = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(denied.status).toBe(401)
    const wrongToken = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: 'Bearer not-the-run-token', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    })
    expect(wrongToken.status).toBe(401)

    const { client, transport } = mcpClient(browserMcp.url, browserMcp.token)
    await client.connect(transport)
    try {
      const listed = await client.listTools()
      expect(
        Buffer.byteLength(JSON.stringify(listed.tools.map(({ name, inputSchema }) => ({ name, inputSchema })))),
      ).toBeLessThan(8000)
      expect(listed.tools.map(tool => tool.name)).toContain('preview_snapshot')
      const snapshotTool = listed.tools.find(tool => tool.name === 'preview_snapshot')
      expect(snapshotTool?.inputSchema.properties).toEqual({
        tabId: expect.any(Object),
        includeImage: expect.any(Object),
        save: expect.any(Object),
        includeDiagnostics: expect.any(Object),
      })
      const actTool = listed.tools.find(tool => tool.name === 'preview_act')
      expect(actTool?.inputSchema.properties).not.toHaveProperty('url')
      expect(actTool?.inputSchema.properties).not.toHaveProperty('includeImage')

      const opened = await client.callTool(
        { name: 'preview_open', arguments: { url: 'http://localhost:4311/' } },
        CallToolResultSchema,
      )
      expect(opened.isError).not.toBe(true)
      const tab = JSON.parse(textContent(opened)) as { tabId: string }
      expect(tab.tabId).toBeTruthy()
      expect(views).toHaveLength(1)
      const view = views[0]
      if (!view) throw new Error('Browser view missing')
      const capture = vi.spyOn(view, 'capture')

      const snapshot = await client.callTool(
        { name: 'preview_snapshot', arguments: { tabId: tab.tabId } },
        CallToolResultSchema,
      )
      expect(snapshot.isError).not.toBe(true)
      const snapshotResult = snapshot as {
        readonly content: readonly { readonly type: string; readonly mimeType?: string }[]
      }
      expect(textContent(snapshotResult)).toContain('Fixture page')
      expect(snapshotResult.content.some(content => content.type === 'image' && content.mimeType === 'image/png')).toBe(
        false,
      )
      expect(capture).not.toHaveBeenCalled()
      expect(JSON.parse(textContent(snapshotResult))).not.toHaveProperty('console')
      expect(JSON.parse(textContent(snapshotResult))).not.toHaveProperty('accessibilityTree')

      const visualSnapshot = await client.callTool(
        { name: 'preview_snapshot', arguments: { tabId: tab.tabId, includeImage: true } },
        CallToolResultSchema,
      )
      expect(
        CallToolResultSchema.parse(visualSnapshot).content.some(
          content => content.type === 'image' && content.mimeType === 'image/png',
        ),
      ).toBe(true)
      expect(capture).toHaveBeenCalledTimes(1)
      const saved = await client.callTool(
        { name: 'preview_snapshot', arguments: { tabId: tab.tabId, save: true } },
        CallToolResultSchema,
      )
      const savedPath = (JSON.parse(textContent(saved)) as { screenshotPath: string }).screenshotPath
      expect(savedPath).toContain('browser-')
      expect((await readFile(savedPath)).toString()).toBe('hello')
      expect(CallToolResultSchema.parse(saved).content.some(content => content.type === 'image')).toBe(false)
      await rm(savedPath)

      const invalid = await client.callTool(
        {
          name: 'preview_act',
          arguments: { action: 'execute-shell-command', tabId: tab.tabId },
        },
        CallToolResultSchema,
      )
      expect(invalid.isError).toBe(true)
    } finally {
      await client.close()
    }

    await Effect.runPromise(Scope.close(scope, Exit.void))
    expect(views[0]?.resetAutomation).toHaveBeenCalledOnce()
    await expect(fetch(endpoint)).rejects.toThrow()
    manager.dispose()
  })

  it('keeps browser MCP tabs inside the endpoint Task and Session ownership rules', async () => {
    const { manager, host } = makeHarness()
    manager.open(host, { ownerKey: 'task-other', tabId: 'foreign-tab', url: 'https://example.com/' })
    const { scope, browserMcp } = await openMcpEndpoint(manager, host)
    const { client, transport } = mcpClient(browserMcp.url, browserMcp.token)
    await client.connect(transport)
    try {
      const foreign = await client.callTool(
        { name: 'preview_close', arguments: { tabId: 'foreign-tab' } },
        CallToolResultSchema,
      )
      expect(foreign.isError).toBe(true)
      expect(manager.list(host, 'task-other')).toHaveLength(1)

      const own = await client.callTool(
        { name: 'preview_open', arguments: { url: 'https://example.com/' } },
        CallToolResultSchema,
      )
      const ownTab = JSON.parse(textContent(own)) as { tabId: string }
      await manager.command(host, { ownerKey: 'task-browser', tabId: ownTab.tabId, action: 'pause-agent' })
      const paused = await client.callTool(
        { name: 'preview_snapshot', arguments: { tabId: ownTab.tabId } },
        CallToolResultSchema,
      )
      expect(paused.isError).toBe(true)
      await manager.command(host, { ownerKey: 'task-browser', tabId: ownTab.tabId, action: 'resume-agent' })
      expect(() => manager.agentTab(context.taskId, 'different-session', ownTab.tabId, true)).toThrow(
        'This tab belongs to another Agent Session. Open a new tab.',
      )
    } finally {
      await client.close()
      await Effect.runPromise(Scope.close(scope, Exit.void))
      manager.dispose()
    }
  })

  it('serializes requests on the endpoint and closes a blocked operation with the Driver Connection scope', async () => {
    const { manager, host, views } = makeHarness()
    const { scope, browserMcp } = await openMcpEndpoint(manager, host)
    const { client, transport } = mcpClient(browserMcp.url, browserMcp.token)
    await client.connect(transport)
    const opened = await client.callTool(
      { name: 'preview_open', arguments: { url: 'https://example.com/' } },
      CallToolResultSchema,
    )
    const tab = JSON.parse(textContent(opened)) as { tabId: string }
    const blocked = client.callTool(
      { name: 'preview_wait_for', arguments: { tabId: tab.tabId, text: 'block', timeoutMs: 60_000 } },
      CallToolResultSchema,
    )
    try {
      for (let attempt = 0; attempt < 100 && !views[0]?.automationStarted; attempt += 1)
        await new Promise(resolve => setTimeout(resolve, 5))
      expect(views[0]?.automationStarted).toBe(true)

      const concurrent = await client.callTool({ name: 'preview_status', arguments: {} }, CallToolResultSchema)
      expect(concurrent.isError).toBe(true)
      expect(textContent(concurrent)).toContain('in progress')

      await Effect.runPromise(Scope.close(scope, Exit.void))
      expect(views[0]?.automationAborted).toBe(true)
      expect(views[0]?.resetAutomation).toHaveBeenCalledOnce()
      await transport.close().catch(() => undefined)
      void blocked.catch(() => undefined)
    } finally {
      await transport.close().catch(() => undefined)
      manager.dispose()
    }
  })

  it('rejects upload paths that escape the active checkout, including symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'watchtower-browser-upload-'))
    const checkout = join(root, 'checkout')
    const outside = join(root, 'outside.txt')
    await mkdir(checkout)
    await writeFile(join(checkout, 'inside.txt'), 'inside')
    await writeFile(outside, 'outside')
    try {
      expect(await checkoutBrowserFiles(checkout, ['inside.txt'])).toEqual([
        await realpath(join(checkout, 'inside.txt')),
      ])
      await expect(checkoutBrowserFiles(checkout, ['../outside.txt'])).rejects.toThrow(
        'inside the active Workspace Checkout',
      )
      const linkPath = join(checkout, 'outside-link.txt')
      try {
        await import('node:fs/promises').then(({ symlink }) => symlink(outside, linkPath, 'file'))
      } catch {
        return
      }
      await expect(checkoutBrowserFiles(checkout, ['outside-link.txt'])).rejects.toThrow(
        'inside the active Workspace Checkout',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
