import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterAll, describe, expect, it } from 'vitest'

import { getSqliteConfig as kiloSqliteConfig } from '../src/main/pipeline/providers/kilo-code.js'
import { getSqliteConfig as opencodeSqliteConfig } from '../src/main/pipeline/providers/opencode.js'
import {
  createSqliteSessionParser,
  detectGeneration,
  discoverSqliteSessions,
  OPENCODE_FAMILY_1X,
  OPENCODE_FAMILY_2X,
  type SqliteGeneration,
  type SqliteProviderConfig,
} from '../src/main/pipeline/providers/opencode-family-sqlite.js'
import type { ParsedProviderCall, SessionParser } from '../src/main/pipeline/providers/types.js'
import { openDatabase } from '../src/main/pipeline/sqlite.js'

// ADR 0006: a provider is an isolated, replaceable unit. That only holds if the
// SHARED reader holds no opinion about which tools have migrated.
//
// This file is the pin for that. Every case here fails if someone adds a
// generation's table names to a provider that did not declare them — which is
// how the OpenCode 2.x tables once leaked into kilo-code, where the reader had
// them hardcoded globally and no provider could decline them.

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

function insertLegacySession(db: DatabaseSync, id: string, title: string, timeCreated: number): void {
  db.prepare('INSERT INTO session (id, directory, title, time_created) VALUES (?, ?, ?, ?)').run(
    id,
    DIR,
    title,
    timeCreated,
  )
}

function insertLegacyAssistant(db: DatabaseSync, sessionId: string, id: string, timeCreated: number): void {
  db.prepare('INSERT INTO message (session_id, id, time_created, data) VALUES (?, ?, ?, ?)').run(
    sessionId,
    id,
    timeCreated,
    JSON.stringify({ role: 'assistant', modelID: 'gpt-4o', tokens: { input: 10, output: 5 } }),
  )
  db.prepare('INSERT INTO part (session_id, message_id, id, data) VALUES (?, ?, ?, ?)').run(
    sessionId,
    id,
    `${id}-p0`,
    JSON.stringify({ type: 'text', text: 'legacy answer' }),
  )
}

function insertV2Session(db: DatabaseSync, id: string, title: string, timeCreated: number): void {
  db.prepare('INSERT INTO session_v2 (id, directory, title, time_created) VALUES (?, ?, ?, ?)').run(
    id,
    DIR,
    title,
    timeCreated,
  )
}

function insertV2Message(
  db: DatabaseSync,
  sessionId: string,
  id: string,
  timeCreated: number,
  tokens: { input: number; output: number },
): void {
  db.prepare(
    'INSERT INTO session_message (session_id, id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    sessionId,
    id,
    'assistant',
    0,
    timeCreated,
    JSON.stringify({
      model: { id: 'gpt-5', providerID: 'openai' },
      tokens,
      content: [{ type: 'text', text: 'v2 answer' }],
    }),
  )
}

async function collect(parser: SessionParser): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  for await (const call of parser.parse()) calls.push(call)
  return calls
}

/// The 1.x tables carrying the real rows, PLUS both 2.x tables present and
/// populated. Every kilo reading must still come from `message` / `part`.
function kiloWithV2TablesFixture(): { dbDir: string; dbPath: string; config: SqliteProviderConfig } {
  const dbDir = tempDir('kilo-v2-present-')
  const dbPath = join(dbDir, 'kilo-test.db')
  const db = writable(dbPath)
  createLegacySchema(db)
  createV2Schema(db)

  insertLegacySession(db, 'ses-kilo', 'kilo session', 1750000000)
  insertLegacyAssistant(db, 'ses-kilo', 'msg-kilo', 1750000000)

  // A 2.x session the 1.x path cannot see. If kilo-code ever routes here, this
  // is what it emits instead — a different model, different tokens, different
  // keys — which is exactly the coupling this file exists to prevent.
  insertV2Session(db, 'ses-v2-only', 'v2 only', 1750000100)
  insertV2Message(db, 'ses-v2-only', 'msg-v2-only', 1750000100, { input: 7777, output: 8888 })

  db.close()
  return { dbDir, dbPath, config: KILO_CONFIG(dbDir) }
}

function KILO_CONFIG(dbDir: string): SqliteProviderConfig {
  return {
    providerName: 'kilo-code',
    displayName: 'KiloCode',
    dbDir,
    dbFilePrefix: 'kilo',
    generations: [OPENCODE_FAMILY_1X],
  }
}

const OPENCODE_GENERATIONS: readonly SqliteGeneration[] = [OPENCODE_FAMILY_2X, OPENCODE_FAMILY_1X]

describe('per-provider generation declaration', () => {
  it('opencode.ts declares both generations with 2.x preferred', () => {
    // Asserted on the CONFIG OBJECT the provider hands the shared reader, not
    // by reading its source, so this fails if the list is ever computed,
    // inherited, reordered or dropped.
    const config = opencodeSqliteConfig(tempDir('oc-config-'))
    expect(config.generations.map(g => g.label)).toEqual(['2.x', '1.x'])
  })

  it('kilo-code.ts declares only the 1.x generation', () => {
    const config = kiloSqliteConfig()
    expect(config.generations.map(g => g.label)).toEqual(['1.x'])
  })

  it('kilo-code.ts names no 2.x table anywhere in its declaration', () => {
    // The declaration, walked field by field. A generation added to kilo's list
    // by copy-paste fails here even if it were somehow labelled '1.x'.
    const tables = kiloSqliteConfig().generations.flatMap(g =>
      g.partTable === null ? [g.sessionTable, g.messageTable] : [g.sessionTable, g.messageTable, g.partTable],
    )
    expect(tables).not.toContain('session_v2')
    expect(tables).not.toContain('session_message')
  })

  it('no provider generation declares a table its own label does not own', () => {
    // A generation is a descriptor: label + tables + normalizer. The tables it
    // names must be the ones its label refers to, or a declaration is lying.
    expect(OPENCODE_FAMILY_1X.sessionTable).toBe('session')
    expect(OPENCODE_FAMILY_1X.messageTable).toBe('message')
    expect(OPENCODE_FAMILY_1X.partTable).toBe('part')
    expect(OPENCODE_FAMILY_2X.sessionTable).toBe('session_v2')
    expect(OPENCODE_FAMILY_2X.messageTable).toBe('session_message')
    // 2.x has no part table: its content is inline in the message blob.
    expect(OPENCODE_FAMILY_2X.partTable).toBeNull()
  })
})

describe('kilo-code is not subject to OpenCode’s migration', () => {
  // ── THE regression test. ────────────────────────────────────────────────
  // A kilo DB that has BOTH `session_v2` and `session_message` present, with the
  // real rows still in the 1.x `session` / `message` / `part` tables. Under the
  // hardcoded global policy this provider was read as 2.x and produced nothing
  // for its own session; it now must read 1.x and emit the 1.x calls.
  it('reads the 1.x tables even when session_v2 and session_message both exist', async () => {
    const f = kiloWithV2TablesFixture()
    const sources = await discoverSqliteSessions(f.config)

    // Discovery sees only the 1.x session: kilo declared no 2.x generation, so
    // no 2.x table was ever projected.
    expect(sources.map(s => s.path)).toEqual([`${f.dbPath}:ses-kilo`])

    const calls = await collect(createSqliteSessionParser(sources[0]!, new Set(), f.config))

    // The 1.x call, with the 1.x shape. If this ever produced the 2.x session's
    // `providerID/id` model ref or its 7777/8888 tokens, the coupling is back.
    expect(calls.map(c => c.deduplicationKey)).toEqual(['kilo-code:ses-kilo:msg-kilo'])
    expect(calls[0]!.model).toBe('gpt-4o')
    expect(calls[0]!.inputTokens).toBe(10)
    expect(calls[0]!.outputTokens).toBe(5)
  })

  it('never resolves a 2.x generation on a DB that has both, however the config is built', () => {
    const f = kiloWithV2TablesFixture()
    const read = openDatabase(f.dbPath)
    try {
      // The descriptor exists and would be chosen by a provider that declared
      // it. kilo does not. That is the whole seam.
      expect(detectGeneration(read, OPENCODE_GENERATIONS)?.label).toBe('2.x')
      expect(detectGeneration(read, f.config.generations)?.label).toBe('1.x')
    } finally {
      read.close()
    }
  })

  it('a kilo session id that also exists in session_v2 is still read as 1.x', async () => {
    // The per-session rule walks the provider's DECLARED generations. With one
    // declared, the id's presence in an undeclared table is invisible.
    const f = kiloWithV2TablesFixture()
    const db = writable(f.dbPath)
    insertLegacySession(db, 'ses-shared', 'shared', 1750000200)
    insertLegacyAssistant(db, 'ses-shared', 'msg-shared-legacy', 1750000200)
    insertV2Session(db, 'ses-shared', 'shared', 1750000200)
    insertV2Message(db, 'ses-shared', 'msg-shared-v2', 1750000200, { input: 7777, output: 8888 })
    db.close()

    const calls = await collect(
      createSqliteSessionParser(
        { path: `${f.dbPath}:ses-shared`, project: 'p', provider: 'kilo-code' },
        new Set(),
        f.config,
      ),
    )
    expect(calls.map(c => c.deduplicationKey)).toEqual(['kilo-code:ses-shared:msg-shared-legacy'])
    expect(calls[0]!.inputTokens).toBe(10)
  })
})

describe('generation resolution is per-declared-list', () => {
  function dbWith(prefix: string, build: (db: DatabaseSync) => void): { dbPath: string; dbDir: string } {
    const dbDir = tempDir(prefix)
    const dbPath = join(dbDir, 'opencode-test.db')
    const db = writable(dbPath)
    build(db)
    db.close()
    return { dbPath, dbDir }
  }

  function resolve(dbPath: string, generations: readonly SqliteGeneration[]): SqliteGeneration | null {
    const read = openDatabase(dbPath)
    try {
      return detectGeneration(read, generations)
    } finally {
      read.close()
    }
  }

  it('a DB with only the 1.x tables resolves to 1.x', () => {
    const { dbPath } = dbWith('gen-1x-only-', createLegacySchema)
    expect(resolve(dbPath, OPENCODE_GENERATIONS)?.label).toBe('1.x')
  })

  it('a DB with both resolves to the FIRST-DECLARED available generation', () => {
    const { dbPath } = dbWith('gen-both-', db => {
      createLegacySchema(db)
      createV2Schema(db)
    })
    // Reversing the declaration order flips the answer — the order IS the
    // policy, not the schema.
    expect(resolve(dbPath, OPENCODE_GENERATIONS)?.label).toBe('2.x')
    expect(resolve(dbPath, [OPENCODE_FAMILY_1X, OPENCODE_FAMILY_2X])?.label).toBe('1.x')
  })

  it('a DB with only ONE 2.x table does not resolve to 2.x', () => {
    for (const partial of [
      'CREATE TABLE session_v2 (id TEXT, directory TEXT, title TEXT, time_created REAL, time_archived REAL, parent_id TEXT)',
      'CREATE TABLE session_message (session_id TEXT, id TEXT, type TEXT, seq INTEGER, time_created REAL, data BLOB)',
    ]) {
      const { dbPath } = dbWith('gen-half-', db => {
        createLegacySchema(db)
        db.exec(partial)
      })
      expect(resolve(dbPath, OPENCODE_GENERATIONS)?.label).toBe('1.x')
      // And with 2.x declared ALONE — no fallback to borrow — it is unreadable.
      expect(resolve(dbPath, [OPENCODE_FAMILY_2X])).toBeNull()
    }
  })

  it('a DB matching neither declared generation resolves to null', () => {
    const { dbPath } = dbWith('gen-neither-', db => {
      db.exec('CREATE TABLE unrelated (id TEXT)')
    })
    expect(resolve(dbPath, OPENCODE_GENERATIONS)).toBeNull()
  })

  it('an empty declaration list resolves to null — the reader has no default', () => {
    const { dbPath } = dbWith('gen-none-declared-', db => {
      createLegacySchema(db)
      createV2Schema(db)
    })
    expect(resolve(dbPath, [])).toBeNull()
  })
})

describe('per-session resolution', () => {
  /// `session` + `message` + `part` AND `session_v2` + `session_message`, with
  /// one session in both and one that only ever existed in 1.x.
  function upgraded(): { dbDir: string; dbPath: string; config: SqliteProviderConfig } {
    const dbDir = tempDir('gen-upgraded-')
    const dbPath = join(dbDir, 'opencode-test.db')
    const db = writable(dbPath)
    createLegacySchema(db)
    createV2Schema(db)

    insertLegacySession(db, 'ses-both', 'both', 1)
    insertLegacyAssistant(db, 'ses-both', 'msg-legacy', 1)
    insertV2Session(db, 'ses-both', 'both', 1)
    insertV2Message(db, 'ses-both', 'msg-v2', 1, { input: 50, output: 10 })

    insertLegacySession(db, 'ses-frozen', 'frozen', 2)
    insertLegacyAssistant(db, 'ses-frozen', 'msg-f1', 2)
    insertLegacyAssistant(db, 'ses-frozen', 'msg-f2', 3)

    db.close()
    return { dbDir, dbPath, config: OPENCODE_CONFIG(dbDir) }
  }

  it('a session present only in the older generation is read there, keeping its frozen history', async () => {
    const f = upgraded()
    const calls = await collect(
      createSqliteSessionParser(
        { path: `${f.dbPath}:ses-frozen`, project: 'p', provider: 'opencode' },
        new Set(),
        f.config,
      ),
    )
    // Read through `message`/`part` — two calls — not through `session_message`,
    // which would find nothing and drop the session's whole history.
    expect(calls.map(c => c.deduplicationKey)).toEqual(['opencode:ses-frozen:msg-f1', 'opencode:ses-frozen:msg-f2'])
    expect(calls.every(c => c.model === 'gpt-4o' && c.inputTokens === 10)).toBe(true)
  })

  it('a session present in both is read through the preferred generation', async () => {
    const f = upgraded()
    const calls = await collect(
      createSqliteSessionParser(
        { path: `${f.dbPath}:ses-both`, project: 'p', provider: 'opencode' },
        new Set(),
        f.config,
      ),
    )
    expect(calls.map(c => c.deduplicationKey)).toEqual(['opencode:ses-both:msg-v2'])
    expect(calls[0]!.model).toBe('openai/gpt-5')
  })

  it('flipping the declaration order flips which generation a shared session is read through', async () => {
    const f = upgraded()
    const reversed: SqliteProviderConfig = { ...f.config, generations: [OPENCODE_FAMILY_1X, OPENCODE_FAMILY_2X] }
    const calls = await collect(
      createSqliteSessionParser(
        { path: `${f.dbPath}:ses-both`, project: 'p', provider: 'opencode' },
        new Set(),
        reversed,
      ),
    )
    expect(calls.map(c => c.deduplicationKey)).toEqual(['opencode:ses-both:msg-legacy'])
  })

  it('a session id in neither generation falls back to the preferred generation and yields nothing', async () => {
    const f = upgraded()
    const calls = await collect(
      createSqliteSessionParser(
        { path: `${f.dbPath}:ses-ghost`, project: 'p', provider: 'opencode' },
        new Set(),
        f.config,
      ),
    )
    expect(calls).toEqual([])
  })
})

describe('discovery dedupes across generations without naming another table', () => {
  function upgradedWithChildren(): { dbDir: string; dbPath: string; config: SqliteProviderConfig } {
    const dbDir = tempDir('gen-disc-')
    const dbPath = join(dbDir, 'opencode-test.db')
    const db = writable(dbPath)
    createLegacySchema(db)
    createV2Schema(db)

    // In both tables. The 2.x row is preferred and richer.
    insertLegacySession(db, 'ses-both', 'both', 1)
    insertLegacyAssistant(db, 'ses-both', 'msg-legacy', 1)
    insertV2Session(db, 'ses-both', 'both', 1)
    insertV2Message(db, 'ses-both', 'msg-v2', 1, { input: 50, output: 10 })

    // Only ever 1.x — frozen, and must still be discovered.
    insertLegacySession(db, 'ses-frozen', 'frozen', 2)
    insertLegacyAssistant(db, 'ses-frozen', 'msg-f1', 2)

    // Children on both tables: never a discovery source on either.
    db.prepare('INSERT INTO session (id, parent_id, time_created) VALUES (?, ?, ?)').run('ses-child', 'ses-both', 3)
    db.prepare('INSERT INTO session_v2 (id, parent_id, time_created) VALUES (?, ?, ?)').run(
      'ses-child-v2',
      'ses-both',
      3,
    )

    db.close()
    return { dbDir, dbPath, config: OPENCODE_CONFIG(dbDir) }
  }

  it('surfaces a session present in both tables exactly once', async () => {
    const f = upgradedWithChildren()
    const sources = await discoverSqliteSessions(f.config)
    const paths = sources.map(s => s.path)
    expect(paths).toHaveLength(2)
    expect(new Set(paths).size).toBe(2)
    expect(paths.filter(p => p.endsWith(':ses-both'))).toHaveLength(1)
    expect(paths.sort()).toEqual([`${f.dbPath}:ses-both`, `${f.dbPath}:ses-frozen`])
  })

  it('a 1.x-only declaration never projects the 2.x tables at all', async () => {
    const f = upgradedWithChildren()
    const sources = await discoverSqliteSessions({ ...f.config, generations: [OPENCODE_FAMILY_1X] })
    const paths = sources.map(s => s.path)
    expect(paths).toHaveLength(2)
    // Both ids exist in `session`, so both surface — and neither is duplicated
    // by the v2 table, because that table is never queried.
    expect(new Set(paths).size).toBe(2)
  })

  it('an unarchived top-level filter is applied on every generation', async () => {
    const f = upgradedWithChildren()
    const db = writable(f.dbPath)
    db.prepare('INSERT INTO session_v2 (id, directory, title, time_created, time_archived) VALUES (?, ?, ?, ?, ?)').run(
      'ses-archived',
      DIR,
      'archived',
      4,
      9,
    )
    db.close()

    const paths = (await discoverSqliteSessions(f.config)).map(s => s.path)
    expect(paths.some(p => p.endsWith(':ses-archived'))).toBe(false)
  })
})

function OPENCODE_CONFIG(dbDir: string): SqliteProviderConfig {
  return {
    providerName: 'opencode',
    displayName: 'OpenCode',
    dbDir,
    dbFilePrefix: 'opencode',
    generations: OPENCODE_GENERATIONS,
  }
}
