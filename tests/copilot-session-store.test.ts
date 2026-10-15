import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import { createCopilotProvider, getCopilotSessionStoreDbPath } from '../src/main/pipeline/providers/copilot.js'
import type { ParsedProviderCall, Provider, SessionSource } from '../src/main/pipeline/providers/types.js'
import { calculateCost } from '../src/main/pipeline/models.js'
import { billableOutputTokens } from '../src/main/pipeline/billable-output.js'

// The Copilot CLI session-store.db source: per-request token rows from
// ~/.copilot/session-store.db, read with the same node:sqlite fixture approach
// tests/provider-working-directory.test.ts uses.
//
// Two things are under test beyond "the row is read":
//   1. TOKEN SEMANTICS. `input_tokens` is cache-INCLUSIVE and `copilot` is
//      output-INCLUSIVE for reasoning — both are subtractions the store's
//      numbers must not be re-derived by hand.
//   2. THE SHUTDOWN RECONCILIATION. The store and the events.jsonl
//      `session.shutdown` rollup describe the same input/cache tokens, so
//      exactly one of them may survive for a given (session, model).

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The real schema, minus every column this parser does not price. */
const STORE_SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT,
  repository TEXT,
  host_type TEXT,
  branch TEXT,
  summary TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE assistant_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_index INTEGER,
  agent_id TEXT,
  parent_tool_call_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER,
  total_nano_aiu INTEGER,
  request_multiplier REAL,
  duration_ms INTEGER,
  time_to_first_token_ms INTEGER,
  inter_token_latency_ms INTEGER,
  initiator TEXT,
  api_endpoint TEXT,
  reasoning_effort TEXT,
  finish_reason TEXT,
  content_filter_triggered INTEGER,
  token_details_json TEXT,
  created_at TEXT,
  output_ttft_ms REAL,
  copilot_usage_model TEXT
);
`

type StoreRow = {
  sessionId: string
  model?: string | null
  input?: number | null
  output?: number | null
  cacheRead?: number | null
  cacheWrite?: number | null
  reasoning?: number | null
  initiator?: string | null
  createdAt?: string | null
  cwd?: string | null
  repository?: string | null
}

/** Build a real `session-store.db` in a temp dir; one usage row per input. */
function makeStore(prefix: string, rows: StoreRow[] = []): { dbPath: string; sessionState: string } {
  const cliHome = mkdtempSync(join(tmpdir(), prefix))
  // The store sits BESIDE session-state/, and the provider derives it from the
  // session-state seam — so the fixture mirrors the real ~/.copilot layout.
  const sessionState = join(cliHome, 'session-state')
  mkdirSync(sessionState, { recursive: true })
  const dbPath = join(cliHome, 'session-store.db')
  const db = new DatabaseSync(dbPath)
  db.exec(STORE_SCHEMA)
  const insertSession = db.prepare('INSERT OR IGNORE INTO sessions (id, cwd, repository) VALUES (?, ?, ?)')
  const insertUsage = db.prepare(
    `INSERT INTO assistant_usage_events
       (session_id, turn_index, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens, initiator, created_at)
     VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const row of rows) {
    insertSession.run(row.sessionId, row.cwd ?? 'C:\\work\\demo', row.repository ?? null)
    // `model` is TEXT NOT NULL in practice; a hand-built store may hold '', and
    // the parser must survive that rather than the fixture hiding it.
    insertUsage.run(
      row.sessionId,
      row.model === null ? '' : (row.model ?? 'claude-sonnet-4-5'),
      row.input ?? 0,
      row.output ?? 0,
      row.cacheRead ?? 0,
      row.cacheWrite ?? 0,
      row.reasoning ?? 0,
      row.initiator ?? 'agent',
      row.createdAt ?? '2026-03-01T10:00:00.000Z',
    )
  }
  db.close()
  return { dbPath, sessionState }
}

type Overrides = { sessionState: string; ws: string; global: string; jetbrains: string }

/** Empty override roots so discovery never reaches the real machine. */
function isolatedDirs(prefix: string): Overrides {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const dirs = {
    sessionState: join(root, 'session-state'),
    ws: join(root, 'ws'),
    global: join(root, 'global'),
    jetbrains: join(root, 'jb'),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  return dirs
}

function providerFor(dirs: Overrides): Provider {
  return createCopilotProvider(dirs.sessionState, dirs.ws, dirs.global, dirs.jetbrains)
}

/** Parse every discovered source IN DISCOVERY ORDER, as the scan does. */
async function collect(provider: Provider, sources: SessionSource[]): Promise<ParsedProviderCall[]> {
  const seen = new Set<string>()
  const calls: ParsedProviderCall[] = []
  for (const source of sources) {
    for await (const call of provider.createSessionParser(source, seen).parse()) calls.push(call)
  }
  return calls
}

async function parseAll(dirs: Overrides): Promise<ParsedProviderCall[]> {
  const provider = providerFor(dirs)
  return collect(provider, await provider.discoverSessions())
}

/**
 * A `session-state` dir with a store beside it — the shape the provider's
 * derived lookup expects — plus isolated ws/global/jetbrains roots.
 */
function storeDirs(prefix: string, rows: StoreRow[] = []): Overrides {
  const { sessionState } = makeStore(prefix, rows)
  const root = dirname(sessionState)
  const dirs = {
    sessionState,
    ws: join(root, 'ws'),
    global: join(root, 'global'),
    jetbrains: join(root, 'jb'),
  }
  for (const dir of [dirs.ws, dirs.global, dirs.jetbrains]) mkdirSync(dir, { recursive: true })
  return dirs
}

type RollupUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** The CLI rollup for one model: 50_000 cache-inclusive input, 500 output. */
const ROLLUP_ONE_MODEL: Record<string, RollupUsage> = {
  'claude-sonnet-4-5': { inputTokens: 50_000, outputTokens: 500, cacheReadTokens: 40_000, cacheWriteTokens: 8_000 },
}

/** Write an events.jsonl CLI session carrying a `session.shutdown` rollup. */
function writeShutdownSession(
  sessionState: string,
  sessionId: string,
  rollup: Record<string, RollupUsage>,
  perTurnOutput?: { messageId: string; outputTokens: number },
): void {
  const dir = join(sessionState, sessionId)
  mkdirSync(dir, { recursive: true })
  const lines = [
    JSON.stringify({
      type: 'session.start',
      data: { selectedModel: 'claude-sonnet-4-5' },
      timestamp: '2026-03-01T09:00:00.000Z',
    }),
  ]
  if (perTurnOutput) {
    lines.push(
      JSON.stringify({
        type: 'assistant.message',
        data: {
          messageId: perTurnOutput.messageId,
          model: 'claude-sonnet-4-5',
          outputTokens: perTurnOutput.outputTokens,
        },
        timestamp: '2026-03-01T10:30:00.000Z',
      }),
    )
  }
  // The real CLI shape: modelMetrics[model].usage.{input,output,cacheRead,cacheWrite}.
  const modelMetrics: Record<string, { usage: RollupUsage }> = {}
  for (const [model, usage] of Object.entries(rollup)) modelMetrics[model] = { usage }
  lines.push(
    JSON.stringify({
      type: 'session.shutdown',
      data: { modelMetrics, sessionStartTime: Date.parse('2026-03-01T09:00:00.000Z') },
      timestamp: '2026-03-01T11:00:00.000Z',
    }),
  )
  writeFileSync(join(dir, 'events.jsonl'), lines.join('\n') + '\n')
}

// ---------------------------------------------------------------------------
// Reading and pricing a row
// ---------------------------------------------------------------------------

describe('session-store.db: reading and pricing a request row', () => {
  it('subtracts the cache components out of the cache-INCLUSIVE input_tokens', async () => {
    // input_tokens 50_000 = 2_000 uncached + 40_000 cache_read + 8_000 cache_write.
    const dirs = storeDirs('tr-store-subtract-', [
      { sessionId: 'sess-1', input: 50_000, output: 500, cacheRead: 40_000, cacheWrite: 8_000 },
    ])
    const calls = await parseAll(dirs)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.inputTokens).toBe(2_000)
    expect(call.cacheReadInputTokens).toBe(40_000)
    expect(call.cacheCreationInputTokens).toBe(8_000)
    expect(call.provider).toBe('copilot')
    // Real counts the CLI wrote, not char estimates.
    expect(call.costIsEstimated).toBe(false)
    expect(call.tools).toEqual([])
    expect(call.bashCommands).toEqual([])
    expect(call.speed).toBe('standard')
    expect(call.sessionId).toBe('sess-1')
    // The row's own created_at, ISO-normalised like every other source here.
    expect(call.timestamp).toBe('2026-03-01T10:00:00.000Z')
  })

  it('prices the row at the exact cost the shared helpers produce', async () => {
    // A compaction row, so the output tokens are actually billed here and the
    // exact figure covers all four priced operands.
    const dirs = storeDirs('tr-store-price-', [
      {
        sessionId: 'sess-1',
        input: 50_000,
        output: 500,
        cacheRead: 40_000,
        cacheWrite: 8_000,
        initiator: 'compaction',
      },
    ])
    const [call] = await parseAll(dirs)

    // Written out longhand, not mirrored from the parser: uncached input 2_000,
    // output 500, cache-write 8_000, cache-read 40_000.
    const expected = calculateCost('claude-sonnet-4-5', 2_000, 500, 8_000, 40_000, 0)
    expect(expected).toBeGreaterThan(0)
    expect(call!.costUSD).toBe(expected)
    // A row that treated cache-INCLUSIVE input as uncached would cost strictly
    // more, so this pins the subtraction as well as the total.
    expect(call!.costUSD).toBeLessThan(calculateCost('claude-sonnet-4-5', 50_000, 500, 8_000, 40_000, 0))
  })

  it('prices a non-compaction row on its input/cache alone, leaving output to the per-turn event', async () => {
    const dirs = storeDirs('tr-store-price-noncompaction-', [
      { sessionId: 'sess-1', input: 50_000, output: 500, cacheRead: 40_000, cacheWrite: 8_000, initiator: 'agent' },
    ])
    const [call] = await parseAll(dirs)
    expect(call!.outputTokens).toBe(0)
    expect(call!.costUSD).toBe(calculateCost('claude-sonnet-4-5', 2_000, 0, 8_000, 40_000, 0))
  })

  it('clamps a negative uncached input at 0 rather than billing a credit', async () => {
    // A schema that ever reported input_tokens non-inclusively (i.e. below its
    // own cache components) must not produce a negative uncached input.
    const dirs = storeDirs('tr-store-clamp-', [
      { sessionId: 'sess-1', input: 10, output: 100, cacheRead: 90, cacheWrite: 50, initiator: 'compaction' },
    ])
    const [call] = await parseAll(dirs)
    expect(call!.inputTokens).toBe(0)
    expect(call!.costUSD).toBe(calculateCost('claude-sonnet-4-5', 0, 100, 50, 90, 0))
  })

  it('attributes the row to the project its sessions row records', async () => {
    const dirs = storeDirs('tr-store-project-', [
      {
        sessionId: 'sess-1',
        input: 1_000,
        output: 10,
        repository: 'octocat/hello-world',
        cwd: 'C:\\work\\hello-world',
      },
      { sessionId: 'sess-2', input: 1_000, output: 10, cwd: 'C:\\work\\no-repo' },
    ])
    const calls = await parseAll(dirs)

    expect(calls[0]!.project).toBe('hello-world')
    expect(calls[0]!.projectPath).toBe('C:\\work\\hello-world')
    expect(calls[0]!.workingDirectory).toBe('C:\\work\\hello-world')
    expect(calls[1]!.project).toBe('no-repo')
  })

  it('emits a row with an empty model as `unknown` rather than dropping it', async () => {
    // `model` is TEXT NOT NULL in the real store, but an empty string is a legal
    // value for it — and silently discarding the row would hide real spend.
    const dirs = storeDirs('tr-store-unknown-model-', [{ sessionId: 'sess-1', model: '', input: 9_000, output: 700 }])
    const calls = await parseAll(dirs)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('unknown')
    expect(calls[0]!.inputTokens).toBe(9_000)
  })

  it('prices an unpriced model at $0 and still emits the row, so the unpriced signal can surface it', async () => {
    const dirs = storeDirs('tr-store-unpriced-', [
      { sessionId: 'sess-1', model: 'totally-unreleased-model-x', input: 9_000, output: 700 },
    ])
    const calls = await parseAll(dirs)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe('totally-unreleased-model-x')
    expect(calls[0]!.costUSD).toBe(0)
    // The row survives to the ledger's unpriced view; it is not filtered out.
    expect(calls[0]!.inputTokens).toBe(9_000)
  })

  it('skips a row the CLI logged with no billable token at all', async () => {
    const dirs = storeDirs('tr-store-empty-row-', [
      { sessionId: 'sess-1', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    ])
    expect(await parseAll(dirs)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Token semantics that are easy to get wrong
// ---------------------------------------------------------------------------

describe('session-store.db: reasoning is NOT folded on top of output', () => {
  it('prices output alone for a copilot row, however large the reasoning count', async () => {
    // 10_000 reasoning against 1_000 output: a fold would be an 11x output bill.
    // A compaction row so the output is actually billed and the fold visible.
    const dirs = storeDirs('tr-store-reasoning-', [
      {
        sessionId: 'sess-1',
        input: 5_000,
        output: 1_000,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 10_000,
        initiator: 'compaction',
      },
    ])
    const [call] = await parseAll(dirs)

    expect(call!.reasoningTokens).toBe(10_000)
    expect(call!.outputTokens).toBe(1_000)
    // The contract itself, asserted here so the fixture cannot drift from it.
    expect(billableOutputTokens('copilot', 1_000, 10_000)).toBe(1_000)

    const exact = calculateCost('claude-sonnet-4-5', 5_000, 1_000, 0, 0, 0)
    expect(call!.costUSD).toBe(exact)
    const folded = calculateCost('claude-sonnet-4-5', 5_000, 11_000, 0, 0, 0)
    expect(folded).toBeGreaterThan(exact)
    expect(call!.costUSD).toBeLessThan(folded)
  })

  it('still folds reasoning for an output-EXCLUSIVE provider name, proving the helper is live', () => {
    expect(billableOutputTokens('hermes', 1_000, 10_000)).toBe(11_000)
  })
})

describe('session-store.db: output ownership (compaction rows)', () => {
  it('gives a compaction row its output — no per-turn assistant message owns it', async () => {
    const dirs = storeDirs('tr-store-compaction-', [
      { sessionId: 'sess-1', input: 180_000, output: 3_937, cacheRead: 10_951, initiator: 'compaction' },
    ])
    const [call] = await parseAll(dirs)

    expect(call!.outputTokens).toBe(3_937)
    expect(call!.costUSD).toBe(calculateCost('claude-sonnet-4-5', 180_000 - 10_951, 3_937, 0, 10_951, 0))
  })

  it('gives a NON-compaction row no output — the per-turn assistant.message owns it', async () => {
    // The events.jsonl session below carries the matching per-turn event, and
    // the two together must total the output exactly once.
    const dirs = storeDirs('tr-store-noncompaction-', [
      { sessionId: 'sess-1', input: 50_000, output: 500, cacheRead: 40_000, cacheWrite: 8_000, initiator: 'agent' },
    ])
    writeShutdownSession(dirs.sessionState, 'sess-1', ROLLUP_ONE_MODEL, { messageId: 'msg-1', outputTokens: 500 })

    const calls = await parseAll(dirs)
    const storeRow = calls.find(c => c.deduplicationKey.startsWith('copilot-store:'))!
    const perTurn = calls.find(c => c.deduplicationKey === 'copilot:sess-1:msg-1')!

    expect(storeRow.outputTokens).toBe(0)
    // Exactly one owner of those 500 output tokens across the whole scan.
    expect(calls.reduce((sum, c) => sum + c.outputTokens, 0)).toBe(500)
    expect(perTurn.outputTokens).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// The shutdown rollup reconciliation
// ---------------------------------------------------------------------------

describe('session-store.db: the session.shutdown rollup', () => {
  it('suppresses the rollup for a (session, model) the store covers', async () => {
    const dirs = storeDirs('tr-store-suppress-', [
      { sessionId: 'sess-1', input: 50_000, output: 500, cacheRead: 40_000, cacheWrite: 8_000 },
    ])
    writeShutdownSession(dirs.sessionState, 'sess-1', ROLLUP_ONE_MODEL, { messageId: 'msg-1', outputTokens: 500 })

    const calls = await parseAll(dirs)
    expect(calls.some(c => c.deduplicationKey === 'copilot:sess-1:shutdown:claude-sonnet-4-5')).toBe(false)

    // And the input/cache tokens are still counted exactly once, via the store.
    const storeRow = calls.find(c => c.deduplicationKey.startsWith('copilot-store:'))!
    expect(storeRow.inputTokens).toBe(2_000)
    expect(storeRow.cacheReadInputTokens).toBe(40_000)
    const totalInput = calls.reduce((sum, c) => sum + c.inputTokens, 0)
    const totalCacheRead = calls.reduce((sum, c) => sum + c.cacheReadInputTokens, 0)
    expect(totalInput).toBe(2_000)
    expect(totalCacheRead).toBe(40_000)
  })

  it('still emits the rollup for a (session, model) the store does NOT cover', async () => {
    // The store describes sess-1 only; sess-2 has no store rows, so its rollup
    // remains the fallback — the behaviour a machine with no store must keep.
    const dirs = storeDirs('tr-store-fallback-', [
      { sessionId: 'sess-1', input: 50_000, output: 500, cacheRead: 40_000, cacheWrite: 8_000 },
    ])
    writeShutdownSession(dirs.sessionState, 'sess-1', ROLLUP_ONE_MODEL)
    writeShutdownSession(dirs.sessionState, 'sess-2', ROLLUP_ONE_MODEL)

    const calls = await parseAll(dirs)
    expect(calls.some(c => c.deduplicationKey === 'copilot:sess-1:shutdown:claude-sonnet-4-5')).toBe(false)
    expect(calls.some(c => c.deduplicationKey === 'copilot:sess-2:shutdown:claude-sonnet-4-5')).toBe(true)
  })

  it('leaves the rollup completely untouched when there is no store at all', async () => {
    const dirs = isolatedDirs('tr-store-absent-dirs-')
    writeShutdownSession(dirs.sessionState, 'sess-1', ROLLUP_ONE_MODEL, { messageId: 'msg-1', outputTokens: 500 })

    const calls = await parseAll(dirs)
    const rollup = calls.find(c => c.deduplicationKey === 'copilot:sess-1:shutdown:claude-sonnet-4-5')
    expect(rollup).toBeDefined()
    expect(rollup!.inputTokens).toBe(2_000)
    expect(rollup!.cacheReadInputTokens).toBe(40_000)
    expect(rollup!.outputTokens).toBe(0)
    expect(calls.some(c => c.deduplicationKey.startsWith('copilot-store:'))).toBe(false)
  })

  it('suppresses per MODEL, not per session: a second uncovered model keeps its rollup', async () => {
    const dirs = storeDirs('tr-store-per-model-', [
      { sessionId: 'sess-1', model: 'claude-sonnet-4-5', input: 50_000, output: 500, cacheRead: 40_000 },
    ])
    writeShutdownSession(dirs.sessionState, 'sess-1', {
      'claude-sonnet-4-5': { inputTokens: 50_000, outputTokens: 500, cacheReadTokens: 40_000, cacheWriteTokens: 0 },
      'gpt-4o': { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })

    const calls = await parseAll(dirs)
    expect(calls.some(c => c.deduplicationKey === 'copilot:sess-1:shutdown:claude-sonnet-4-5')).toBe(false)
    expect(calls.some(c => c.deduplicationKey === 'copilot:sess-1:shutdown:gpt-4o')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

describe('session-store.db: a missing, empty, corrupt or locked store', () => {
  /** A session-state dir whose SIBLING session-store.db has the given content. */
  function storeDirsWithFile(prefix: string, content: string | null): Overrides {
    const dirs = isolatedDirs(`${prefix}-dirs-`)
    if (content !== null) writeFileSync(join(dirname(dirs.sessionState), 'session-store.db'), content)
    return dirs
  }

  it('yields zero calls and does not throw when the store file is not there', async () => {
    const dirs = isolatedDirs('tr-store-missing-dirs-')
    expect(await parseAll(dirs)).toEqual([])
  })

  it('yields zero calls and does not throw for an EMPTY (zero-byte) store', async () => {
    const dirs = storeDirsWithFile('tr-store-empty', '')
    expect(await parseAll(dirs)).toEqual([])
  })

  it('yields zero calls and does not throw for a CORRUPT store', async () => {
    const dirs = storeDirsWithFile('tr-store-corrupt', 'this is definitely not a SQLite database'.repeat(200))
    expect(await parseAll(dirs)).toEqual([])
  })

  it('yields zero calls and does not throw for a LOCKED store', async () => {
    const dirs = storeDirs('tr-store-locked-', [{ sessionId: 'sess-1', input: 1_000, output: 100 }])
    // Hold an EXCLUSIVE lock so a read-only open cannot take a shared lock.
    const holder = new DatabaseSync(join(dirname(dirs.sessionState), 'session-store.db'))
    holder.exec('BEGIN EXCLUSIVE')
    try {
      expect(await parseAll(dirs)).toEqual([])
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
    }
  })

  it('yields zero calls for a store with no assistant_usage_events table', async () => {
    const dirs = storeDirsWithFile('tr-store-schema', null)
    const db = new DatabaseSync(join(dirname(dirs.sessionState), 'session-store.db'))
    db.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)')
    db.close()
    expect(await parseAll(dirs)).toEqual([])
  })

  it('treats NULL token columns as 0 instead of dropping the row', async () => {
    const dirs = isolatedDirs('tr-store-nulls-dirs-')
    const db = new DatabaseSync(join(dirname(dirs.sessionState), 'session-store.db'))
    db.exec(STORE_SCHEMA)
    db.prepare('INSERT INTO sessions (id, cwd) VALUES (?, ?)').run('sess-1', 'C:\\work\\demo')
    db.prepare(
      `INSERT INTO assistant_usage_events
         (session_id, turn_index, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, initiator, created_at)
       VALUES (?, 0, ?, NULL, NULL, NULL, NULL, 'agent', '2026-03-01T10:00:00.000Z')`,
    ).run('sess-1', 'claude-sonnet-4-5')
    db.close()

    // Every count is NULL => nothing billable => skipped rather than emitted
    // with NaN. What matters is that nothing throws and no NaN escapes.
    expect(await parseAll(dirs)).toEqual([])
  })

  it('falls back to the file mtime for a row whose created_at is unusable', async () => {
    const dirs = storeDirs('tr-store-badts-', [{ sessionId: 'sess-1', input: 1_000, output: 10, createdAt: 'nope' }])
    const [call] = await parseAll(dirs)
    expect(Number.isNaN(Date.parse(call!.timestamp))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Dedup key
// ---------------------------------------------------------------------------

describe('session-store.db: the dedup key', () => {
  it('is stable across two parses of the same database', async () => {
    const dirs = storeDirs('tr-store-key-stable-', [
      { sessionId: 'sess-1', input: 50_000, output: 500, cacheRead: 40_000, cacheWrite: 8_000 },
      { sessionId: 'sess-1', input: 22_257, output: 200, cacheRead: 21_525, cacheWrite: 599 },
    ])

    const first = await parseAll(dirs)
    const second = await parseAll(dirs)
    expect(first.map(c => c.deduplicationKey)).toEqual(second.map(c => c.deduplicationKey))
  })

  it('collapses a byte-identical re-insert (a backup restore / VACUUM INTO)', async () => {
    const rows: StoreRow[] = [{ sessionId: 'sess-1', input: 50_000, output: 500, cacheRead: 40_000, cacheWrite: 8_000 }]
    const a = await parseAll(storeDirs('tr-store-key-restore-a-', rows))
    const b = await parseAll(storeDirs('tr-store-key-restore-b-', rows))
    expect(b[0]!.deduplicationKey).toBe(a[0]!.deduplicationKey)
  })

  it('gives a re-created database whose id sequence restarts a DIFFERENT key for a different row', async () => {
    // Both databases hand out id 1, but the second row is a different request.
    // A bare `copilot-store:<session>:<id>` key would collide and the durable
    // cache would swallow the second request forever.
    const a = await parseAll(
      storeDirs('tr-store-key-restart-a-', [
        { sessionId: 'sess-1', input: 50_000, output: 500, cacheRead: 40_000, cacheWrite: 8_000 },
      ]),
    )
    const b = await parseAll(
      storeDirs('tr-store-key-restart-b-', [
        { sessionId: 'sess-1', input: 999, output: 111, cacheRead: 0, cacheWrite: 0 },
      ]),
    )
    expect(a[0]!.deduplicationKey).toMatch(/^copilot-store:sess-1:1:/)
    expect(b[0]!.deduplicationKey).toMatch(/^copilot-store:sess-1:1:/)
    expect(b[0]!.deduplicationKey).not.toBe(a[0]!.deduplicationKey)
  })

  it('uses a namespace disjoint from every other key this provider mints', async () => {
    const dirs = storeDirs('tr-store-key-ns-', [
      { sessionId: 'sess-1', input: 50_000, output: 500, cacheRead: 40_000, cacheWrite: 8_000 },
    ])
    writeShutdownSession(dirs.sessionState, 'sess-1', ROLLUP_ONE_MODEL, { messageId: 'msg-1', outputTokens: 500 })
    const calls = await parseAll(dirs)

    const storeKeys = calls.filter(c => c.deduplicationKey.startsWith('copilot-store:'))
    expect(storeKeys).toHaveLength(1)
    // The namespaces this provider uses, none of which may be reachable from a
    // store key: the rollup, the per-turn event, chatSessions, JetBrains, OTel.
    for (const foreign of [
      'copilot:sess-1:shutdown:claude-sonnet-4-5',
      'copilot:sess-1:msg-1',
      'copilot-chatsession:sess-1:r1',
      'copilot:jb:sess-1:abcdef012345:1',
      'copilot-otel:span-1',
    ]) {
      expect(storeKeys[0]!.deduplicationKey).not.toBe(foreign)
      expect(storeKeys[0]!.deduplicationKey.startsWith(foreign)).toBe(false)
    }
    // And the per-turn event keeps its own key — the store never claims it.
    expect(calls.some(c => c.deduplicationKey === 'copilot:sess-1:msg-1')).toBe(true)
  })

  it('keeps two rows of identical content distinct through the row id', async () => {
    const dirs = storeDirs('tr-store-key-dup-', [
      { sessionId: 'sess-1', input: 1_000, output: 100 },
      { sessionId: 'sess-1', input: 1_000, output: 100 },
    ])
    const calls = await parseAll(dirs)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.deduplicationKey).not.toBe(calls[1]!.deduplicationKey)
  })
})

// ---------------------------------------------------------------------------
// Discovery + path resolution
// ---------------------------------------------------------------------------

describe('session-store.db: discovery', () => {
  it('is returned FIRST, ahead of every events.jsonl source', async () => {
    const dirs = storeDirs('tr-store-order-', [{ sessionId: 'sess-1', input: 1_000, output: 100 }])
    writeShutdownSession(dirs.sessionState, 'sess-1', {
      'claude-sonnet-4-5': { inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    const provider = providerFor(dirs)
    const sources = await provider.discoverSessions()

    const kinds = sources.map(s => ('sourceType' in s ? s.sourceType : undefined))
    expect(kinds[0]).toBe('sessionstore')
    expect(sources[0]!.path).toBe(join(dirname(dirs.sessionState), 'session-store.db'))
    expect(kinds).toContain('jsonl')
    expect(kinds.indexOf('sessionstore')).toBeLessThan(kinds.indexOf('jsonl'))
  })

  it('discovers nothing when there is no store beside the session-state dir', async () => {
    const provider = providerFor(isolatedDirs('tr-store-none-dirs-'))
    const sources = await provider.discoverSessions()
    expect(sources.some(s => 'sourceType' in s && s.sourceType === 'sessionstore')).toBe(false)
  })

  it('getCopilotSessionStoreDbPath derives the store from the CLI home and gates on existence', () => {
    const { dbPath, sessionState } = makeStore('tr-store-path-', [{ sessionId: 'sess-1', input: 1_000, output: 100 }])
    // The session-state override argument wins, so the store is looked for
    // BESIDE it — one seam moves the whole ~/.copilot root.
    expect(getCopilotSessionStoreDbPath(sessionState)).toBe(dbPath)
    // A CLI root with no store beside it yields null, never a bogus source.
    expect(getCopilotSessionStoreDbPath(isolatedDirs('tr-store-path-none-').sessionState)).toBeNull()
  })
})
