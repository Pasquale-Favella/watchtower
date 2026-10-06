import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server as HttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PassThrough } from 'node:stream'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolResultSchema,
  ContentBlockSchema,
  EmptyResultSchema,
  type JSONRPCMessage,
  JSONRPCMessageSchema,
} from '@modelcontextprotocol/sdk/types.js'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { bearerHeaderValue } from '../src/main/agents/ledger-mcp/auth.js'
import { createLedgerMcpHttpHandler } from '../src/main/agents/ledger-mcp/http-server.js'
import { buildLedgerPrompts } from '../src/main/agents/ledger-mcp/prompts.js'
import { createLedgerMcpQueryRuntime } from '../src/main/agents/ledger-mcp/query-runtime.js'
import { buildLedgerResources } from '../src/main/agents/ledger-mcp/resources.js'
import { createLedgerMcpServer } from '../src/main/agents/ledger-mcp/server.js'
import { buildLedgerTools } from '../src/main/agents/ledger-mcp/tools.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import { modelsPayloadSchema } from '../src/shared/schemas/models.js'
import type { OverviewScope } from '../src/shared/schemas/overview.js'
import { overviewPayloadSchema } from '../src/shared/schemas/overview.js'
import { skillsPayloadSchema } from '../src/shared/schemas/skills.js'
import { sessionRowSchema } from '../src/shared/schemas/views.js'

/** Builds a real ledger DB (LedgerStore creates the schema) and seeds fixture
 *  rows across two providers/sessions plus one call OUTSIDE any windowed
 *  scope (January) — so a scope-filtered query sees 2 sessions / 3 calls and
 *  the lifetime view sees all 3 sessions / 4 calls. */
function seedLedger(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'watchtower-ledger-mcp-'))
  const dbPath = join(dir, 'ledger.db')

  // Create the real schema (WAL), then close the app-side connection.
  const store = new LedgerStore(dbPath)
  store.close()

  const db = new DatabaseSync(dbPath)
  db.exec('BEGIN')
  const sourceClaude = Number(
    db
      .prepare(
        "INSERT INTO ledger_source (provider, env_fingerprint, file_path) VALUES ('claude', 'fp1', 'C:\\work\\.claude\\sessions.json')",
      )
      .run().lastInsertRowid,
  )
  const sourceOpencode = Number(
    db
      .prepare(
        "INSERT INTO ledger_source (provider, env_fingerprint, file_path) VALUES ('opencode', 'fp2', 'C:\\work\\.opencode\\sessions.json')",
      )
      .run().lastInsertRowid,
  )
  db.prepare(
    "INSERT INTO ledger_session (source_id, session_id, project, working_directory, agent_type, title) VALUES (?, 'sess-a', 'watchtower', 'C:\\work', 'claude', 'Fix bug')",
  ).run(sourceClaude)
  db.prepare(
    "INSERT INTO ledger_session (source_id, session_id, project, working_directory, agent_type, title) VALUES (?, 'sess-b', 'watchtower', 'C:\\work', 'opencode', 'Add tests')",
  ).run(sourceOpencode)
  db.prepare(
    "INSERT INTO ledger_session (source_id, session_id, project, working_directory, agent_type, title) VALUES (?, 'sess-c', 'other', 'C:\\other', 'opencode', 'Old work')",
  ).run(sourceOpencode)
  db.prepare(
    "INSERT INTO ledger_turn (source_id, session_id, turn_index, timestamp, user_message, category, sub_category) VALUES (?, 'sess-a', 0, '2026-07-01T10:00:00.000Z', 'fix this', 'debugging', 'git-commit')",
  ).run(sourceClaude)
  db.prepare(
    "INSERT INTO ledger_turn (source_id, session_id, turn_index, timestamp, user_message, category) VALUES (?, 'sess-b', 0, '2026-07-02T10:00:00.000Z', 'add tests', 'testing')",
  ).run(sourceOpencode)
  db.prepare(
    "INSERT INTO ledger_turn (source_id, session_id, turn_index, timestamp, user_message, category) VALUES (?, 'sess-c', 0, '2026-01-01T10:00:00.000Z', 'old stuff', 'planning')",
  ).run(sourceOpencode)
  db.prepare(
    `INSERT INTO ledger_call (source_id, session_id, turn_index, call_index, provider, model, timestamp, base_cost_usd, savings_usd,
       input_tokens, output_tokens, tools_json, skills_json, bash_commands_json, subagent_types_json)
     VALUES (?, 'sess-a', 0, 0, 'claude', 'claude-sonnet', '2026-07-01T10:00:00.000Z', 0.5, 0.2,
       1000, 500, '["Read","Bash"]', '["git-commit"]', '["git commit"]', '[]')`,
  ).run(sourceClaude)
  db.prepare(
    "INSERT INTO ledger_call (source_id, session_id, turn_index, call_index, provider, model, timestamp, base_cost_usd, input_tokens, output_tokens, tools_json) VALUES (?, 'sess-a', 0, 1, 'claude', 'claude-sonnet', '2026-07-01T10:01:00.000Z', 0.3, 100, 50, '[\"Read\"]')",
  ).run(sourceClaude)
  db.prepare(
    "INSERT INTO ledger_call (source_id, session_id, turn_index, call_index, provider, model, timestamp, base_cost_usd, input_tokens, output_tokens, tools_json) VALUES (?, 'sess-b', 0, 0, 'opencode', 'opencode-default', '2026-07-02T10:00:00.000Z', 0.7, 2000, 1000, '[\"Edit\"]')",
  ).run(sourceOpencode)
  // sess-c is OUTSIDE any windowed scope (January): its own session, so the
  // scope boundary is clean across all the UI views' semantics — and the
  // LIFETIME view proves the server really serves everything.
  db.prepare(
    "INSERT INTO ledger_call (source_id, session_id, turn_index, call_index, provider, model, timestamp, base_cost_usd, input_tokens, output_tokens, tools_json) VALUES (?, 'sess-c', 0, 0, 'opencode', 'opencode-default', '2026-01-01T10:00:00.000Z', 9.0, 1, 1, '[]')",
  ).run(sourceOpencode)
  db.exec('COMMIT')
  db.close()

  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const cleanups: Array<() => void | Promise<void>> = []
const httpServers: HttpServer[] = []
/** A windowed scope — passed to the tools as their optional `scope` argument.
 *  3 in-scope calls (0.5 + 0.3 + 0.7), 2 sessions. */
const scope: OverviewScope = { period: '30days', range: { since: '2026-07-01', until: '2026-07-31' } }

async function openStore() {
  const seeded = seedLedger()
  const store = new LedgerStore(seeded.dbPath, { readOnly: true })
  const runtime = await createLedgerMcpQueryRuntime(seeded.dbPath)
  // Close the read-only connection BEFORE removing the fixture dir (Windows
  // holds an open-file lock on the DB while the connection is alive).
  cleanups.push(runtime.dispose)
  cleanups.push(() => store.close())
  cleanups.push(seeded.cleanup)
  return { queries: runtime.queries, store, dbPath: seeded.dbPath }
}

function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown): S['Type'] {
  const result = Schema.decodeUnknownResult(schema)(input)
  if (result._tag === 'Failure') throw new Error('MCP payload did not match the shared Effect Schema')
  return result.success
}

function textContent(content: unknown): string | undefined {
  return ContentBlockSchema.array()
    .parse(content)
    .find(item => item.type === 'text')?.text
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of httpServers.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** A real SDK Client stream bridge for tests: the server uses the official
 *  newline-delimited StdioServerTransport, with isolated in-memory streams. */
class StdioClientBridge implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: Transport['onmessage']
  private buffered = ''

  constructor(
    private readonly stdin: PassThrough,
    private readonly stdout: PassThrough,
  ) {}

  async start(): Promise<void> {
    this.stdout.on('data', this.onData)
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.stdin.write(`${JSON.stringify(message)}\n`)
  }

  async close(): Promise<void> {
    this.stdout.off('data', this.onData)
    this.stdin.end()
    this.onclose?.()
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffered += chunk.toString('utf8')
    while (true) {
      const newline = this.buffered.indexOf('\n')
      if (newline < 0) return
      const line = this.buffered.slice(0, newline)
      this.buffered = this.buffered.slice(newline + 1)
      try {
        this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)))
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error('Invalid SDK stdio message'))
      }
    }
  }
}

describe('Ledger MCP tools (ADR 0020) — lifetime-serving over the shared seam', () => {
  it('serves the FULL lifetime ledger by default — nothing is baked at spawn', async () => {
    const { queries } = await openStore()
    const scopeTool = buildLedgerTools(queries).find(t => t.name === 'ledger_scope')!
    const out = (await scopeTool.run({})) as { scope: OverviewScope; sessions: number; calls: number }
    expect(out.scope).toEqual({ period: 'lifetime' })
    expect(out.sessions).toBe(3) // the January session is in scope now
    expect(out.calls).toBe(4)
  })

  it('ledger_scope reports the window a query is scoped to (optional scope arg)', async () => {
    const { queries } = await openStore()
    const tool = buildLedgerTools(queries).find(t => t.name === 'ledger_scope')!
    const out = (await tool.run({ scope })) as {
      scope: OverviewScope
      sessions: number
      calls: number
      providers: string[]
      range: { startMs: number }
    }
    expect(out.scope).toEqual(scope)
    expect(out.sessions).toBe(2)
    expect(out.calls).toBe(3) // the January call is out of the window
    expect(out.providers).toEqual(['claude', 'opencode'])
    expect(out.range.startMs).toBeGreaterThan(0)
  })

  it('reads ledger changes on the next tool call instead of keeping a request cache', async () => {
    const { queries, dbPath } = await openStore()
    const facadeReads = [
      vi.spyOn(LedgerStore.prototype, 'getSessions'),
      vi.spyOn(LedgerStore.prototype, 'getTurns'),
      vi.spyOn(LedgerStore.prototype, 'getCalls'),
      vi.spyOn(LedgerStore.prototype, 'getCallFacts'),
    ]
    const writer = new DatabaseSync(dbPath)
    // Close the writer before the fixture cleanup removes the SQLite directory.
    cleanups.splice(cleanups.length - 1, 0, () => writer.close())
    writer
      .prepare(
        `INSERT INTO ledger_call (source_id, session_id, turn_index, call_index, provider, model, timestamp, base_cost_usd)
         VALUES (1, 'sess-a', 0, 2, 'claude', 'claude-sonnet', '2026-07-01T10:02:00.000Z', 0.1)`,
      )
      .run()

    const tool = buildLedgerTools(queries).find(definition => definition.name === 'ledger_scope')!
    const out = (await tool.run({})) as { sessions: number; calls: number }
    expect(out).toMatchObject({ sessions: 3, calls: 5 })
    const scopeResource = buildLedgerResources(queries).find(resource => resource.uri === 'ledger://scope')!
    expect(await scopeResource.read()).toContain('Calls: 5')
    expect(facadeReads.every(read => read.mock.calls.length === 0)).toBe(true)
  })

  it('rejects a malformed scope argument through the tool contract', async () => {
    const { queries } = await openStore()
    const scopeQuery = vi.spyOn(queries, 'scope')
    const tool = buildLedgerTools(queries).find(t => t.name === 'ledger_scope')!
    expect(() => tool.run({ scope: { period: 'nope' } })).toThrow('Invalid arguments for tool ledger_scope')
    expect(scopeQuery).not.toHaveBeenCalled()
  })

  it('ledger_overview returns a payload that IS the UI OverviewPayload', async () => {
    const { queries } = await openStore()
    const tool = buildLedgerTools(queries).find(t => t.name === 'ledger_overview')!
    const out = await tool.run({ scope })
    // The renderer's own schema validates the MCP output byte-for-byte — the
    // agent sees exactly what the Overview view shows for that window.
    const payload = decode(overviewPayloadSchema, out)
    expect(payload.kpis.calls).toBe(3)
    expect(payload.kpis.cost).toBeCloseTo(1.5)
    expect(payload.models.map(m => m.name).sort()).toEqual(['claude-sonnet', 'opencode-default'])
  })

  it('ledger_overview with no scope argument spans the whole ledger', async () => {
    const { queries } = await openStore()
    const tool = buildLedgerTools(queries).find(t => t.name === 'ledger_overview')!
    const payload = decode(overviewPayloadSchema, await tool.run({}))
    expect(payload.kpis.calls).toBe(4)
    expect(payload.kpis.sessions).toBe(3)
    expect(payload.kpis.cost).toBeCloseTo(10.5)
  })

  it('ledger_sessions returns the UI SessionRow[] shape for the requested scope', async () => {
    const { queries } = await openStore()
    const tool = buildLedgerTools(queries).find(t => t.name === 'ledger_sessions')!
    const out = await tool.run({ scope })
    const decoded = Schema.decodeUnknownResult(Schema.mutable(Schema.Array(sessionRowSchema)))(out)
    expect(decoded._tag).toBe('Success')
    if (decoded._tag === 'Failure') throw new Error('MCP session rows did not match the UI schema')
    const rows = decoded.success
    expect(rows).toHaveLength(2)
    expect(rows[0]!.sessionId).toBe('sess-b') // newest first
  })

  it('ledger_models returns the UI ModelsPayload with the live config applied', async () => {
    const { queries } = await openStore()
    const tool = buildLedgerTools(queries).find(t => t.name === 'ledger_models')!
    const out = await tool.run({ scope })
    const decoded = Schema.decodeUnknownResult(modelsPayloadSchema)(out)
    expect(decoded._tag).toBe('Success')
    if (decoded._tag === 'Failure') throw new Error('MCP model payload did not match the UI schema')
    const payload = decoded.success
    expect(payload.byModel.length).toBeGreaterThan(0)
  })

  it('ledger_skills returns the UI SkillsPayload (the suggested-skill pool the craft chips surface)', async () => {
    const { queries } = await openStore()
    const tool = buildLedgerTools(queries).find(t => t.name === 'ledger_skills')!
    const out = await tool.run({ scope })
    expect(Schema.decodeUnknownResult(skillsPayloadSchema)(out)._tag).toBe('Success')
  })

  it('ledger_calls is the raw drill-down — filtered, newest first, display-priced', async () => {
    const { queries } = await openStore()
    const tool = buildLedgerTools(queries).find(t => t.name === 'ledger_calls')!
    const rows = (await tool.run({ scope })) as Array<{
      timestamp: string
      model: string
      display_cost_usd: number
      tools: string[]
      skills: string[]
      bash_commands: string[]
    }>
    expect(rows).toHaveLength(3)
    expect(rows[0]!.timestamp).toBe('2026-07-02T10:00:00.000Z') // newest first

    const bashRows = (await tool.run({ scope, tool: 'Bash' })) as Array<{ model: string }>
    expect(bashRows).toHaveLength(1)
    expect(bashRows[0]!.model).toBe('claude-sonnet')

    const modelRows = (await tool.run({ scope, model: 'claude-sonnet' })) as Array<{ display_cost_usd: number }>
    expect(modelRows).toHaveLength(2)
    expect(modelRows.reduce((sum, r) => sum + r.display_cost_usd, 0)).toBeCloseTo(0.8)

    const limited = (await tool.run({ scope, limit: 1 })) as unknown[]
    expect(limited).toHaveLength(1)

    // No scope arg → lifetime: the January call joins the drill-down.
    const lifetimeRows = (await tool.run({})) as unknown[]
    expect(lifetimeRows).toHaveLength(4)

    // The Bash call carries its parsed tool/skill/bash evidence.
    const bashCall = rows.find(r => r.bash_commands.includes('git commit'))!
    expect(bashCall.tools).toEqual(['Read', 'Bash'])
    expect(bashCall.skills).toEqual(['git-commit'])
  })

  it('is strictly read-only — a write through the read-only connection throws', async () => {
    const { store } = await openStore()
    expect(() => {
      store.getSources() // reads fine
    }).not.toThrow()
    const db = (store as unknown as { db: DatabaseSync }).db
    expect(() => {
      db.prepare("INSERT INTO ledger_source (provider, env_fingerprint, file_path) VALUES ('x', 'y', 'z')").run()
    }).toThrow()
  })
})

describe('Ledger MCP server (ADR 0020) — official SDK over an in-memory transport', () => {
  it('registers the six tools and answers a tools/call with a UI-valid payload', async () => {
    const { queries } = await openStore()
    const server = createLedgerMcpServer(queries)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'ledger-mcp-test', version: '1.0.0' }, { capabilities: {} })
    // The in-memory transport delivers only once both peers read — the server
    // must connect before the client sends its initialize handshake.
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const { tools } = await client.listTools()
    expect(tools.map(t => t.name)).toEqual([
      'ledger_scope',
      'ledger_overview',
      'ledger_sessions',
      'ledger_models',
      'ledger_skills',
      'ledger_calls',
    ])

    const result = await client.callTool({ name: 'ledger_overview', arguments: {} }, CallToolResultSchema)
    const text = textContent(result.content) ?? ''
    const payload = JSON.parse(text) as unknown
    expect(decode(overviewPayloadSchema, payload)).toBeDefined()

    // Scoped over the wire: the harness filters autonomously via `scope`.
    const scopeResult = await client.callTool({ name: 'ledger_scope', arguments: { scope } }, CallToolResultSchema)
    const scopeText = textContent(scopeResult.content) ?? ''
    expect(JSON.parse(scopeText)).toMatchObject({ calls: 3, sessions: 2 })

    await client.close()
    await server.close()
    // Closing the protocol connection must leave the borrowed query runtime
    // available to its owner.
    expect((await queries.scope({ period: 'lifetime' })).sessions).toBe(3)
  })

  it('surfaces an unknown tool as a protocol error, not a crash', async () => {
    const { queries } = await openStore()
    const server = createLedgerMcpServer(queries)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'ledger-mcp-test', version: '1.0.0' }, { capabilities: {} })
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    // The SDK answers an unknown tool as an isError RESULT (never a crash).
    const result = await client.callTool({ name: 'ghost', arguments: {} })
    expect(result.isError).toBe(true)

    await client.close()
    await server.close()
  })

  it('advertises input metadata from the Effect tool contracts and preserves call error categories', async () => {
    const { queries, store } = await openStore()
    const server = createLedgerMcpServer(queries)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'ledger-mcp-test', version: '1.0.0' }, { capabilities: {} })
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const { tools } = await client.listTools()
    const calls = tools.find(tool => tool.name === 'ledger_calls')!
    expect(calls.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        scope: {
          type: 'object',
          properties: {
            period: { enum: ['today', 'week', '30days', 'month', 'all', 'lifetime'] },
            provider: { type: 'string' },
            range: { type: 'object' },
          },
        },
        model: { type: 'string' },
        project: { type: 'string' },
        category: { type: 'string' },
        tool: { type: 'string' },
      },
    })
    expect(calls.inputSchema.required ?? []).not.toContain('scope')

    for (const name of [
      'ledger_scope',
      'ledger_overview',
      'ledger_sessions',
      'ledger_models',
      'ledger_skills',
      'ledger_calls',
    ]) {
      const result = await client.callTool({ name, arguments: {} }, CallToolResultSchema)
      expect(result.isError).not.toBe(true)
      expect(JSON.parse(textContent(result.content) ?? 'null')).toBeDefined()
    }

    // SDK-level unknown-tool lookup and Effect argument failures are tool
    // results. They do not become JSON-RPC protocol errors.
    expect((await client.callTool({ name: 'ghost', arguments: {} })).isError).toBe(true)
    expect((await client.callTool({ name: 'ledger_scope', arguments: { scope: { period: 'nope' } } })).isError).toBe(
      true,
    )
    expect(
      (await client.callTool({ name: 'ledger_scope', arguments: { scope: { period: 'lifetime', provider: null } } }))
        .isError,
    ).toBe(true)
    expect((await client.callTool({ name: 'ledger_calls', arguments: { limit: 0 } })).isError).toBe(true)
    expect((await client.callTool({ name: 'ledger_calls', arguments: { limit: 1.5 } })).isError).toBe(true)
    expect((await client.callTool({ name: 'ledger_calls', arguments: { limit: '2' } })).isError).toBe(true)

    vi.spyOn(queries, 'models').mockImplementation(async () => {
      throw new Error('configuration unavailable')
    })
    expect((await client.callTool({ name: 'ledger_models', arguments: {} })).isError).toBe(true)

    // Resource and prompt lookup failures remain SDK InvalidParams errors.
    await expect(client.readResource({ uri: 'ledger://missing' })).rejects.toMatchObject({ code: -32602 })
    await expect(client.getPrompt({ name: 'missing', arguments: {} })).rejects.toMatchObject({ code: -32602 })
    await expect(
      client.request({ method: 'not/a-method', params: {} } as never, EmptyResultSchema),
    ).rejects.toMatchObject({ code: -32601 })
    await expect(
      client.request(
        { method: 'tools/call', params: { name: 'ledger_scope', arguments: [] } } as never,
        EmptyResultSchema,
      ),
    ).rejects.toMatchObject({ code: expect.any(Number) })

    await client.close()
    await server.close()
    expect(store.getSources()).toHaveLength(2)
  })
})

describe('Ledger MCP server (ADR 0020) — official stdio transport', () => {
  it('negotiates, answers a real client, and closes transport ownership without closing the store', async () => {
    const { queries } = await openStore()
    const server = createLedgerMcpServer(queries)
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const serverTransport = new StdioServerTransport(stdin, stdout)
    const client = new Client({ name: 'ledger-mcp-stdio-test', version: '1.0.0' }, { capabilities: {} })
    await server.connect(serverTransport)
    await client.connect(new StdioClientBridge(stdin, stdout))

    expect((await client.listTools()).tools).toHaveLength(6)
    const scopeResult = await client.callTool({ name: 'ledger_scope', arguments: {} }, CallToolResultSchema)
    expect(JSON.parse(textContent(scopeResult.content) ?? 'null')).toMatchObject({ calls: 4 })

    await client.close()
    await server.close()
    expect(stdin.listenerCount('data')).toBe(0)
    expect((await queries.scope({ period: 'lifetime' })).sessions).toBe(3)
  })
})

describe('Ledger MCP server (ADR 0020) — stateless Streamable HTTP transport', () => {
  it('serves tools, resources, and prompts over real HTTP requests and releases only per-request transports', async () => {
    const { queries } = await openStore()
    const closeTransport = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close')
    const token = 'ledger-mcp-http-test-token'
    const handler = createLedgerMcpHttpHandler(queries, token)
    const httpServer = createServer((request, response) => {
      void handler(request, response)
    })
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
    const address = httpServer.address()
    if (typeof address !== 'object' || !address) throw new Error('No HTTP listener address')
    httpServers.push(httpServer)

    const client = new Client({ name: 'ledger-mcp-http-test', version: '1.0.0' }, { capabilities: {} })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
        requestInit: { headers: { authorization: bearerHeaderValue(token) } },
      }),
    )

    expect((await client.listTools()).tools).toHaveLength(6)
    expect((await client.listResources()).resources.map(resource => resource.uri)).toEqual([
      'ledger://scope',
      'ledger://overview',
      'ledger://schema',
    ])
    expect((await client.listPrompts()).prompts.map(prompt => prompt.name)).toEqual(['coach-orient'])
    const scopeResult = await client.callTool({ name: 'ledger_scope', arguments: {} }, CallToolResultSchema)
    expect(JSON.parse(textContent(scopeResult.content) ?? 'null')).toMatchObject({ calls: 4 })
    expect((await client.readResource({ uri: 'ledger://scope' })).contents).toHaveLength(1)
    expect((await client.getPrompt({ name: 'coach-orient', arguments: {} })).messages).toHaveLength(1)

    await client.close()
    // initialize + initialized notification + six list/call/read/get requests
    // each own one stateless transport, all closed after their response.
    expect(closeTransport).toHaveBeenCalledTimes(8)
    expect((await queries.scope({ period: 'lifetime' })).sessions).toBe(3)
  })
})

describe('Ledger MCP prompts (ADR 0020) — reusable preambles over the SDK', () => {
  it('coach-orient renders the lifetime MCP briefing plus a first-step nudge', async () => {
    const prompt = buildLedgerPrompts().find(p => p.name === 'coach-orient')!
    const text = prompt.render()
    expect(text).toContain('watchtower-ledger')
    expect(text).toContain('ledger_scope')
    expect(text).toContain('FULL usage history')
    expect(text).toContain('scope')
    expect(text).toContain('ledger_overview')
    expect(text).toContain('Never invent numbers')
    expect(text).toContain('Call this FIRST')
    // The served prompt also carries the state-the-window transparency rule.
    expect(text).toContain('Say which window you queried')
  })

  it('coach-orient carries the TWO-scope role — skill authoring needs no separate prompt (the build-skill mode is gone)', async () => {
    const prompt = buildLedgerPrompts().find(p => p.name === 'coach-orient')!
    const text = prompt.render()
    expect(text).toContain('TWO scopes')
    expect(text).toContain('Skill authoring')
    // Evidence-first authoring: the ledger tools ride the prompt, the shape
    // is the harness's own conventions (no section template).
    expect(text).toContain('ledger_calls')
    expect(text).toContain('no template needed here')
    expect(text).not.toContain('## Description')
  })
})

describe('Ledger MCP resources (ADR 0020) — read-only documents behind stable URIs', () => {
  it('ledger://scope names the lifetime window and reuses the ledger_scope computation', async () => {
    const { queries } = await openStore()
    const resource = buildLedgerResources(queries).find(r => r.uri === 'ledger://scope')!
    const text = await resource.read()
    expect(text).toContain('Lifetime · all providers')
    expect(text).toContain('Calls: 4')
    expect(text).toContain('Sessions: 3')
    expect(text).toContain('claude, opencode')
  })

  it('ledger://overview IS the lifetime UI Overview payload, as JSON text', async () => {
    const { queries } = await openStore()
    const resource = buildLedgerResources(queries).find(r => r.uri === 'ledger://overview')!
    const payload = JSON.parse(await resource.read()) as unknown
    expect(decode(overviewPayloadSchema, payload).kpis.calls).toBe(4)
  })

  it('ledger://schema documents the tables, tools, resources, and prompts', async () => {
    const { queries } = await openStore()
    const resource = buildLedgerResources(queries).find(r => r.uri === 'ledger://schema')!
    const text = await resource.read()
    expect(text).toContain('ledger_call')
    expect(text).toContain('ledger_scope')
    expect(text).toContain('coach-orient')
    // The build-skill prompt is gone — the schema resource no longer lists it.
    expect(text).not.toContain('build-skill')
  })
})

describe('Ledger MCP server (ADR 0020) — prompts + resources over the in-memory client', () => {
  it('lists and gets the prompt templates', async () => {
    const { queries } = await openStore()
    const server = createLedgerMcpServer(queries)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'ledger-mcp-test', version: '1.0.0' }, { capabilities: {} })
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const { prompts } = await client.listPrompts()
    // The build-skill prompt was deleted — the one coach briefing serves both
    // scopes, so only coach-orient remains.
    expect(prompts.map(p => p.name)).toEqual(['coach-orient'])

    const orient = await client.getPrompt({ name: 'coach-orient', arguments: {} })
    const orientText = orient.messages[0]?.content
    expect(orientText).toBeDefined()
    expect(JSON.stringify(orientText)).toContain('ledger_scope')

    await client.close()
    await server.close()
  })

  it('lists and reads the resources', async () => {
    const { queries } = await openStore()
    const server = createLedgerMcpServer(queries)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'ledger-mcp-test', version: '1.0.0' }, { capabilities: {} })
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const { resources } = await client.listResources()
    expect(resources.map(r => r.uri)).toEqual(['ledger://scope', 'ledger://overview', 'ledger://schema'])

    const scopeRead = await client.readResource({ uri: 'ledger://scope' })
    const scopeText = scopeRead.contents[0] && 'text' in scopeRead.contents[0] ? scopeRead.contents[0].text : ''
    expect(scopeText).toContain('Calls: 4')

    const overviewRead = await client.readResource({ uri: 'ledger://overview' })
    const overviewText =
      overviewRead.contents[0] && 'text' in overviewRead.contents[0] ? overviewRead.contents[0].text : ''
    expect(decode(overviewPayloadSchema, JSON.parse(overviewText))).toBeDefined()

    await client.close()
    await server.close()
  })
})
