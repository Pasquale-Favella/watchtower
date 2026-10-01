import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { buildLedgerPrompts } from '../src/main/agents/ledger-mcp/prompts.js'
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

const cleanups: Array<() => void> = []
/** A windowed scope — passed to the tools as their optional `scope` argument.
 *  3 in-scope calls (0.5 + 0.3 + 0.7), 2 sessions. */
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

describe('Ledger MCP tools (ADR 0020) — lifetime-serving over the shared seam', () => {
  it('serves the FULL lifetime ledger by default — nothing is baked at spawn', () => {
    const store = openStore()
    const scopeTool = buildLedgerTools(store).find(t => t.name === 'ledger_scope')!
    const out = scopeTool.run({}) as { scope: OverviewScope; sessions: number; calls: number }
    expect(out.scope).toEqual({ period: 'lifetime' })
    expect(out.sessions).toBe(3) // the January session is in scope now
    expect(out.calls).toBe(4)
  })

  it('ledger_scope reports the window a query is scoped to (optional scope arg)', () => {
    const store = openStore()
    const tool = buildLedgerTools(store).find(t => t.name === 'ledger_scope')!
    const out = tool.run({ scope }) as {
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

  it('degrades a malformed scope argument to the lifetime window (never a crash)', () => {
    const store = openStore()
    const tool = buildLedgerTools(store).find(t => t.name === 'ledger_scope')!
    // Belt-and-suspenders: the SDK rejects bad args over the wire, but a
    // direct caller passing garbage still gets a sane lifetime answer.
    const out = tool.run({ scope: { period: 'nope' } }) as { scope: OverviewScope; calls: number }
    expect(out.scope).toEqual({ period: 'lifetime' })
    expect(out.calls).toBe(4)
  })

  it('ledger_overview returns a payload that IS the UI OverviewPayload', async () => {
    const store = openStore()
    const tool = buildLedgerTools(store).find(t => t.name === 'ledger_overview')!
    const out = await tool.run({ scope })
    // The renderer's own schema validates the MCP output byte-for-byte — the
    // agent sees exactly what the Overview view shows for that window.
    expect(overviewPayloadSchema.safeParse(out).success).toBe(true)
    const payload = overviewPayloadSchema.parse(out)
    expect(payload.kpis.calls).toBe(3)
    expect(payload.kpis.cost).toBeCloseTo(1.5)
    expect(payload.models.map(m => m.name).sort()).toEqual(['claude-sonnet', 'opencode-default'])
  })

  it('ledger_overview with no scope argument spans the whole ledger', async () => {
    const store = openStore()
    const tool = buildLedgerTools(store).find(t => t.name === 'ledger_overview')!
    const payload = overviewPayloadSchema.parse(await tool.run({}))
    expect(payload.kpis.calls).toBe(4)
    expect(payload.kpis.sessions).toBe(3)
    expect(payload.kpis.cost).toBeCloseTo(10.5)
  })

  it('ledger_sessions returns the UI SessionRow[] shape for the requested scope', async () => {
    const store = openStore()
    const tool = buildLedgerTools(store).find(t => t.name === 'ledger_sessions')!
    const out = await tool.run({ scope })
    const decoded = Schema.decodeUnknownResult(Schema.mutable(Schema.Array(sessionRowSchema)))(out)
    expect(decoded._tag).toBe('Success')
    if (decoded._tag === 'Failure') throw new Error('MCP session rows did not match the UI schema')
    const rows = decoded.success
    expect(rows).toHaveLength(2)
    expect(rows[0]!.sessionId).toBe('sess-b') // newest first
  })

  it('ledger_models returns the UI ModelsPayload with the live config applied', async () => {
    const store = openStore()
    const tool = buildLedgerTools(store).find(t => t.name === 'ledger_models')!
    const out = await tool.run({ scope })
    const decoded = Schema.decodeUnknownResult(modelsPayloadSchema)(out)
    expect(decoded._tag).toBe('Success')
    if (decoded._tag === 'Failure') throw new Error('MCP model payload did not match the UI schema')
    const payload = decoded.success
    expect(payload.byModel.length).toBeGreaterThan(0)
  })

  it('ledger_skills returns the UI SkillsPayload (the suggested-skill pool the craft chips surface)', async () => {
    const store = openStore()
    const tool = buildLedgerTools(store).find(t => t.name === 'ledger_skills')!
    const out = await tool.run({ scope })
    expect(skillsPayloadSchema.safeParse(out).success).toBe(true)
  })

  it('ledger_calls is the raw drill-down — filtered, newest first, display-priced', async () => {
    const store = openStore()
    const tool = buildLedgerTools(store).find(t => t.name === 'ledger_calls')!
    const rows = tool.run({ scope }) as Array<{
      timestamp: string
      model: string
      display_cost_usd: number
      tools: string[]
      skills: string[]
      bash_commands: string[]
    }>
    expect(rows).toHaveLength(3)
    expect(rows[0]!.timestamp).toBe('2026-07-02T10:00:00.000Z') // newest first

    const bashRows = tool.run({ scope, tool: 'Bash' }) as Array<{ model: string }>
    expect(bashRows).toHaveLength(1)
    expect(bashRows[0]!.model).toBe('claude-sonnet')

    const modelRows = tool.run({ scope, model: 'claude-sonnet' }) as Array<{ display_cost_usd: number }>
    expect(modelRows).toHaveLength(2)
    expect(modelRows.reduce((sum, r) => sum + r.display_cost_usd, 0)).toBeCloseTo(0.8)

    const limited = tool.run({ scope, limit: 1 }) as unknown[]
    expect(limited).toHaveLength(1)

    // No scope arg → lifetime: the January call joins the drill-down.
    const lifetimeRows = tool.run({}) as unknown[]
    expect(lifetimeRows).toHaveLength(4)

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
    const server = createLedgerMcpServer(store)
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
    const content = z.array(z.object({ type: z.string(), text: z.string().optional() })).parse(result.content)
    const text = content.find(c => c.type === 'text')?.text ?? ''
    const payload = JSON.parse(text) as unknown
    expect(overviewPayloadSchema.safeParse(payload).success).toBe(true)

    // Scoped over the wire: the harness filters autonomously via `scope`.
    const scopeResult = await client.callTool({ name: 'ledger_scope', arguments: { scope } })
    const scopeContent = z.array(z.object({ type: z.string(), text: z.string().optional() })).parse(scopeResult.content)
    const scopeText = scopeContent.find(c => c.type === 'text')?.text ?? ''
    expect(JSON.parse(scopeText)).toMatchObject({ calls: 3, sessions: 2 })

    await client.close()
    await server.close()
  })

  it('surfaces an unknown tool as a protocol error, not a crash', async () => {
    const store = openStore()
    const server = createLedgerMcpServer(store)
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
  it('coach-orient renders the lifetime MCP briefing plus a first-step nudge', () => {
    const store = openStore()
    const prompt = buildLedgerPrompts().find(p => p.name === 'coach-orient')!
    const text = prompt.render({})
    expect(text).toContain('watchtower-ledger')
    expect(text).toContain('ledger_scope')
    expect(text).toContain('FULL usage history')
    expect(text).toContain('scope')
    expect(text).toContain('ledger_overview')
    expect(text).toContain('Never invent numbers')
    expect(text).toContain('Call this FIRST')
    // The served prompt also carries the state-the-window transparency rule.
    expect(text).toContain('Say which window you queried')
    void store
  })

  it('coach-orient carries the TWO-scope role — skill authoring needs no separate prompt (the build-skill mode is gone)', () => {
    const store = openStore()
    const prompt = buildLedgerPrompts().find(p => p.name === 'coach-orient')!
    const text = prompt.render({})
    expect(text).toContain('TWO scopes')
    expect(text).toContain('Skill authoring')
    // Evidence-first authoring: the ledger tools ride the prompt, the shape
    // is the harness's own conventions (no section template).
    expect(text).toContain('ledger_calls')
    expect(text).toContain('no template needed here')
    expect(text).not.toContain('## Description')
    void store
  })
})

describe('Ledger MCP resources (ADR 0020) — read-only documents behind stable URIs', () => {
  it('ledger://scope names the lifetime window and reuses the ledger_scope computation', () => {
    const store = openStore()
    const resource = buildLedgerResources(store).find(r => r.uri === 'ledger://scope')!
    const text = resource.read()
    expect(text).toContain('Lifetime · all providers')
    expect(text).toContain('Calls: 4')
    expect(text).toContain('Sessions: 3')
    expect(text).toContain('claude, opencode')
  })

  it('ledger://overview IS the lifetime UI Overview payload, as JSON text', () => {
    const store = openStore()
    const resource = buildLedgerResources(store).find(r => r.uri === 'ledger://overview')!
    const payload = JSON.parse(resource.read()) as unknown
    expect(overviewPayloadSchema.safeParse(payload).success).toBe(true)
    expect(overviewPayloadSchema.parse(payload).kpis.calls).toBe(4)
  })

  it('ledger://schema documents the tables, tools, resources, and prompts', () => {
    const store = openStore()
    const resource = buildLedgerResources(store).find(r => r.uri === 'ledger://schema')!
    const text = resource.read()
    expect(text).toContain('ledger_call')
    expect(text).toContain('ledger_scope')
    expect(text).toContain('coach-orient')
    // The build-skill prompt is gone — the schema resource no longer lists it.
    expect(text).not.toContain('build-skill')
  })
})

describe('Ledger MCP server (ADR 0020) — prompts + resources over the in-memory client', () => {
  it('lists and gets the prompt templates', async () => {
    const store = openStore()
    const server = createLedgerMcpServer(store)
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
    const store = openStore()
    const server = createLedgerMcpServer(store)
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
    expect(overviewPayloadSchema.safeParse(JSON.parse(overviewText)).success).toBe(true)

    await client.close()
    await server.close()
  })
})
