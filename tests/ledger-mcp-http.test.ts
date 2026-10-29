import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { bearerHeaderValue } from '../src/platform/mcp/auth.js'
import { ledgerMcpTransportFor } from '../src/platform/mcp/config.js'
import { handleLedgerMcpHttpRequest } from '../src/platform/mcp/http-server.js'
import { createLedgerMcpQueryRuntime } from '../src/platform/mcp/query-runtime.js'
import { openEngineRuntime } from '../src/infrastructure/runtime/engine-runtime.js'

const TOKEN = 'test-bearer-token'

/** Minimal seeded ledger: one source/session/turn, two calls — so the
 *  lifetime scope reports exactly 1 session / 2 calls. */
async function seedLedger(): Promise<{ dbPath: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'watchtower-ledger-mcp-http-'))
  const dbPath = join(dir, 'ledger.db')
  await openEngineRuntime(dbPath).dispose()

  const db = new DatabaseSync(dbPath)
  db.exec('BEGIN')
  const sourceId = Number(
    db
      .prepare(
        "INSERT INTO ledger_source (provider, env_fingerprint, file_path) VALUES ('claude', 'fp1', 'C:\\work\\.claude\\sessions.json')",
      )
      .run().lastInsertRowid,
  )
  db.prepare(
    "INSERT INTO ledger_session (source_id, session_id, project, working_directory, agent_type, title) VALUES (?, 'sess-a', 'watchtower', 'C:\\work', 'claude', 'Fix bug')",
  ).run(sourceId)
  db.prepare(
    "INSERT INTO ledger_turn (source_id, session_id, turn_index, timestamp, user_message, category) VALUES (?, 'sess-a', 0, '2026-07-01T10:00:00.000Z', 'fix this', 'debugging')",
  ).run(sourceId)
  db.prepare(
    "INSERT INTO ledger_call (source_id, session_id, turn_index, call_index, provider, model, timestamp, base_cost_usd, input_tokens, output_tokens, tools_json) VALUES (?, 'sess-a', 0, 0, 'claude', 'claude-sonnet', '2026-07-01T10:00:00.000Z', 0.5, 1000, 500, '[\"Read\"]')",
  ).run(sourceId)
  db.prepare(
    "INSERT INTO ledger_call (source_id, session_id, turn_index, call_index, provider, model, timestamp, base_cost_usd, input_tokens, output_tokens, tools_json) VALUES (?, 'sess-a', 0, 1, 'claude', 'claude-sonnet', '2026-07-01T10:01:00.000Z', 0.3, 100, 50, '[\"Bash\"]')",
  ).run(sourceId)
  db.exec('COMMIT')
  db.close()

  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const servers: Server[] = []
const disposals: Array<() => Promise<void>> = []
const dirs: Array<() => void> = []
const incomingRequests: IncomingMessage[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  for (const dispose of disposals.splice(0)) await dispose()
  for (const cleanup of dirs.splice(0)) cleanup()
  incomingRequests.splice(0)
})

async function serveLedger(
  onRequest?: (
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
    handler: (req: IncomingMessage, res: import('node:http').ServerResponse) => void,
  ) => void,
): Promise<{ baseUrl: string }> {
  const seeded = await seedLedger()
  dirs.push(seeded.cleanup)
  const runtime = await createLedgerMcpQueryRuntime(seeded.dbPath)
  disposals.push(runtime.dispose)
  const server = createServer((req, res) => {
    incomingRequests.push(req)
    const handler = (request: IncomingMessage, response: import('node:http').ServerResponse): void => {
      void Effect.runPromise(handleLedgerMcpHttpRequest(request, response, runtime.queries, TOKEN))
    }
    if (onRequest) onRequest(req, res, handler)
    else void handler(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (typeof address !== 'object' || !address) throw new Error('no loopback address')
  servers.push(server)
  return { baseUrl: `http://127.0.0.1:${address.port}` }
}

function authedTransport(url: string): StreamableHTTPClientTransport {
  // NESTED requestInit — the documented StreamableHTTPClientTransportOptions
  // shape (a flat RequestInit is silently ignored: no auth header goes out).
  return new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: bearerHeaderValue(TOKEN) } },
  })
}

describe('ledger MCP loopback HTTP (stdio-rejecting harnesses)', () => {
  it('serves the tool surface over StreamableHTTP: list + scoped call with real counts', async () => {
    const { baseUrl } = await serveLedger()
    const client = new Client({ name: 'test', version: '0.0' })
    await client.connect(authedTransport(`${baseUrl}/mcp`))

    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name).sort()).toEqual([
      'ledger_calls',
      'ledger_models',
      'ledger_overview',
      'ledger_scope',
      'ledger_sessions',
      'ledger_skills',
    ])

    const result = await client.callTool({ name: 'ledger_scope', arguments: {} })
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text
    expect(JSON.parse(text)).toMatchObject({ calls: 2, sessions: 1 })

    await client.close()
  })

  it('rejects unauthenticated MCP calls with 401', async () => {
    const { baseUrl } = await serveLedger()

    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })

    expect(res.status).toBe(401)
  })

  it('gates /health behind the same bearer token', async () => {
    const { baseUrl } = await serveLedger()

    const anon = await fetch(`${baseUrl}/health`)
    expect(anon.status).toBe(401)

    const authed = await fetch(`${baseUrl}/health`, { headers: { authorization: bearerHeaderValue(TOKEN) } })
    expect(authed.status).toBe(200)
    expect(await authed.json()).toEqual({ ok: true })
  })

  it('returns the bounded body errors for malformed and oversized JSON', async () => {
    const { baseUrl } = await serveLedger()
    const headers = {
      authorization: bearerHeaderValue(TOKEN),
      'content-type': 'application/json',
    }

    const malformed = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers, body: '{invalid' })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'invalid JSON body' })

    let oversizedRequest: IncomingMessage | undefined
    const ownedListeners: Array<{ event: string; listener: (...args: never[]) => void }> = []
    const oversizedServer = await serveLedger((req, res, handler) => {
      oversizedRequest = req
      const originalOn = req.on
      const originalOnce = req.once
      req.on = function (event, listener) {
        if (typeof event === 'string' && ['data', 'end', 'error', 'aborted'].includes(event)) {
          ownedListeners.push({ event, listener: listener as (...args: never[]) => void })
        }
        return originalOn.call(this, event, listener)
      }
      req.once = function (event, listener) {
        if (typeof event === 'string' && ['data', 'end', 'error', 'aborted'].includes(event)) {
          ownedListeners.push({ event, listener: listener as (...args: never[]) => void })
        }
        return originalOnce.call(this, event, listener)
      }
      handler(req, res)
    })
    const oversized = await new Promise<string>(resolve => {
      const request = httpRequest(`${oversizedServer.baseUrl}/mcp`, {
        method: 'POST',
        headers: { ...headers, 'content-length': '1000001' },
      })
      request.on('response', response => {
        response.resume()
        resolve(`response:${response.statusCode}`)
      })
      request.on('error', () => resolve('closed'))
      request.end(Buffer.alloc(1_000_001, 0x61))
    })
    expect(['closed', 'response:400']).toContain(oversized)
    expect(oversizedRequest?.destroyed).toBe(true)
    await vi.waitFor(() => {
      for (const { event, listener } of ownedListeners) {
        if (listener.name === 'clearIncoming') continue
        const current = oversizedRequest?.rawListeners(event) ?? []
        expect(
          current.some(currentListener => {
            const withOriginal = currentListener as typeof currentListener & { listener?: (...args: never[]) => void }
            return currentListener === listener || withOriginal.listener === listener
          }),
          event,
        ).toBe(false)
      }
    })
  })

  it('removes body listeners when a client abandons a partial request', async () => {
    let listenerBaseline: Map<string, number> | undefined
    let resolveRequest!: () => void
    let resolveAbort!: () => void
    const requestArrived = new Promise<void>(resolve => (resolveRequest = resolve))
    const requestAborted = new Promise<void>(resolve => (resolveAbort = resolve))
    const { baseUrl } = await serveLedger((req, res, handler) => {
      req.once('aborted', resolveAbort)
      listenerBaseline = new Map(['data', 'end', 'error', 'aborted'].map(event => [event, req.listenerCount(event)]))
      resolveRequest()
      void handler(req, res)
    })

    const port = new URL(baseUrl).port
    const client = httpRequest(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        authorization: bearerHeaderValue(TOKEN),
        'content-type': 'application/json',
        'content-length': '1000',
      },
    })
    client.on('error', () => {})
    await new Promise<void>(resolve => client.once('socket', socket => socket.once('connect', resolve)))
    client.write('{"jsonrpc":')
    await requestArrived
    await new Promise<void>(resolve => setImmediate(resolve))
    client.destroy()
    await requestAborted

    const req = incomingRequests.at(-1)
    const baseline = listenerBaseline
    if (!req || !baseline) throw new Error('No observed HTTP request')
    await vi.waitFor(() => {
      for (const event of ['data', 'end', 'error', 'aborted']) {
        const count = baseline.get(event)
        if (count === undefined) throw new Error(`No listener baseline for ${event}`)
        const expected = count - (event === 'aborted' ? 1 : 0)
        expect(req.listenerCount(event)).toBe(expected)
      }
    })
  })
})

describe('ledger MCP transport policy (per-harness)', () => {
  it('serves Copilot over HTTP (its CLI rejects client-provided stdio servers)', () => {
    expect(ledgerMcpTransportFor('copilot')).toBe('http')
  })

  it('serves every other harness over agent-spawned stdio, including unknown keys', () => {
    expect(ledgerMcpTransportFor('opencode')).toBe('stdio')
    expect(ledgerMcpTransportFor('claude')).toBe('stdio')
    expect(ledgerMcpTransportFor('no-such-harness')).toBe('stdio')
  })
})
