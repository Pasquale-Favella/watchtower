import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import {
  createSqliteSessionParser,
  detectGeneration,
  discoverSqliteSessions,
  type NormalizedMessages,
  OPENCODE_FAMILY_1X,
  OPENCODE_FAMILY_2X,
  type SessionRow,
  type SessionTotals,
  type SqliteGeneration,
  type SqliteProviderConfig,
} from '../src/main/pipeline/providers/opencode-family-sqlite.js'
import type { PartData } from '../src/main/pipeline/providers/session-message.js'
import type { ParsedProviderCall, SessionParser } from '../src/main/pipeline/providers/types.js'
import { blobToText, openDatabase, type SqliteDatabase } from '../src/main/pipeline/sqlite.js'

// `SqliteGeneration` is a COMPLETE STRATEGY: every statement that names a table
// lives on the descriptor, and the shared mechanism only calls methods. This file
// is the pin for that — because the descriptor type is EXPORTED, a future
// provider file can build one and could put a table name derived from config
// into its fields. What stops that name from reaching a query is structural
// rather than a convention someone has to remember, and these cases are what
// keep it structural.
//
//   1. No SQL in the shared mechanism is built by interpolation — statically
//      (read the file) and at runtime (poison the descriptor's table names).
//   2. The seam is not accidentally two-generation-shaped: a THIRD generation,
//      declared by a test provider, is picked, ordered, routed and projected
//      exactly like the two the module ships.
//   3. The tolerant reads still degrade rather than abort a parse, and still
//      re-throw a busy DB.

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

function writable(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath)
}

async function collect(parser: SessionParser): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  for await (const call of parser.parse()) calls.push(call)
  return calls
}

function sessionIdOf(path: string): string {
  return path.slice(path.lastIndexOf(':') + 1)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The structural guard
// ─────────────────────────────────────────────────────────────────────────────

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const MODULE_RELATIVE = join('src', 'main', 'pipeline', 'providers', 'opencode-family-sqlite.ts')

const moduleSource = readFileSync(join(repoRoot, MODULE_RELATIVE), 'utf8')

/// The module's source with every comment blanked out, line for line: a `//`
/// comment contributes nothing, a block comment contributes only its newlines.
/// String and template literals are KEPT, because they are what the guard reads.
///
/// Comments have to go. This module's own header talks about `SELECT` and `${`
/// in prose, and a guard that a sentence could satisfy — or break — is not a
/// guard. Newlines are preserved so an index in the stripped text still maps to
/// the line it came from on disk, which is what lets a failure name it.
function withoutComments(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const c = source[i]!
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n'
        i++
      }
      i += 2
      continue
    }
    if (c === '`' || c === "'" || c === '"') {
      const quote = c
      out += c
      i++
      while (i < source.length) {
        if (source[i] === '\\') {
          out += source.slice(i, i + 2)
          i += 2
          continue
        }
        out += source[i]
        const closed = source[i] === quote
        i++
        if (closed) break
      }
      continue
    }
    out += c
    i++
  }
  return out
}

const stripped = withoutComments(moduleSource)

/// Every string / template literal in the module, with where it starts. A SQL
/// statement here is always a literal — a named constant beside a descriptor, or
/// written inline inside one of the descriptor's own methods — so a literal is
/// exactly the unit this guarantee is about.
function literalsOf(source: string): { text: string; at: number }[] {
  const found: { text: string; at: number }[] = []
  for (const pattern of [/`(?:[^`\\]|\\[\s\S])*`/g, /'(?:[^'\\\n]|\\.)*'/g, /"(?:[^"\\\n]|\\.)*"/g]) {
    for (const match of source.matchAll(pattern)) {
      if (match.index !== undefined) found.push({ text: match[0], at: match.index })
    }
  }
  return found.sort((a, b) => a.at - b.at)
}

const SQL_KEYWORD = /\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i
const sqlLiterals = literalsOf(stripped).filter(l => SQL_KEYWORD.test(l.text))

function describeLiteral(literal: { text: string; at: number }): string {
  const line = stripped.slice(0, literal.at).split('\n').length
  return `${MODULE_RELATIVE}:${line} — ${literal.text.replace(/\s+/g, ' ').slice(0, 140)}`
}

describe('the structural guard reads the module source honestly', () => {
  it('blanks comments without shifting any line', () => {
    // Without this the line numbers below would be lies, and a failure would
    // point a reviewer at the wrong line.
    expect(stripped.split('\n')).toHaveLength(moduleSource.split('\n').length)
  })

  it('blanks the header prose so it cannot stand in for a statement', () => {
    // The header says "there is no `${` inside any `SELECT`" — as prose, in a
    // comment. If comment-stripping ever stopped working, that sentence would
    // both satisfy the guard below and break it.
    expect(stripped).not.toContain('STRUCTURAL PROPERTY')
    expect(stripped).toContain('FROM session_v2')
  })

  it('finds SQL literals to check, so the guard cannot pass vacuously', () => {
    // If every statement were moved out of this file, the checks below would
    // have nothing to inspect — and would prove nothing. Say so.
    expect(sqlLiterals.length).toBeGreaterThan(10)
    const all = sqlLiterals.map(l => l.text).join('\n')
    // Spread across BOTH generations' own statements, not concentrated in one.
    expect(all).toContain('FROM session_v2')
    expect(all).toContain('FROM session_message')
    expect(all).toContain('FROM message')
    expect(all).toContain('FROM part')
  })
})

describe('no SQL in the shared mechanism is built by interpolation', () => {
  it('no SQL literal in the file contains an interpolation', () => {
    // The property itself. A `${` inside a statement is a name reaching SQL by
    // concatenation, which is the one shape this refactor exists to remove.
    const offenders = sqlLiterals.filter(l => l.text.includes('${')).map(describeLiteral)
    expect(offenders).toEqual([])
  })

  it('no SQL is assembled from a table name: there is no `FROM ${` anywhere', () => {
    // A coarser, independent net over the whole file rather than over extracted
    // literals — it also catches a statement built with `+` or `String.raw`,
    // where the interpolation would never appear inside a single literal.
    const lines = stripped.split('\n')
    const offenders: string[] = []
    for (const match of stripped.matchAll(/\bFROM\s+\$\{/gi)) {
      const line = stripped.slice(0, match.index!).split('\n').length
      offenders.push(`${MODULE_RELATIVE}:${line} — ${lines[line - 1]?.trim()}`)
    }
    expect(offenders).toEqual([])
  })

  it('every table a statement reads is a bare literal, not a variable or a splice', () => {
    // The positive half, and the one that survives an obfuscated build. Names
    // the family publishes, written out; `session_tree` and `parent` are the
    // recursive CTE's own aliases. A `FROM` followed by a quote, a brace, an
    // operator or whitespace-then-something is a splice, and fails here even
    // when the pieces were concatenated rather than interpolated.
    // `FROM` must be followed by a bare identifier: not a quote, a brace, an
    // operator, or a closing paren glued onto the name.
    const offenders: string[] = []
    for (const match of stripped.matchAll(/\bFROM\s+([^\s(;,)]*)/g)) {
      const line = stripped.slice(0, match.index!).split('\n').length
      const target = match[1]!
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) {
        offenders.push(`${MODULE_RELATIVE}:${line} — FROM ${target}`)
      }
    }
    expect(offenders).toEqual([])

    const named = [...stripped.matchAll(/\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]!)
    const tables = [...new Set(named)].filter(t => t !== 'session_tree' && t !== 'parent')
    expect(tables.sort()).toEqual(['message', 'part', 'session', 'session_message', 'session_v2'])
  })

  it('a descriptor with deliberately invalid table names issues the identical statements', () => {
    // The runtime half. A generation whose FIELDS name something that is not a
    // table, against the same generation with honest fields, must reach SQLite
    // with byte-identical statements — because none was built from a field.
    const poison = 'session; DROP TABLE message; --'
    const poisoned: SqliteGeneration = {
      ...OPENCODE_FAMILY_1X,
      label: 'poisoned',
      sessionTable: poison,
      messageTable: poison,
      partTable: poison,
    }

    const dbDir = tempDir('guard-probe-')
    const dbPath = join(dbDir, 'opencode-test.db')
    const setup = writable(dbPath)
    setup.exec(
      'CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created REAL, time_archived REAL, parent_id TEXT)',
    )
    setup.exec('CREATE TABLE message (session_id TEXT, id TEXT, time_created REAL, data BLOB)')
    setup.exec('CREATE TABLE part (session_id TEXT, message_id TEXT, id TEXT, data BLOB)')
    setup.close()

    const read = openDatabase(dbPath)
    try {
      const record = (generations: readonly SqliteGeneration[]): string[] => {
        const seen: string[] = []
        const recorder: SqliteDatabase = {
          query<T>(sql: string, params?: unknown[]): T[] {
            seen.push(sql)
            return read.query<T>(sql, params)
          },
          close: () => {},
        }
        detectGeneration(recorder, generations)
        return seen
      }
      const honest = record([OPENCODE_FAMILY_1X])
      const dirty = record([poisoned])
      expect(dirty).toEqual(honest)
      expect(dirty.join('\n')).not.toContain('DROP TABLE')
      // And the probe really ran, so the equality is not empty-vs-empty.
      expect(dirty).toHaveLength(3)
    } finally {
      read.close()
    }
  })

  it('a descriptor with invalid table names discovers and parses identically', async () => {
    // The same property through the full discovery + parse path, where the
    // projection, the per-session routing and the tolerant reads all live. A
    // field that leaked into any statement surfaces as a thrown "no such table"
    // and an empty result.
    const poison = 'session_v2 WHERE 1=0; DROP TABLE session_message; --'
    const poisoned: SqliteGeneration = { ...OPENCODE_FAMILY_1X, label: 'poisoned', sessionTable: poison }

    const dbDir = tempDir('guard-e2e-')
    const dbPath = join(dbDir, 'opencode-test.db')
    const setup = writable(dbPath)
    setup.exec(
      'CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created REAL, time_archived REAL, parent_id TEXT)',
    )
    setup.exec('CREATE TABLE message (session_id TEXT, id TEXT, time_created REAL, data BLOB)')
    setup.exec('CREATE TABLE part (session_id TEXT, message_id TEXT, id TEXT, data BLOB)')
    setup.prepare('INSERT INTO session VALUES (?, ?, ?, ?, NULL, NULL)').run('ses-1', DIR, 't', 1750000000)
    setup
      .prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
      .run(
        'ses-1',
        'm1',
        1750000000,
        JSON.stringify({ role: 'assistant', modelID: 'gpt-4o', tokens: { input: 7, output: 3 } }),
      )
    setup
      .prepare('INSERT INTO part VALUES (?, ?, ?, ?)')
      .run('ses-1', 'm1', 'p1', JSON.stringify({ type: 'text', text: 'hi' }))
    setup.close()

    const config = (generations: readonly SqliteGeneration[]): SqliteProviderConfig => ({
      providerName: 'guard',
      displayName: 'Guard',
      dbDir,
      dbFilePrefix: 'opencode',
      generations,
    })

    const honestSources = await discoverSqliteSessions(config([OPENCODE_FAMILY_1X]))
    const poisonedSources = await discoverSqliteSessions(config([poisoned]))
    expect(poisonedSources).toEqual(honestSources)
    expect(honestSources.map(s => s.path)).toEqual([`${dbPath}:ses-1`])
    expect(JSON.stringify(poisonedSources)).not.toContain('DROP TABLE')

    const source = { path: `${dbPath}:ses-1`, project: 'p', provider: 'guard' }
    expect(await collect(createSqliteSessionParser(source, new Set(), config([poisoned])))).toEqual(
      await collect(createSqliteSessionParser(source, new Set(), config([OPENCODE_FAMILY_1X]))),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. The seam is not two-generation-shaped
// ─────────────────────────────────────────────────────────────────────────────

function createLegacySchema(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created REAL, time_archived REAL, parent_id TEXT)',
  )
  db.exec('CREATE TABLE message (session_id TEXT, id TEXT, time_created REAL, data BLOB)')
  db.exec('CREATE TABLE part (session_id TEXT, message_id TEXT, id TEXT, data BLOB)')
}

function createV2Schema(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE session_v2 (id TEXT, directory TEXT, title TEXT, time_created REAL, time_archived REAL, parent_id TEXT)',
  )
  db.exec(
    'CREATE TABLE session_message (session_id TEXT, id TEXT, type TEXT, seq INTEGER, time_created REAL, data BLOB)',
  )
}

function createV3Schema(db: DatabaseSync): void {
  db.exec(
    'CREATE TABLE session_v3 (id TEXT, directory TEXT, title TEXT, time_created REAL, time_archived REAL, parent_id TEXT)',
  )
  db.exec('CREATE TABLE message_v3 (session_id TEXT, id TEXT, time_created REAL, data BLOB)')
  db.exec('CREATE TABLE part_v3 (session_id TEXT, message_id TEXT, id TEXT, data BLOB)')
}

type MessageRowLike = { session_id: string; id: string; time_created: number; data: Uint8Array | string }

/// A THIRD generation, declared by a test provider, over a schema this module
/// has never heard of. If any two-generation assumption were baked into the
/// reader — a `session`/`session_v2` pair, a `partTable === null` meaning "is
/// 2.x", a list of length two — this is where it shows.
///
/// Note what it does with its OWN table names: it interpolates them into its own
/// probes, which is fine, because those are its statements. The shared
/// mechanism only ever calls these methods.
const TEST_FAMILY_3X: SqliteGeneration = {
  label: '3.x',
  sessionTable: 'session_v3',
  messageTable: 'message_v3',
  partTable: 'part_v3',
  normalizeMessages(db, sessionId): NormalizedMessages {
    const messages = db.query<MessageRowLike>(
      'SELECT session_id, id, time_created, CAST(data AS BLOB) AS data FROM message_v3 WHERE session_id = ? ORDER BY time_created ASC, id ASC',
      [sessionId],
    )
    const parts = db.query<{ message_id: string; data: Uint8Array | string }>(
      'SELECT message_id, CAST(data AS BLOB) AS data FROM part_v3 WHERE session_id = ? ORDER BY message_id, id',
      [sessionId],
    )
    const partsByMsg = new Map<string, PartData[]>()
    for (const part of parts) {
      try {
        const parsed = JSON.parse(blobToText(part.data)) as PartData
        partsByMsg.set(part.message_id, [...(partsByMsg.get(part.message_id) ?? []), parsed])
      } catch {
        // skip corrupt part data
      }
    }
    return { messages, partsByMsg, partRowCount: parts.length }
  },
  readSessionTotals(db, sessionId): SessionTotals | null {
    try {
      const rows = db.query<{ cost?: number; tokens_input?: number; model_id?: string }>(
        'SELECT cost, tokens_input, model_id FROM session_v3 WHERE id = ?',
        [sessionId],
      )
      const r = rows[0]
      if (!r) return null
      return {
        cost: r.cost ?? 0,
        input: r.tokens_input ?? 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        model: r.model_id ?? undefined,
      }
    } catch {
      return null
    }
  },
  readSessionDirectory(db, sessionId): string | undefined {
    try {
      const rows = db.query<{ directory: Uint8Array | string }>(
        'SELECT CAST(directory AS BLOB) AS directory FROM session_v3 WHERE id = ?',
        [sessionId],
      )
      return blobToText(rows[0]?.directory) || undefined
    } catch {
      return undefined
    }
  },
  hasSession(db, sessionId): boolean {
    try {
      return db.query<{ id: string }>('SELECT id FROM session_v3 WHERE id = ?', [sessionId]).length > 0
    } catch {
      return false
    }
  },
  projectSessions(db): SessionRow[] {
    return db.query<SessionRow>(
      'SELECT id, CAST(directory AS BLOB) AS directory, CAST(title AS BLOB) AS title, time_created FROM session_v3 WHERE time_archived IS NULL AND parent_id IS NULL ORDER BY time_created DESC',
    )
  },
  missingTables(db): string[] {
    const missing: string[] = []
    for (const table of ['session_v3', 'message_v3', 'part_v3']) {
      try {
        db.query(`SELECT 1 AS one FROM ${table} LIMIT 1`)
      } catch {
        missing.push(table)
      }
    }
    return missing
  },
}

describe('a third declared generation is resolved like the first two', () => {
  /// All three generations' tables in one DB. `ses-shared` is in all three,
  /// `ses-frozen-1x` only in 1.x, `ses-only-<gen>` only in its own.
  function allThree(): { dbDir: string; dbPath: string } {
    const dbDir = tempDir('gen3-')
    const dbPath = join(dbDir, 'opencode-test.db')
    const db = writable(dbPath)
    createLegacySchema(db)
    createV2Schema(db)
    createV3Schema(db)

    const flatAssistant = (table: string, sessionId: string, id: string, model: string, input: number): void => {
      db.prepare(`INSERT INTO ${table} (session_id, id, time_created, data) VALUES (?, ?, ?, ?)`).run(
        sessionId,
        id,
        1,
        JSON.stringify({ role: 'assistant', modelID: model, tokens: { input, output: 1 } }),
      )
    }
    const v2Assistant = (sessionId: string, id: string, input: number): void => {
      db.prepare(
        'INSERT INTO session_message (session_id, id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        sessionId,
        id,
        'assistant',
        0,
        1,
        JSON.stringify({ model: { id: 'gpt-5', providerID: 'openai' }, tokens: { input, output: 1 } }),
      )
    }

    for (const [table, gen] of [
      ['session', '1.x'],
      ['session_v2', '2.x'],
      ['session_v3', '3.x'],
    ] as const) {
      db.prepare(`INSERT INTO ${table} (id, directory, title, time_created) VALUES (?, ?, ?, ?)`).run(
        'ses-shared',
        DIR,
        gen,
        1,
      )
      db.prepare(`INSERT INTO ${table} (id, directory, title, time_created) VALUES (?, ?, ?, ?)`).run(
        `ses-only-${gen}`,
        DIR,
        gen,
        2,
      )
    }
    db.prepare('INSERT INTO session (id, directory, title, time_created) VALUES (?, ?, ?, ?)').run(
      'ses-frozen-1x',
      DIR,
      '1.x',
      3,
    )

    flatAssistant('message', 'ses-shared', 'msg-1x', 'gpt-4o', 11)
    flatAssistant('message', 'ses-frozen-1x', 'msg-f1x', 'gpt-4o', 12)
    flatAssistant('message', 'ses-only-1.x', 'msg-only-1x', 'gpt-4o', 13)
    v2Assistant('ses-shared', 'msg-2x', 22)
    v2Assistant('ses-only-2.x', 'msg-only-2x', 23)
    flatAssistant('message_v3', 'ses-shared', 'msg-3x', 'muse', 33)
    flatAssistant('message_v3', 'ses-only-3.x', 'msg-only-3x', 'muse', 34)
    flatAssistant('message_v3', 'ses-only-3.x', 'msg-only-3x-b', 'muse', 35)

    db.close()
    return { dbDir, dbPath }
  }

  function config(dbDir: string, generations: readonly SqliteGeneration[]): SqliteProviderConfig {
    return { providerName: 'gen3', displayName: 'Gen3', dbDir, dbFilePrefix: 'opencode', generations }
  }

  const ALL: readonly SqliteGeneration[] = [OPENCODE_FAMILY_2X, OPENCODE_FAMILY_1X, TEST_FAMILY_3X]

  it('ordering picks the FIRST declared available generation, third included', () => {
    const { dbPath } = allThree()
    const read = openDatabase(dbPath)
    try {
      expect(detectGeneration(read, ALL)?.label).toBe('2.x')
      expect(detectGeneration(read, [OPENCODE_FAMILY_1X, OPENCODE_FAMILY_2X, TEST_FAMILY_3X])?.label).toBe('1.x')
      expect(detectGeneration(read, [TEST_FAMILY_3X, OPENCODE_FAMILY_2X, OPENCODE_FAMILY_1X])?.label).toBe('3.x')
      // The third generation alone is a complete, self-sufficient declaration.
      expect(detectGeneration(read, [TEST_FAMILY_3X])?.label).toBe('3.x')
    } finally {
      read.close()
    }
  })

  it('per-session routing falls through to whichever generation holds the id', async () => {
    const f = allThree()
    const c = config(f.dbDir, ALL)
    const parse = (sessionId: string): Promise<ParsedProviderCall[]> =>
      collect(
        createSqliteSessionParser({ path: `${f.dbPath}:${sessionId}`, project: 'p', provider: 'gen3' }, new Set(), c),
      )

    // In all three → the first declared one wins.
    expect((await parse('ses-shared')).map(x => x.deduplicationKey)).toEqual(['gen3:ses-shared:msg-2x'])
    // Only in 1.x → read there, keeping its frozen history.
    expect((await parse('ses-frozen-1x')).map(x => x.deduplicationKey)).toEqual(['gen3:ses-frozen-1x:msg-f1x'])
    // Only in 3.x → reached with no 3.x branch anywhere in the shared mechanism.
    expect((await parse('ses-only-3.x')).map(x => x.deduplicationKey)).toEqual([
      'gen3:ses-only-3.x:msg-only-3x',
      'gen3:ses-only-3.x:msg-only-3x-b',
    ])
  })

  it("discovery surfaces the third generation's own sessions, deduped by id", async () => {
    const f = allThree()
    const paths = (await discoverSqliteSessions(config(f.dbDir, ALL))).map(s => s.path)

    // `ses-shared` appears once, claimed by the preferred generation; the older
    // and the third contribute only the ids that never migrated.
    const ids = paths.map(sessionIdOf).sort()
    expect(ids).toEqual(['ses-frozen-1x', 'ses-only-1.x', 'ses-only-2.x', 'ses-only-3.x', 'ses-shared'])
    expect(ids.filter(id => id === 'ses-shared')).toHaveLength(1)
  })

  it('a provider declaring ONLY the third generation never touches the other tables', async () => {
    const f = allThree()
    const paths = (await discoverSqliteSessions(config(f.dbDir, [TEST_FAMILY_3X]))).map(s => s.path)
    expect(paths.map(sessionIdOf).sort()).toEqual(['ses-only-3.x', 'ses-shared'])
  })

  it('a DB missing one 3.x table does not resolve to 3.x — half a migration is not a generation', () => {
    const dbDir = tempDir('gen3-half-')
    const dbPath = join(dbDir, 'opencode-test.db')
    const db = writable(dbPath)
    createV3Schema(db)
    db.exec('DROP TABLE part_v3')
    db.close()

    const read = openDatabase(dbPath)
    try {
      expect(detectGeneration(read, [TEST_FAMILY_3X])).toBeNull()
      expect(detectGeneration(read, [OPENCODE_FAMILY_1X, TEST_FAMILY_3X])).toBeNull()
      // The evidence the schema-drift warning is built from is the third
      // generation's own, not a re-derivation of it here.
      expect(TEST_FAMILY_3X.missingTables(read)).toEqual(['part_v3'])
    } finally {
      read.close()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Tolerance parity for the extracted reads
// ─────────────────────────────────────────────────────────────────────────────

/// A test provider's own generation over a schema whose session table has NO
/// `directory`, NO `cost` and NO `tokens_*` columns. Its tolerant reads are
/// therefore guaranteed to hit an ordinary SQL error, which is the case that
/// must degrade rather than abort.
const PLAIN_FAMILY: SqliteGeneration = {
  label: 'plain',
  sessionTable: 'plain_session',
  messageTable: 'plain_message',
  partTable: null,
  /// Content is inline in the message blob, the way 2.x writes it — the shape
  /// the shared builder understands, on a schema that has never heard of 2.x.
  normalizeMessages(db, sessionId): NormalizedMessages {
    const rows = db.query<MessageRowLike & { data: Uint8Array | string }>(
      'SELECT session_id, id, time_created, CAST(data AS BLOB) AS data FROM plain_message WHERE session_id = ? ORDER BY time_created ASC, id ASC',
      [sessionId],
    )
    const partsByMsg = new Map<string, PartData[]>()
    const messages = rows.map(row => {
      let payload: { role?: string; parts?: unknown } = {}
      try {
        payload = JSON.parse(blobToText(row.data)) as { role?: string; parts?: unknown }
      } catch {
        // keep the row with an unreadable blob; the parse loop drops it
      }
      if (Array.isArray(payload.parts)) {
        const parts = payload.parts.filter((p): p is PartData => typeof p === 'object' && p !== null)
        if (parts.length > 0) partsByMsg.set(row.id, parts)
      }
      return row
    })
    return { messages, partsByMsg, partRowCount: 0 }
  },
  readSessionTotals(db, sessionId): SessionTotals | null {
    try {
      const rows = db.query<{ cost?: number; tokens_input?: number }>(
        'SELECT cost, tokens_input FROM plain_session WHERE id = ?',
        [sessionId],
      )
      const r = rows[0]
      if (!r) return null
      return {
        cost: r.cost ?? 0,
        input: r.tokens_input ?? 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        model: undefined,
      }
    } catch {
      return null
    }
  },
  readSessionDirectory(db, sessionId): string | undefined {
    try {
      const rows = db.query<{ directory: Uint8Array | string }>(
        'SELECT CAST(directory AS BLOB) AS directory FROM plain_session WHERE id = ?',
        [sessionId],
      )
      return blobToText(rows[0]?.directory) || undefined
    } catch {
      return undefined
    }
  },
  hasSession(db, sessionId): boolean {
    try {
      return db.query<{ id: string }>('SELECT id FROM plain_session WHERE id = ?', [sessionId]).length > 0
    } catch {
      return false
    }
  },
  projectSessions(db): SessionRow[] {
    // No `directory` column to project, so the row carries only a title.
    return db.query<Omit<SessionRow, 'directory'>>(
      'SELECT id, CAST(title AS BLOB) AS title, time_created FROM plain_session WHERE time_archived IS NULL AND parent_id IS NULL ORDER BY time_created DESC',
    ) as SessionRow[]
  },
  missingTables(db): string[] {
    const missing: string[] = []
    for (const table of ['plain_session', 'plain_message']) {
      try {
        db.query(`SELECT 1 AS one FROM ${table} LIMIT 1`)
      } catch {
        missing.push(table)
      }
    }
    return missing
  },
}

describe('the tolerant reads degrade, they do not abort the parse', () => {
  /// No `directory`, no `cost`, no `tokens_*` on the session table.
  /// `ses-messages` has an assistant turn carrying a text part and no tokens or
  /// cost, so a call IS yielded and it carries zero vendor totals.
  /// `ses-useronly` has messages that cannot yield a call, so the session-level
  /// fallback — and therefore the failing totals read — is actually reached.
  function plainFixture(): { dbDir: string; dbPath: string; config: SqliteProviderConfig } {
    const dbDir = tempDir('tolerant-')
    const dbPath = join(dbDir, 'plain-test.db')
    const db = writable(dbPath)
    db.exec('CREATE TABLE plain_session (id TEXT, title TEXT, time_created REAL, time_archived REAL, parent_id TEXT)')
    db.exec('CREATE TABLE plain_message (session_id TEXT, id TEXT, time_created REAL, data BLOB)')

    const insert = (id: string, time: number): void =>
      db.prepare('INSERT INTO plain_session (id, title, time_created) VALUES (?, ?, ?)').run(id, 't', time)
    const message = (sessionId: string, id: string, data: unknown): void =>
      db
        .prepare('INSERT INTO plain_message (session_id, id, time_created, data) VALUES (?, ?, ?, ?)')
        .run(sessionId, id, 1, JSON.stringify(data))

    insert('ses-messages', 1)
    // The text part is what survives `buildAssistantCall`'s all-zero rule: no
    // tokens and no cost, but real output, so the turn counts as a call.
    message('ses-messages', 'm1', { role: 'assistant', modelID: 'gpt-4o', parts: [{ type: 'text', text: 'hi' }] })
    insert('ses-useronly', 2)
    message('ses-useronly', 'm2', { role: 'user' })
    db.close()

    return {
      dbDir,
      dbPath,
      config: {
        providerName: 'plain',
        displayName: 'Plain',
        dbDir,
        dbFilePrefix: 'plain',
        generations: [PLAIN_FAMILY],
      },
    }
  }

  it("a totals read that fails ordinarily still yields the session's calls, with zero vendor totals", async () => {
    const f = plainFixture()
    const calls = await collect(
      createSqliteSessionParser(
        { path: `${f.dbPath}:ses-messages`, project: 'p', provider: 'plain' },
        new Set(),
        f.config,
      ),
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.inputTokens).toBe(0)
    expect(calls[0]!.outputTokens).toBe(0)
    expect(calls[0]!.costUSD).toBe(0)
    // The directory read failed the same way: the session keeps its history and
    // simply has no project identity.
    expect(calls[0]!.workingDirectory).toBeUndefined()
    expect(calls[0]!.projectPath).toBeUndefined()
  })

  it('a totals read that fails ordinarily on the fallback path yields nothing and does not throw', async () => {
    const f = plainFixture()
    const parser = createSqliteSessionParser(
      { path: `${f.dbPath}:ses-useronly`, project: 'p', provider: 'plain' },
      new Set(),
      f.config,
    )
    // No session-level call is invented from a rollup the schema does not have,
    // and the failure never escapes the parse.
    await expect(collect(parser)).resolves.toEqual([])
  })

  it('the extracted reads return null / undefined on a schema without the columns', () => {
    // Parity with the 1.x descriptor, called directly: the seam did not change
    // what "the columns are missing" means.
    const dbDir = tempDir('tolerant-parity-')
    const dbPath = join(dbDir, 'opencode-test.db')
    const db = writable(dbPath)
    db.exec('CREATE TABLE session (id TEXT, title TEXT, time_created REAL, time_archived REAL, parent_id TEXT)')
    db.exec('CREATE TABLE message (session_id TEXT, id TEXT, time_created REAL, data BLOB)')
    db.exec('CREATE TABLE part (session_id TEXT, message_id TEXT, id TEXT, data BLOB)')
    db.prepare('INSERT INTO session (id, title, time_created) VALUES (?, ?, ?)').run('ses-1', 't', 1)
    db.close()

    const read = openDatabase(dbPath)
    try {
      expect(OPENCODE_FAMILY_1X.readSessionTotals(read, 'ses-1')).toBeNull()
      expect(OPENCODE_FAMILY_1X.readSessionDirectory(read, 'ses-1')).toBeUndefined()
      // And for a session that is not there at all.
      expect(OPENCODE_FAMILY_1X.readSessionTotals(read, 'nope')).toBeNull()
      expect(OPENCODE_FAMILY_1X.readSessionDirectory(read, 'nope')).toBeUndefined()
    } finally {
      read.close()
    }
  })

  it('the extracted reads keep their field mapping: `?? 0` defaults, `model_id` fallback', () => {
    // The mapping did not move with the statement: every total defaults to 0,
    // and the model falls back to undefined rather than to a placeholder.
    const dbDir = tempDir('tolerant-mapping-')
    const dbPath = join(dbDir, 'opencode-test.db')
    const db = writable(dbPath)
    db.exec(
      'CREATE TABLE session (id TEXT, directory TEXT, title TEXT, cost REAL, tokens_input REAL, tokens_output REAL, tokens_reasoning REAL, tokens_cache_read REAL, tokens_cache_write REAL, model_id TEXT, time_created REAL)',
    )
    db.prepare(
      'INSERT INTO session (id, directory, title, cost, tokens_input, tokens_cache_read, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('partial', DIR, 't', 1.5, 9, 4, 'muse')
    db.close()

    const read = openDatabase(dbPath)
    try {
      expect(OPENCODE_FAMILY_1X.readSessionTotals(read, 'partial')).toEqual({
        cost: 1.5,
        input: 9,
        output: 0,
        reasoning: 0,
        cacheRead: 4,
        cacheWrite: 0,
        model: 'muse',
      })
      expect(OPENCODE_FAMILY_1X.readSessionDirectory(read, 'partial')).toBe(DIR)
    } finally {
      read.close()
    }
  })

  it('every read on a generation re-throws a busy DB rather than reporting "nothing there"', () => {
    // A locked DB is not an empty one. Swallowing busy anywhere in these
    // methods would mark a live schema as one that yielded nothing, and the scan
    // would seal that as a fully-scanned period.
    const busy = {
      query: () => {
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
      },
      close: () => {},
    } as unknown as SqliteDatabase
    for (const generation of [OPENCODE_FAMILY_1X, OPENCODE_FAMILY_2X]) {
      expect(() => generation.readSessionTotals(busy, 's')).toThrow(/locked/i)
      expect(() => generation.readSessionDirectory(busy, 's')).toThrow(/locked/i)
      expect(() => generation.hasSession(busy, 's')).toThrow(/locked/i)
      expect(() => generation.missingTables(busy)).toThrow(/locked/i)
    }
  })
})
