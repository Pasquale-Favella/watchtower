import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import * as Effect from 'effect/Effect'
import { expect, it, vi } from 'vitest'

import { createBrowserMcpProxy } from '@/platform/mcp/browser-proxy.js'
import { acquireLedgerMcp, ledgerMcpWithStdio } from '@/platform/mcp/ledger-endpoint.js'
import { createLedgerMcpQueries } from '@/platform/mcp/query-api.js'

it('authenticates ledger MCP requests and closes the listener with its scope', async () => {
  const scope = { period: 'lifetime' }
  const result = { scope, range: { startMs: 0, endMs: 1 }, sessions: 2, calls: 3, providers: ['claude'] }
  const request = vi.fn().mockResolvedValue(result)
  const endpoint = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const endpoint = yield* acquireLedgerMcp(createLedgerMcpQueries({ request }), Effect.runPromise)
        yield* Effect.promise(async () => {
          expect((await fetch(endpoint.url)).status).toBe(401)
          const authorization = `Bearer ${endpoint.token}`
          const client = new Client({ name: 'ledger-endpoint-test', version: '1.0.0' })
          try {
            await client.connect(
              new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { authorization } } }),
            )
            const { tools } = await client.listTools()
            expect(tools.map(tool => tool.name)).toContain('ledger_scope')
            const response = await client.callTool({ name: 'ledger_scope', arguments: { scope } })
            expect(response.content).toEqual([{ type: 'text', text: JSON.stringify(result, null, 2) }])
            expect(request).toHaveBeenCalledExactlyOnceWith('ledger-mcp:scope', scope)
          } finally {
            await client.close()
          }
        })
        return endpoint
      }),
    ),
  )
  await expect(fetch(endpoint.url)).rejects.toBeDefined()
})

it('gives stdio harnesses the ledger tools, resources, and prompts over the same endpoint', async () => {
  const queries = createLedgerMcpQueries({ request: vi.fn() })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const endpoint = yield* acquireLedgerMcp(queries, Effect.runPromise)
        const { stdio } = ledgerMcpWithStdio(endpoint, 'watchtower', '/app/ledger-mcp-proxy.js')
        expect(stdio).toEqual({
          command: 'watchtower',
          args: ['/app/ledger-mcp-proxy.js'],
          env: [
            { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
            { name: 'WATCHTOWER_LEDGER_MCP_URL', value: endpoint.url },
            { name: 'WATCHTOWER_LEDGER_MCP_TOKEN', value: endpoint.token },
          ],
        })
        yield* Effect.promise(async () => {
          const outgoing = new Client({ name: 'ledger-proxy-test', version: '1.0.0' })
          const harness = new Client({ name: 'harness-test', version: '1.0.0' })
          const [harnessTransport, proxyTransport] = InMemoryTransport.createLinkedPair()
          const proxy = createBrowserMcpProxy(outgoing, endpoint.name)
          try {
            await outgoing.connect(
              new StreamableHTTPClientTransport(new URL(endpoint.url), {
                requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
              }),
            )
            await proxy.connect(proxyTransport)
            await harness.connect(harnessTransport)
            expect((await harness.listTools()).tools.map(tool => tool.name)).toContain('ledger_scope')
            expect((await harness.listResources()).resources.map(resource => resource.uri)).toContain('ledger://schema')
            expect((await harness.readResource({ uri: 'ledger://schema' })).contents).toHaveLength(1)
            expect((await harness.listPrompts()).prompts.map(prompt => prompt.name)).toContain('coach-orient')
            expect((await harness.getPrompt({ name: 'coach-orient' })).messages).toHaveLength(1)
          } finally {
            await harness.close()
            await proxy.close()
            await outgoing.close()
          }
        })
      }),
    ),
  )
})
