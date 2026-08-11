import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { buildLedgerPrompts } from '../src/main/agents/ledger-mcp/prompts.js'
import { buildLedgerResources } from '../src/main/agents/ledger-mcp/resources.js'
import { buildLedgerTools } from '../src/main/agents/ledger-mcp/tools.js'
import { createLedgerMcpServer } from '../src/main/agents/ledger-mcp/server.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import type { OverviewScope } from '../src/shared/schemas/overview.js'
import { overviewPayloadSchema } from '../src/shared/schemas/overview.js'
import { modelsPayloadSchema } from '../src/shared/schemas/models.js'
import { skillsPayloadSchema } from '../src/shared/schemas/skills.js'
import { sessionRowSchema } from '../src/shared/schemas/views.js'

/** Builds a real ledger DB (LedgerStore creates the schema) and seeds fixture
 *  rows across two providers/sessions plus one call OUTSIDE the scope. */
function seedLedger(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'watchtower-ledger-mcp-'))
  const dbPath = join(dir, 'ledger.db')

  // Create the real schema (WAL), then close the app-side connection.
  const store = new LedgerStore(dbPath)
  store.close()

  const db = new DatabaseSync(dbPath)
  db.exec('BEGIN')
  const sourceClaude = Number(db.prepare(
    "INSERT INTO ledger_source (provider, env_fingerprint, file_path) VALUES ('claude', 'fp1', 'C:\\work\\.claude\\sessions.json')",
  ).run().lastInsertRowid)
  const sourceOpencode = Number(db.prepare(
    "INSERT INTO ledger_source (provider, env_fingerprint, file_path) VALUES ('opencode', 'fp2', 'C:\\work\\.opencode\\sessions.json')",
  ).run().lastInsertRowid)
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
  // sess-c is ENTIRELY OUT OF SCOPE (January): its own session, so the scope
  // boundary is clean across all the UI views' semantics.
  db.prepare(
    "INSERT INTO ledger_call (source_id, session_id, turn_index, call_index, provider, model, timestamp, base_cost_usd, input_tokens, output_tokens, tools_json) VALUES (?, 'sess-c', 0, 0, 'opencode', 'opencode-default', '2026-01-01T10:00:00.000Z', 9.0, 1, 1, '[]')",
  ).run(sourceOpencode)
  db.exec('COMMIT')
  db.close()

  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const cleanups: Array<() => void> = []
/** The July scope — 3 in-scope calls (0.5 + 0.3 + 0.7), 2 sessions. */
const scope: OverviewScope = { period: '30days', range: { since: '2026-07-01', until: '2026-07-31' } }

function openStore(): LedgerStore {
  const seeded = seedLedger()
  const store = new LedgerStore(seeded.dbPath, { readOnly: true })
  // Close the read-only connection BEFORE removing the fixture dir (Windows
  // holds an open-file lock on the DB while the connection is alive).
  cleanups.push(() => store.close())
  cleanups.push(seeded.cleanup)
  return store
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('Ledger MCP tools (ADR 0020) — the UI payloads over the shared seam', () => {
  it('ledger_scope reports the baked UI scope, its range, and the counts inside it', () => {
    const store = openStore()
    const tool = buildLedgerTools(store, scope).find(t => t.name === 'ledger_scope')!
    const out = tool.run({}) as { scope: OverviewScope; sessions: number; calls: number; providers: string[]; range: { startMs: number } }
    expect(out.scope).toEqual(scope)
    expect(out.sessions).toBe(2)
    expect(out.calls).toBe(3) // the January call is out of scope
    expect(out.providers).toEqual(['claude', 'opencode'])
    expect(out.range.startMs).toBeGreaterThan(0)
  })

  it('ledger_overview returns a payload that IS the UI OverviewPayload', async () => {
    const store = openStore()
    const tool = buildLedgerTools(store, scope).find(t => t.name === 'ledger_overview')!
    const out = await tool.run({})
    // The renderer's own schema validates the MCP output byte-for-byte — the
    // agent sees exactly what the Overview view shows.
    expect(overviewPayloadSchema.safeParse(out).success).toBe(true)
    const payload = overviewPayloadSchema.parse(out)
    expect(payload.kpis.calls).toBe(3)
    expect(payload.kpis.cost).toBeCloseTo(1.5)
    expect(payload.models.map(m => m.name).sort()).toEqual(['claude-sonnet', 'opencode-default'])
  })

  it('ledger_sessions returns the UI SessionRow[] shape', async () => {
    const store = openStore()
    const tool = buildLedgerTools(store, scope).find(t => t.name === 'ledger_sessions')!
    const out = await tool.run({})
    expect(sessionRowSchema.array().safeParse(out).success).toBe(true)
    const rows = sessionRowSchema.array().parse(out)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.sessionId).toBe('sess-b') // newest first
  })

  it('ledger_models returns the UI ModelsPayload with the live config applied', async () => {
    const store = openStore()
    const tool = buildLedgerTools(store, scope).find(t => t.name === 'ledger_models')!
    const out = await tool.run({})
    expect(modelsPayloadSchema.safeParse(out).success).toBe(true)
    const payload = modelsPayloadSchema.parse(out)
    expect(payload.byModel.length).toBeGreaterThan(0)
  })

  it('ledger_skills returns the UI SkillsPayload (the build-skill candidate pool)', async () => {
    const store = openStore()
    const tool = buildLedgerTools(store, scope).find(t => t.name === 'ledger_skills')!
    const out = await tool.run({})
    expect(skillsPayloadSchema.safeParse(out).success).toBe(true)
  })

  it('ledger_calls is the raw drill-down — filtered, newest first, display-priced', async () => {
    const store = openStore()
    const tool = buildLedgerTools(store, scope).find(t => t.name === 'ledger_calls')!
    const rows = tool.run({}) as Array<{
      timestamp: string
      model: string
      display_cost_usd: number
      tools: string[]
      skills: string[]
      bash_commands: string[]
    }>
    expect(rows).toHaveLength(3)
    expect(rows[0]!.timestamp).toBe('2026-07-02T10:00:00.000Z') // newest first

    const bashRows = tool.run({ tool: 'Bash' }) as Array<{ model: string }>
    expect(bashRows).toHaveLength(1)
    expect(bashRows[0]!.model).toBe('claude-sonnet')

    const modelRows = tool.run({ model: 'claude-sonnet' }) as Array<{ display_cost_usd: number }>
    expect(modelRows).toHaveLength(2)
    expect(modelRows.reduce((sum, r) => sum + r.display_cost_usd, 0)).toBeCloseTo(0.8)

    const limited = tool.run({ limit: 1 }) as unknown[]
    expect(limited).toHaveLength(1)

    // The Bash call carries its parsed tool/skill/bash evidence.
    const bashCall = rows.find(r => r.bash_commands.includes('git commit'))!
    expect(bashCall.tools).toEqual(['Read', 'Bash'])
    expect(bashCall.skills).toEqual(['git-commit'])
  })

  it('is strictly read-only — a write through the read-only connection throws', () => {
    const store = openStore()
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
    const store = openStore()
    const server = createLedgerMcpServer(store, scope)
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

    const result = await client.callTool({ name: 'ledger_overview', arguments: {} })
    const text = result.content.find(c => c.type === 'text')?.text ?? ''
    const payload = JSON.parse(text) as unknown
    expect(overviewPayloadSchema.safeParse(payload).success).toBe(true)

    const scopeResult = await client.callTool({ name: 'ledger_scope', arguments: {} })
    const scopeText = scopeResult.content.find(c => c.type === 'text')?.text ?? ''
    expect(JSON.parse(scopeText)).toMatchObject({ calls: 3, sessions: 2 })

    await client.close()
    await server.close()
  })

  it('surfaces an unknown tool as a protocol error, not a crash', async () => {
    const store = openStore()
    const server = createLedgerMcpServer(store, scope)
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
})

describe('Ledger MCP prompts (ADR 0020) — reusable preambles over the SDK', () => {
  it('coach-orient renders the MCP briefing plus a first-step nudge', () => {
    const store = openStore()
    const prompt = buildLedgerPrompts(scope).find(p => p.name === 'coach-orient')!
    const text = prompt.render({})
    expect(text).toContain('watchtower-ledger')
    expect(text).toContain('ledger_scope')
    expect(text).toContain('custom range 2026-07-01 → 2026-07-31')
    expect(text).toContain('ledger_overview')
    expect(text).toContain('Never invent numbers')
    expect(text).toContain('Call this FIRST')
    void store
  })

  it('build-skill renders the authoring prompt and validates its args against the SHARED evidence schema', () => {
    const store = openStore()
    const prompt = buildLedgerPrompts(scope).find(p => p.name === 'build-skill')!
    // Direct render() bypasses the SDK wire (which string-coerces); the shared
    // schema's native number contract applies here.
    const text = prompt.render({
      source: 'bash',
      name: 'git commit',
      frequency: 6,
      spreadSessions: 2,
      spreadProjects: 1,
      costUSD: 3.5,
      turns: 4,
    })
    expect(text).toContain('Pattern: git commit')
    expect(text).toContain('Frequency: 6 occurrences')
    expect(text).toContain('ledger_skills')
    expect(text).toContain('never invent raw transcripts')
    void store
  })

  it('refuses malformed build-skill args (the shared zod schema is the prompt contract)', () => {
    const store = openStore()
    const prompt = buildLedgerPrompts(scope).find(p => p.name === 'build-skill')!
    expect(() => prompt.render({ name: 'git commit' })).toThrow() // missing frequency, spread, cost, turns, source
    void store
  })
})

describe('Ledger MCP resources (ADR 0020) — read-only documents behind stable URIs', () => {
  it('ledger://scope reuses the ledger_scope computation and names the window', () => {
    const store = openStore()
    const resource = buildLedgerResources(store, scope).find(r => r.uri === 'ledger://scope')!
    const text = resource.read()
    expect(text).toContain('custom range 2026-07-01 → 2026-07-31')
    expect(text).toContain('Calls in scope: 3')
    expect(text).toContain('Sessions in scope: 2')
    expect(text).toContain('claude, opencode')
  })

  it('ledger://overview IS the UI Overview payload, as JSON text', () => {
    const store = openStore()
    const resource = buildLedgerResources(store, scope).find(r => r.uri === 'ledger://overview')!
    const payload = JSON.parse(resource.read()) as unknown
    expect(overviewPayloadSchema.safeParse(payload).success).toBe(true)
  })

  it('ledger://schema documents the tables, tools, resources, and prompts', () => {
    const store = openStore()
    const resource = buildLedgerResources(store, scope).find(r => r.uri === 'ledger://schema')!
    const text = resource.read()
    expect(text).toContain('ledger_call')
    expect(text).toContain('ledger_scope')
    expect(text).toContain('coach-orient')
    expect(text).toContain('build-skill')
  })
})

describe('Ledger MCP server (ADR 0020) — prompts + resources over the in-memory client', () => {
  it('lists and gets the prompt templates', async () => {
    const store = openStore()
    const server = createLedgerMcpServer(store, scope)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'ledger-mcp-test', version: '1.0.0' }, { capabilities: {} })
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const { prompts } = await client.listPrompts()
    expect(prompts.map(p => p.name)).toEqual(['coach-orient', 'build-skill'])

    const orient = await client.getPrompt({ name: 'coach-orient', arguments: {} })
    const orientText = orient.messages[0]?.content
    expect(orientText).toBeDefined()
    expect(JSON.stringify(orientText)).toContain('ledger_scope')

    // MCP prompt arguments are STRINGS on the wire (protocol constraint) —
    // the server's coercion-tolerant args schema turns them back into numbers
    // before the shared skillsProseRequestSchema validates the evidence.
    const build = await client.getPrompt({
      name: 'build-skill',
      arguments: {
        source: 'bash',
        name: 'git commit',
        frequency: '6',
        spreadSessions: '2',
        spreadProjects: '1',
        costUSD: '3.5',
        turns: '4',
      },
    })
    expect(JSON.stringify(build.messages[0]?.content)).toContain('Pattern: git commit')

    await client.close()
    await server.close()
  })

  it('lists and reads the resources', async () => {
    const store = openStore()
    const server = createLedgerMcpServer(store, scope)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'ledger-mcp-test', version: '1.0.0' }, { capabilities: {} })
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const { resources } = await client.listResources()
    expect(resources.map(r => r.uri)).toEqual(['ledger://scope', 'ledger://overview', 'ledger://schema'])

    const scopeRead = await client.readResource({ uri: 'ledger://scope' })
    const scopeText = scopeRead.contents[0] && 'text' in scopeRead.contents[0] ? scopeRead.contents[0].text : ''
    expect(scopeText).toContain('Calls in scope: 3')

    const overviewRead = await client.readResource({ uri: 'ledger://overview' })
    const overviewText = overviewRead.contents[0] && 'text' in overviewRead.contents[0] ? overviewRead.contents[0].text : ''
    expect(overviewPayloadSchema.safeParse(JSON.parse(overviewText)).success).toBe(true)

    await client.close()
    await server.close()
  })
})
