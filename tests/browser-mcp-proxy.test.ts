import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { expect, it } from 'vitest'

import { createBrowserMcpProxy } from '../src/platform/mcp/browser-proxy.js'

it('forwards browser tool schemas, image results and tool errors for stdio-only Harnesses', async () => {
  const backend = new Server({ name: 'fixture-browser', version: '1' }, { capabilities: { tools: {} } })
  backend.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{ name: 'preview_snapshot', description: 'Inspect the page', inputSchema: { type: 'object' as const } }],
  }))
  backend.setRequestHandler(CallToolRequestSchema, request =>
    request.params.arguments?.fail
      ? { isError: true, content: [{ type: 'text' as const, text: 'Browser paused' }] }
      : {
          content: [
            { type: 'text' as const, text: 'Page title' },
            { type: 'image' as const, mimeType: 'image/png', data: 'aGVsbG8=' },
          ],
        },
  )
  const outgoing = new Client({ name: 'proxy-outgoing', version: '1' })
  const incoming = new Client({ name: 'fixture-harness', version: '1' })
  const [backendTransport, outgoingTransport] = InMemoryTransport.createLinkedPair()
  const proxy = createBrowserMcpProxy(outgoing)
  const [proxyTransport, incomingTransport] = InMemoryTransport.createLinkedPair()
  try {
    await backend.connect(backendTransport)
    await outgoing.connect(outgoingTransport)
    await proxy.connect(proxyTransport)
    await incoming.connect(incomingTransport)
    expect(await incoming.listTools()).toMatchObject({
      tools: [{ name: 'preview_snapshot', inputSchema: { type: 'object' } }],
    })
    expect(await incoming.callTool({ name: 'preview_snapshot', arguments: {} })).toMatchObject({
      content: [
        { type: 'text', text: 'Page title' },
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
      ],
    })
    expect(await incoming.callTool({ name: 'preview_snapshot', arguments: { fail: true } })).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Browser paused' }],
    })
  } finally {
    await incoming.close()
    await proxy.close()
    await outgoing.close()
    await backend.close()
  }
})
