import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { createLedgerMcpHttpHandler } from '../src/main/agents/ledger-mcp/http-server.js'
import { bearerHeaderValue } from '../src/main/agents/ledger-mcp/auth.js'
import { ledgerMcpTransportFor } from '../src/main/agents/ledger-mcp/config.js'
import { LedgerStore } from '../src/main/store/ledger.js'

const TOKEN = 'test-bearer-token'

/** Minimal seeded ledger: one source/session/turn, two calls — so the
 *  lifetime scope reports exactly 1 session / 2 calls. */
function seedLedger(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'watchtower-ledger-mcp-http-'))
  const dbPath = join(dir, 'ledger.db')
  const store = new LedgerStore(dbPath)
  store.close()

  const db = new DatabaseSync(dbPath)
  db.exec('BEGIN')
  const sourceId = Number(db.prepare(
    "INSERT INTO ledger_source (provider, env_fingerprint, file_path) VALUES ('claude', 'fp1', 'C:\\work\\.claude\\sessions.json')",
  ).run().lastInsertRowid)
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
const stores: LedgerStore[] = []
const dirs: Array<() => void> = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  for (const store of stores.splice(0)) store.close()
  for (const cleanup of dirs.splice(0)) cleanup()
})

async function serveLedger(): Promise<{ baseUrl: string }> {
  const seeded = seedLedger()
  dirs.push(seeded.cleanup)
  const store = new LedgerStore(seeded.dbPath, { readOnly: true })
  stores.push(store)
  const handler = createLedgerMcpHttpHandler(store, TOKEN)
  const server = createServer((req, res) => {
    void handler(req, res)
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
})

describe('ledger MCP transport policy (per-harness)', () => {
  it('serves Copilot over HTTP (its CLI rejects client-provided stdio servers)', () => {
    expect(ledgerMcpTransportFor('copilot')).toBe('http')
  })

  it('serves live-proven harnesses over HTTP (ADR 0027 Stage 1)', () => {
    expect(ledgerMcpTransportFor('opencode')).toBe('http')
    expect(ledgerMcpTransportFor('codex')).toBe('http')
  })

  it('serves every other harness over agent-spawned stdio, including unknown keys', () => {
    expect(ledgerMcpTransportFor('claude')).toBe('stdio')
    expect(ledgerMcpTransportFor('pi')).toBe('stdio')
    expect(ledgerMcpTransportFor('no-such-harness')).toBe('stdio')
  })
})
