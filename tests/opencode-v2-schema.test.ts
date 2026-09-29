import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterAll, describe, expect, it } from 'vitest'

import {
  createSqliteSessionParser,
  detectGeneration,
  discoverSqliteSessions,
  OPENCODE_FAMILY_1X,
  OPENCODE_FAMILY_2X,
  type SqliteGeneration,
  type SqliteProviderConfig,
  type V2MessageRow,
  v2RowsToLegacyShape,
} from '../src/main/pipeline/providers/opencode-family-sqlite.js'
import type { ParsedProviderCall, SessionParser } from '../src/main/pipeline/providers/types.js'
import { openDatabase, type SqliteDatabase } from '../src/main/pipeline/sqlite.js'

// OpenCode 2.x wrote sessions to `session_v2` and messages to `session_message`,
// and FROZE the 1.x `session` / `message` / `part` tables at the upgrade. So a
// session created after the upgrade has rows in `session_message` and none in
// `message`, and a session id that never migrated still has all of its rows in
// the legacy tables and none in the v2 ones. Both halves are covered here: the
// v2 read, and the per-session fallback that keeps frozen history alive.

const DIR = 'C:\\work\\watchtower'
const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

type Fixture = {
  dbDir: string
  dbPath: string
  config: SqliteProviderConfig
}

/// A writable handle for BUILDING a fixture. The parser itself only ever opens
/// through the repo's read-only `openDatabase`, never this.
function writable(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath)
}

/// OpenCode's own declaration: both generations, 2.x preferred. Every case in
/// this file that resolves a generation is exercising OpenCode's policy, so the
/// list is stated once here rather than inline per fixture.
const OPENCODE_GENERATIONS: readonly SqliteGeneration[] = [OPENCODE_FAMILY_2X, OPENCODE_FAMILY_1X]

const CONFIG = (dbDir: string, providerName = 'opencode'): SqliteProviderConfig => ({
  providerName,
  displayName: 'OpenCode',
  dbDir,
  dbFilePrefix: 'opencode',
  generations: OPENCODE_GENERATIONS,
})

/** The 1.x schema, exactly as the legacy path expects it. */
function createLegacySchema(db: DatabaseSync, opts: { directory?: boolean } = {}): void {
  const dirCol = opts.directory === false ? '' : 'directory TEXT, '
  db.exec(`CREATE TABLE session (id TEXT, ${dirCol}title TEXT, time_created REAL, time_archived REAL, parent_id TEXT)`)
  db.exec('CREATE TABLE message (session_id TEXT, id TEXT, time_created REAL, data BLOB)')
  db.exec('CREATE TABLE part (session_id TEXT, message_id TEXT, id TEXT, data BLOB)')
}

/// The 2.x schema: no `part` table, content inline in the message blob.
function createV2Schema(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE session_v2 (id TEXT, directory TEXT, title TEXT, time_created REAL, time_archived REAL, parent_id TEXT)',
  )
  db.exec(
    'CREATE TABLE session_message (session_id TEXT, id TEXT, type TEXT, seq INTEGER, time_created REAL, data BLOB)',
  )
}

function insertLegacySession(
  db: DatabaseSync,
  id: string,
  opts: { directory?: string | null; title?: string; timeCreated?: number } = {},
): void {
  const directory = opts.directory === undefined ? DIR : opts.directory
  db.prepare('INSERT INTO session (id, directory, title, time_created) VALUES (?, ?, ?, ?)').run(
    id,
    directory,
    opts.title ?? `title-${id}`,
    opts.timeCreated ?? 1750000000,
  )
}

function insertLegacyAssistant(
  db: DatabaseSync,
  sessionId: string,
  id: string,
  parts: unknown[],
  timeCreated: number,
): void {
  db.prepare('INSERT INTO message (session_id, id, time_created, data) VALUES (?, ?, ?, ?)').run(
    sessionId,
    id,
    timeCreated,
    JSON.stringify({ role: 'assistant', modelID: 'gpt-4o', tokens: { input: 10, output: 5 } }),
  )
  for (const [i, part] of parts.entries()) {
    db.prepare('INSERT INTO part (session_id, message_id, id, data) VALUES (?, ?, ?, ?)').run(
      sessionId,
      id,
      `${id}-p${i}`,
      JSON.stringify(part),
    )
  }
}

function insertV2Session(
  db: DatabaseSync,
  id: string,
  opts: { directory?: string | null; title?: string; timeCreated?: number } = {},
): void {
  const directory = opts.directory === undefined ? DIR : opts.directory
  db.prepare('INSERT INTO session_v2 (id, directory, title, time_created) VALUES (?, ?, ?, ?)').run(
    id,
    directory,
    opts.title ?? `title-${id}`,
    opts.timeCreated ?? 1750000000,
  )
}

function insertV2Message(
  db: DatabaseSync,
  row: { sessionId: string; id: string; type: string; seq: number; timeCreated: number; data: unknown },
): void {
  db.prepare(
    'INSERT INTO session_message (session_id, id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    row.sessionId,
    row.id,
    row.type,
    row.seq,
    row.timeCreated,
    typeof row.data === 'string' ? row.data : JSON.stringify(row.data),
  )
}

async function collect(parser: SessionParser): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  for await (const call of parser.parse()) calls.push(call)
  return calls
}

async function parseAll(
  fixture: Fixture,
  source: { path: string; project: string; provider: string },
): Promise<ParsedProviderCall[]> {
  return collect(createSqliteSessionParser(source, new Set(), fixture.config))
}

describe('detectGeneration', () => {
  it('returns the 2.x generation when both session_v2 and session_message exist', () => {
    const dir = tempDir('oc-v2-only-')
    const dbPath = join(dir, 'opencode-test.db')
    const db = writable(dbPath)
    createV2Schema(db)
    db.close()

    const read = openDatabase(dbPath)
    try {
      expect(detectGeneration(read, OPENCODE_GENERATIONS)?.label).toBe('2.x')
    } finally {
      read.close()
    }
  })

  it('returns the 1.x generation on a 1.x DB', () => {
    const dir = tempDir('oc-legacy-only-')
    const dbPath = join(dir, 'opencode-test.db')
    const db = writable(dbPath)
    createLegacySchema(db)
    db.close()

    const read = openDatabase(dbPath)
    try {
      expect(detectGeneration(read, OPENCODE_GENERATIONS)?.label).toBe('1.x')
    } finally {
      read.close()
    }
  })

  it('returns null when neither generation is present', () => {
    const dir = tempDir('oc-empty-')
    const dbPath = join(dir, 'opencode-test.db')
    const db = writable(dbPath)
    db.exec('CREATE TABLE unrelated (id TEXT)')
    db.close()

    const read = openDatabase(dbPath)
    try {
      expect(detectGeneration(read, OPENCODE_GENERATIONS)).toBeNull()
    } finally {
      read.close()
    }
  })

  it('returns 1.x — not 2.x — when only ONE of the two 2.x tables exists', () => {
    // Half a migration is not a readable 2.x generation. Reading through the
    // 2.x path would find no messages at all and silently zero out the session.
    for (const partial of [
      'CREATE TABLE session_v2 (id TEXT, directory TEXT, title TEXT, time_created REAL, time_archived REAL, parent_id TEXT)',
      'CREATE TABLE session_message (session_id TEXT, id TEXT, type TEXT, seq INTEGER, time_created REAL, data BLOB)',
    ]) {
      const dir = tempDir('oc-partial-v2-')
      const dbPath = join(dir, 'opencode-test.db')
      const db = writable(dbPath)
      createLegacySchema(db)
      db.exec(partial)
      db.close()

      const read = openDatabase(dbPath)
      try {
        expect(detectGeneration(read, OPENCODE_GENERATIONS)?.label).toBe('1.x')
      } finally {
        read.close()
      }
    }
  })

  it('returns 2.x on an upgraded DB, where the 1.x tables are still valid', () => {
    const dir = tempDir('oc-upgraded-')
    const dbPath = join(dir, 'opencode-test.db')
    const db = writable(dbPath)
    createLegacySchema(db)
    createV2Schema(db)
    db.close()

    const read = openDatabase(dbPath)
    try {
      expect(detectGeneration(read, OPENCODE_GENERATIONS)?.label).toBe('2.x')
    } finally {
      read.close()
    }
  })
})

describe('v2RowsToLegacyShape', () => {
  const row = (over: Partial<V2MessageRow> & { type: string; data: unknown }): V2MessageRow => ({
    session_id: 'ses-1',
    id: 'msg-1',
    seq: 0,
    time_created: 1750000000000,
    ...over,
    data: typeof over.data === 'string' ? over.data : JSON.stringify(over.data),
  })

  it('maps a user row to role user with its text as one part', () => {
    const { messages, partsByMsg } = v2RowsToLegacyShape([
      row({ id: 'msg-u', type: 'user', data: { text: 'hello there', time: { created: 1 } } }),
    ])
    expect(messages).toHaveLength(1)
    expect(JSON.parse(String(messages[0]!.data))).toEqual({ role: 'user' })
    expect(partsByMsg.get('msg-u')).toEqual([{ type: 'text', text: 'hello there' }])
  })

  it('emits a user message with no parts when the text is absent or empty', () => {
    const { messages, partsByMsg } = v2RowsToLegacyShape([
      row({ id: 'msg-u1', type: 'user', data: { text: '' } }),
      row({ id: 'msg-u2', type: 'user', data: { time: { created: 1 } } }),
    ])
    expect(messages).toHaveLength(2)
    expect(partsByMsg.size).toBe(0)
  })

  it('turns the v2 model ref into modelID as providerID/id', () => {
    const { messages } = v2RowsToLegacyShape([
      row({
        id: 'msg-a',
        type: 'assistant',
        data: {
          model: { id: 'muse-spark-1.3', providerID: 'opencode', variant: 'xhigh' },
          cost: 0.25,
          tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 3 } },
        },
      }),
    ])
    expect(JSON.parse(String(messages[0]!.data))).toEqual({
      role: 'assistant',
      providerID: 'opencode',
      modelID: 'opencode/muse-spark-1.3',
      cost: 0.25,
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 3 } },
    })
  })

  it('keeps providerID without a modelID when the ref has no id', () => {
    const { messages } = v2RowsToLegacyShape([
      row({ type: 'assistant', data: { model: { providerID: 'opencode' }, tokens: { input: 1 } } }),
    ])
    const data = JSON.parse(String(messages[0]!.data))
    expect(data.providerID).toBe('opencode')
    expect(data.modelID).toBeUndefined()
  })

  it('normalizes inline content into text, reasoning and tool parts', () => {
    const { messages, partsByMsg } = v2RowsToLegacyShape([
      row({
        id: 'msg-a',
        type: 'assistant',
        data: {
          model: { id: 'muse', providerID: 'opencode' },
          content: [
            { type: 'reasoning', text: 'thinking' },
            { type: 'text', text: 'answer' },
            { type: 'tool', name: 'bash', state: { status: 'completed', input: { command: 'ls -la' } } },
          ],
        },
      }),
    ])
    expect(messages).toHaveLength(1)
    expect(partsByMsg.get('msg-a')).toEqual([
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'answer' },
      { type: 'tool', tool: 'bash', state: { input: { command: 'ls -la' } } },
    ])
  })

  it("defaults a tool's missing state.input to {}", () => {
    const { partsByMsg } = v2RowsToLegacyShape([
      row({
        type: 'assistant',
        data: {
          content: [
            { type: 'tool', name: 'read' },
            { type: 'tool', name: 'write', state: { status: 'pending' } },
            { type: 'tool', name: 'edit', state: { input: 'not-an-object' } },
          ],
        },
      }),
    ])
    expect(partsByMsg.get('msg-1')).toEqual([
      { type: 'tool', tool: 'read', state: { input: {} } },
      { type: 'tool', tool: 'write', state: { input: {} } },
      { type: 'tool', tool: 'edit', state: { input: {} } },
    ])
  })

  it('skips empty-string text, non-object and null content elements', () => {
    const { partsByMsg } = v2RowsToLegacyShape([
      row({
        type: 'assistant',
        data: { content: [{ type: 'text', text: '' }, null, 'a string', 42, { type: 'file' }] },
      }),
    ])
    expect(partsByMsg.get('msg-1')).toBeUndefined()
  })

  it('keeps a compaction row — it carries the compaction request cost', () => {
    // 1.x counted a compaction as an assistant message. Dropping it here would
    // undercount every compacted 2.x session.
    const { messages } = v2RowsToLegacyShape([
      row({
        id: 'msg-c',
        type: 'compaction',
        data: { status: 'completed', reason: 'auto', cost: 0.4, tokens: { input: 900, output: 30 } },
      }),
    ])
    expect(messages).toHaveLength(1)
    expect(JSON.parse(String(messages[0]!.data))).toMatchObject({ role: 'assistant', cost: 0.4 })
  })

  it('drops idle, synthetic, system and *-switched rows', () => {
    const { messages } = v2RowsToLegacyShape([
      row({ id: 'm1', type: 'idle', data: { outcome: 'succeeded' } }),
      row({ id: 'm2', type: 'synthetic', data: { text: 'tool echo' } }),
      row({ id: 'm3', type: 'system', data: { text: 'tools changed' } }),
      row({ id: 'm4', type: 'model-switched', data: { model: { id: 'x', providerID: 'y' } } }),
      row({ id: 'm5', type: 'agent-switched', data: {} }),
      row({ id: 'm6', type: 'location-switched', data: {} }),
    ])
    expect(messages).toHaveLength(0)
  })

  it('skips a row whose data blob is not valid JSON, without throwing', () => {
    const { messages, partsByMsg } = v2RowsToLegacyShape([
      row({ id: 'bad', type: 'assistant', data: '{not json' }),
      row({ id: 'not-object', type: 'assistant', data: '[1,2,3]' }),
      row({ id: 'good', type: 'assistant', data: { tokens: { input: 3 } } }),
    ])
    expect(messages.map(m => m.id)).toEqual(['good'])
    expect(partsByMsg.size).toBe(0)
  })

  it('preserves row order and per-row identity from the query', () => {
    const { messages } = v2RowsToLegacyShape([
      row({
        id: 'b',
        session_id: 'ses-2',
        type: 'assistant',
        seq: 2,
        time_created: 20,
        data: { tokens: { input: 1 } },
      }),
      row({
        id: 'a',
        session_id: 'ses-1',
        type: 'assistant',
        seq: 1,
        time_created: 10,
        data: { tokens: { input: 1 } },
      }),
    ])
    expect(messages.map(m => [m.session_id, m.id, m.time_created])).toEqual([
      ['ses-2', 'b', 20],
      ['ses-1', 'a', 10],
    ])
  })
})

describe('v2 parser end-to-end', () => {
  it('parses a v2-only session: correct tokens, and the message id is absent from `message`', async () => {
    const dbDir = tempDir('oc-v2-e2e-')
    const dbPath = join(dbDir, 'opencode-test.db')
    const db = writable(dbPath)
    createV2Schema(db)
    insertV2Session(db, 'ses-v2', { title: 'v2 session' })
    insertV2Message(db, {
      sessionId: 'ses-v2',
      id: 'msg-user',
      type: 'user',
      seq: 0,
      timeCreated: 1750000000000,
      data: { text: 'please run the tests' },
    })
    insertV2Message(db, {
      sessionId: 'ses-v2',
      id: 'msg-v2-only',
      type: 'assistant',
      seq: 1,
      timeCreated: 1750000001000,
      data: {
        model: { id: 'gpt-5', providerID: 'openai' },
        cost: 0,
        tokens: { input: 1200, output: 340, reasoning: 90, cache: { read: 8000, write: 15 } },
        content: [
          { type: 'text', text: 'running' },
          { type: 'tool', name: 'bash', state: { status: 'completed', input: { command: 'npm test' } } },
        ],
      },
    })
    // The same message id in the 1.x table would be a v2→legacy migration this
    // parser must NOT be reading.
    db.close()

    const fixture: Fixture = { dbDir, dbPath, config: CONFIG(dbDir) }
    const sources = await discoverSqliteSessions(fixture.config)
    expect(sources.map(s => s.path)).toEqual([`${dbPath}:ses-v2`])

    const calls = await parseAll(fixture, sources[0]!)
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.deduplicationKey).toBe('opencode:ses-v2:msg-v2-only')
    expect(call.inputTokens).toBe(1200)
    expect(call.outputTokens).toBe(340)
    expect(call.reasoningTokens).toBe(90)
    expect(call.cacheReadInputTokens).toBe(8000)
    expect(call.cacheCreationInputTokens).toBe(15)
    expect(call.model).toBe('openai/gpt-5')
    expect(call.tools).toEqual(['Bash'])
    // The shared bash extractor reports the command's basename, not the line.
    expect(call.bashCommands).toEqual(['npm'])
    expect(call.userMessage).toBe('please run the tests')
    expect(call.workingDirectory).toBe(DIR)
    expect(call.costUSD).toBeGreaterThan(0)

    const read = openDatabase(dbPath)
    try {
      // A `message` table is not even present, which is exactly the point: this
      // id has no counterpart anywhere the 1.x path would look.
      expect(() => read.query('SELECT COUNT(*) as c FROM message')).toThrow()
    } finally {
      read.close()
    }
  })

  it('does not price a zero-token turn at $0 by accident when the vendor reports cost', async () => {
    const dbDir = tempDir('oc-v2-cost-')
    const dbPath = join(dbDir, 'opencode-test.db')
    const db = writable(dbPath)
    createV2Schema(db)
    insertV2Session(db, 'ses-v2')
    insertV2Message(db, {
      sessionId: 'ses-v2',
      id: 'msg-a',
      type: 'assistant',
      seq: 0,
      timeCreated: 1750000000000,
      data: {
        model: { id: 'gpt-5', providerID: 'openai' },
        cost: 0,
        tokens: { input: 100, output: 50, cache: { read: 9999, write: 0 } },
        content: [{ type: 'text', text: 'ok' }],
      },
    })
    db.close()

    const fixture: Fixture = { dbDir, dbPath, config: CONFIG(dbDir) }
    const calls = await parseAll(fixture, { path: `${dbPath}:ses-v2`, project: 'p', provider: 'opencode' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(100)
    expect(calls[0]!.outputTokens).toBe(50)
    expect(calls[0]!.cacheReadInputTokens).toBe(9999)
    expect(calls[0]!.costUSD).toBeGreaterThan(0)
  })

  it('walks a v2 session tree: a child session contributes its messages', async () => {
    const dbDir = tempDir('oc-v2-tree-')
    const dbPath = join(dbDir, 'opencode-test.db')
    const db = writable(dbPath)
    createV2Schema(db)
    insertV2Session(db, 'ses-parent')
    db.prepare('INSERT INTO session_v2 (id, parent_id, time_created) VALUES (?, ?, ?)').run(
      'ses-child',
      'ses-parent',
      2,
    )
    insertV2Message(db, {
      sessionId: 'ses-parent',
      id: 'msg-p',
      type: 'assistant',
      seq: 0,
      timeCreated: 1,
      data: { model: { id: 'gpt-5', providerID: 'openai' }, tokens: { input: 11, output: 1 } },
    })
    insertV2Message(db, {
      sessionId: 'ses-child',
      id: 'msg-c',
      type: 'assistant',
      seq: 0,
      timeCreated: 2,
      data: { model: { id: 'gpt-5', providerID: 'openai' }, tokens: { input: 22, output: 2 } },
    })
    db.close()

    const fixture: Fixture = { dbDir, dbPath, config: CONFIG(dbDir) }
    const calls = await parseAll(fixture, { path: `${dbPath}:ses-parent`, project: 'p', provider: 'opencode' })
    expect(calls.map(c => c.deduplicationKey).sort()).toEqual(['opencode:ses-child:msg-c', 'opencode:ses-parent:msg-p'])
  })

  it('drops a still-running compaction that carries no cost and no tokens', async () => {
    const dbDir = tempDir('oc-v2-compaction-')
    const dbPath = join(dbDir, 'opencode-test.db')
    const db = writable(dbPath)
    createV2Schema(db)
    insertV2Session(db, 'ses-v2')
    insertV2Message(db, {
      sessionId: 'ses-v2',
      id: 'msg-c',
      type: 'compaction',
      seq: 0,
      timeCreated: 1,
      data: { status: 'running', reason: 'auto' },
    })
    db.close()

    const fixture: Fixture = { dbDir, dbPath, config: CONFIG(dbDir) }
    const calls = await parseAll(fixture, { path: `${dbPath}:ses-v2`, project: 'p', provider: 'opencode' })
    expect(calls).toHaveLength(0)
  })
})

describe('union on an upgraded DB', () => {
  /// `session` + `message` + `part` AND `session_v2` + `session_message`, with
  /// one session present in both and one that only ever existed in 1.x.
  function upgradedFixture(): { dbDir: string; dbPath: string; config: SqliteProviderConfig } {
    const dbDir = tempDir('oc-upgraded-')
    const dbPath = join(dbDir, 'opencode-test.db')
    const db = writable(dbPath)
    createLegacySchema(db)
    createV2Schema(db)

    // Migrated: in BOTH tables. The v2 row is authoritative and richer.
    insertLegacySession(db, 'ses-both', { title: 'both' })
    insertLegacyAssistant(db, 'ses-both', 'msg-legacy', [{ type: 'text', text: 'legacy text' }], 1)
    insertV2Session(db, 'ses-both', { title: 'both', timeCreated: 1 })
    insertV2Message(db, {
      sessionId: 'ses-both',
      id: 'msg-v2',
      type: 'assistant',
      seq: 0,
      timeCreated: 1,
      data: {
        model: { id: 'gpt-5', providerID: 'openai' },
        tokens: { input: 50, output: 10 },
        content: [{ type: 'text', text: 'v2 text' }],
      },
    })

    // Frozen: legacy ONLY. Reading it from session_message would find nothing
    // and drop its history — the regression this union prevents.
    insertLegacySession(db, 'ses-legacy-only', { title: 'legacy only', timeCreated: 2 })
    insertLegacyAssistant(db, 'ses-legacy-only', 'msg-l1', [{ type: 'text', text: 'one' }], 2)
    insertLegacyAssistant(db, 'ses-legacy-only', 'msg-l2', [{ type: 'text', text: 'two' }], 3)

    db.close()
    return { dbDir, dbPath, config: CONFIG(dbDir) }
  }

  it('emits a session present in both tables exactly once, read as v2', async () => {
    const f = upgradedFixture()
    const sources = await discoverSqliteSessions(f.config)
    const paths = sources.map(s => s.path)
    expect(paths.filter(p => p.endsWith(':ses-both'))).toHaveLength(1)

    const source = sources.find(s => s.path.endsWith(':ses-both'))!
    const calls = await parseAll(f, source)
    expect(calls.map(c => c.deduplicationKey)).toEqual(['opencode:ses-both:msg-v2'])
  })

  it('still discovers a legacy-only session and reads it from the legacy tables', async () => {
    const f = upgradedFixture()
    const sources = await discoverSqliteSessions(f.config)
    expect(sources.map(s => s.path).sort()).toEqual([`${f.dbPath}:ses-both`, `${f.dbPath}:ses-legacy-only`])

    const source = sources.find(s => s.path.endsWith(':ses-legacy-only'))!
    const calls = await parseAll(f, source)
    expect(calls.map(c => c.deduplicationKey)).toEqual([
      'opencode:ses-legacy-only:msg-l1',
      'opencode:ses-legacy-only:msg-l2',
    ])
    expect(calls.every(c => c.inputTokens === 10 && c.outputTokens === 5)).toBe(true)
  })

  it('unions in only unmigrated top-level sessions, never duplicates or children', async () => {
    const f = upgradedFixture()
    // A child session is not a discovery source, on either table.
    const setup = writable(f.dbPath)
    setup.prepare('INSERT INTO session (id, parent_id, time_created) VALUES (?, ?, ?)').run('ses-child', 'ses-both', 4)
    setup
      .prepare('INSERT INTO session_v2 (id, parent_id, time_created) VALUES (?, ?, ?)')
      .run('ses-child-v2', 'ses-both', 4)
    setup.close()

    const sources = await discoverSqliteSessions(f.config)
    const paths = sources.map(s => s.path)
    expect(paths).toHaveLength(2)
    expect(new Set(paths).size).toBe(2)
  })
})

describe('legacy parity', () => {
  /// A 1.x fixture whose expected numbers are pinned. Nothing about the v2 work
  /// may move them: same call count, same tokens, same cost, same dedup keys.
  async function parseLegacyFixture(
    providerName: string,
  ): Promise<{ count: number; input: number; output: number; cost: number; keys: string[] }> {
    const dbDir = tempDir(`oc-parity-${providerName}-`)
    const dbPath = join(dbDir, 'opencode-test.db')
    const db = writable(dbPath)
    createLegacySchema(db)
    insertLegacySession(db, 'sess-1', { title: 't' })
    insertLegacyAssistant(db, 'sess-1', 'm1', [{ type: 'text', text: 'hi' }], 1750000000)
    insertLegacyAssistant(
      db,
      'sess-1',
      'm2',
      [{ type: 'tool', tool: 'bash', state: { input: { command: 'npm run build' } } }],
      1750000100,
    )
    db.close()

    const config: SqliteProviderConfig = {
      providerName,
      displayName: 'OpenCode',
      dbDir,
      dbFilePrefix: 'opencode',
      generations: OPENCODE_GENERATIONS,
    }
    const sources = await discoverSqliteSessions(config)
    expect(sources).toHaveLength(1)
    const calls = await collect(createSqliteSessionParser(sources[0]!, new Set(), config))
    return {
      count: calls.length,
      input: calls.reduce((n, c) => n + c.inputTokens, 0),
      output: calls.reduce((n, c) => n + c.outputTokens, 0),
      cost: calls.reduce((n, c) => n + c.costUSD, 0),
      keys: calls.map(c => c.deduplicationKey),
    }
  }

  it('parses a legacy-only DB exactly as before', async () => {
    const result = await parseLegacyFixture('opencode')
    expect(result.count).toBe(2)
    expect(result.input).toBe(20)
    expect(result.output).toBe(10)
    expect(result.cost).toBeGreaterThan(0)
    expect(result.keys).toEqual(['opencode:sess-1:m1', 'opencode:sess-1:m2'])
  })

  it('parses a kilo-code DB through the same shared parser identically', async () => {
    // kilo-code shares this file, so the legacy numbers must be provider-agnostic
    // apart from the dedup-key namespace.
    const result = await parseLegacyFixture('kilo-code')
    expect(result.count).toBe(2)
    expect(result.input).toBe(20)
    expect(result.output).toBe(10)
    expect(result.cost).toBeGreaterThan(0)
    expect(result.keys).toEqual(['kilo-code:sess-1:m1', 'kilo-code:sess-1:m2'])
  })

  it('degrades to path-less calls when the session table has no directory column', async () => {
    const dbDir = tempDir('oc-nodir-')
    const dbPath = join(dbDir, 'opencode-test.db')
    const db = writable(dbPath)
    createLegacySchema(db, { directory: false })
    db.prepare('INSERT INTO session (id, title, time_created) VALUES (?, ?, ?)').run('sess-1', 't', 1750000000)
    insertLegacyAssistant(db, 'sess-1', 'm1', [{ type: 'text', text: 'hi' }], 1750000000)
    db.close()

    const config = CONFIG(dbDir)
    const parser = createSqliteSessionParser(
      { path: `${dbPath}:sess-1`, project: 't', provider: 'opencode' },
      new Set(),
      config,
    )
    const calls = await collect(parser)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0]!.workingDirectory).toBeUndefined()
    expect(calls[0]!.projectPath).toBeUndefined()
  })
})

describe('unreadable databases', () => {
  it('yields no sources for a DB that is not a database at all, without throwing', async () => {
    const dbDir = tempDir('oc-garbage-')
    writeFileSync(join(dbDir, 'opencode-broken.db'), 'this is not sqlite')
    const config = CONFIG(dbDir)

    await expect(discoverSqliteSessions(config)).resolves.toEqual([])

    // And the parser for that path yields nothing rather than throwing.
    const parser = createSqliteSessionParser(
      { path: `${join(dbDir, 'opencode-broken.db')}:ses-1`, project: 'p', provider: 'opencode' },
      new Set(),
      config,
    )
    const calls: unknown[] = []
    for await (const call of parser.parse()) calls.push(call)
    expect(calls).toEqual([])
  })

  it('yields no sources when the data dir does not exist', async () => {
    const config = CONFIG(join(tempDir('oc-missing-'), 'absent'))
    await expect(discoverSqliteSessions(config)).resolves.toEqual([])
  })

  it('re-throws a busy error out of detectGeneration rather than reporting an empty schema', async () => {
    // A locked DB is not an empty one. Swallowing busy here would mark a
    // live-but-contended schema as absent, so the scan would record an empty
    // (fully scanned) period and skip the file until it changed on disk.
    const db = {
      query: () => {
        const err = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
        throw err
      },
      close: () => {},
    } as unknown as SqliteDatabase
    expect(() => detectGeneration(db, OPENCODE_GENERATIONS)).toThrow(/locked/i)
  })
})
