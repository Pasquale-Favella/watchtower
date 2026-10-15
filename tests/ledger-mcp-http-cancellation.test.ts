import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  request: undefined as { aborted: boolean } | undefined,
  events: [] as string[],
  server: undefined as { close: () => Promise<void> } | undefined,
  closeCount: 0,
}))

vi.mock('../src/main/agents/ledger-mcp/server.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/agents/ledger-mcp/server.js')>()
  return {
    ...actual,
    createLedgerMcpServer: (queries: Parameters<typeof actual.createLedgerMcpServer>[0]) => {
      const server = actual.createLedgerMcpServer(queries)
      if (hooks.request) hooks.request.aborted = true

      const connect = server.connect.bind(server)
      server.connect = async transport => {
        hooks.events.push('connect')
        const streamableTransport = transport as StreamableHTTPServerTransport
        const transportClose = streamableTransport.close.bind(streamableTransport)
        streamableTransport.close = async () => {
          hooks.events.push('transport.close')
          await transportClose()
        }
        const handleRequest = streamableTransport.handleRequest.bind(streamableTransport)
        streamableTransport.handleRequest = async (...args) => {
          hooks.events.push('handleRequest')
          return handleRequest(...args)
        }
        return connect(transport)
      }

      const close = server.close.bind(server)
      server.close = async () => {
        hooks.events.push('server.close')
        hooks.closeCount += 1
        return close()
      }
      hooks.server = server
      return server
    },
  }
})

import { bearerHeaderValue } from '../src/main/agents/ledger-mcp/auth.js'
import { handleLedgerMcpHttpRequest } from '../src/main/agents/ledger-mcp/http-server.js'
import type { LedgerMcpQueries } from '../src/main/agents/ledger-mcp/query-api.js'

const TOKEN = 'cancel-test-token'

afterEach(async () => {
  if (hooks.server) await hooks.server.close()
  hooks.request = undefined
  hooks.events = []
  hooks.server = undefined
  hooks.closeCount = 0
})

describe('ledger MCP HTTP cancellation', () => {
  it('connects the SDK transport before abort cleanup closes it', async () => {
    const req = Object.assign(new EventEmitter(), {
      aborted: false,
      headers: { authorization: bearerHeaderValue(TOKEN) },
      method: 'GET',
      url: '/mcp',
    }) as unknown as IncomingMessage
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      headersSent: false,
    }) as unknown as ServerResponse
    const queries = {
      scope: vi.fn(),
      overview: vi.fn(),
      sessions: vi.fn(),
      models: vi.fn(),
      skills: vi.fn(),
      calls: vi.fn(),
    }
    hooks.request = req

    await Effect.runPromise(handleLedgerMcpHttpRequest(req, res, queries as unknown as LedgerMcpQueries, TOKEN))

    expect(hooks.events).toEqual(['connect', 'server.close', 'transport.close'])
    expect(hooks.closeCount).toBe(1)
    expect(hooks.events).not.toContain('handleRequest')
    for (const query of Object.values(queries)) expect(query).not.toHaveBeenCalled()
  })
})
