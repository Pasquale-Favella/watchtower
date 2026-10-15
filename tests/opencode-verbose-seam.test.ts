import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { type AppPaths, appPaths, type ProviderOverrides } from '../src/main/env.js'
import {
  createSqliteSessionParser,
  OPENCODE_FAMILY_1X,
  type SqliteProviderConfig,
} from '../src/main/pipeline/providers/opencode-family-sqlite.js'

// The shared reader's ONE env consumer: the verbose "yielded 0 calls" notice
// for a session that has messages but produced no calls. This was the last
// registered direct `process.env` read in the tree (`REMAINING_DIRECT_ENV_READS`
// in env.ts named it), and it now resolves through the AppPaths seam — one
// optional trailing `paths`, read only for `WATCHTOWER_VERBOSE`.
//
// The reachability recipe, in one sentence, because it is not obvious: a session
// whose messages are ALL non-user/assistant roles skips every call
// (`roleSkipCount++`), so `yieldCount` stays 0 while `messages.length > 0` — and
// the 1.x `session` table here has no `cost`/`tokens_*` columns at all, so the
// session-level totals fallback finds nothing either. Both halves must hold or
// the notice is unreachable and every case below would vacuously pass.
//
// ZERO `process.env` mutation in this file, like every other Wave-9/10 seam test:
// records are built by spread and passed as the trailing argument, and the
// unthreaded case reads the ambient value in its expectation rather than
// writing it. Each case uses its OWN session id and display name, so no
// assertion can pass because a module-level memo already fired for a previous
// case's name.
const DIR = 'C:\\work\\watchtower'
const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function pathsWith(overrides: ProviderOverrides): AppPaths {
  return { ...appPaths(), overrides }
}

function configFor(dbDir: string, displayName: string, providerName: string): SqliteProviderConfig {
  return {
    providerName,
    displayName,
    dbDir,
    dbFilePrefix: 'opencode',
    generations: [OPENCODE_FAMILY_1X],
  }
}

/**
 * A 1.x DB with one session holding exactly one `role: 'system'` message. No
 * part rows (so the notice's `Parts: 0` is exercised too), and no token columns
 * on `session` (so the totals fallback cannot rescue a call).
 */
function zeroYieldFixture(sessionId: string): { dbDir: string; source: { path: string; project: string } } {
  const dbDir = mkdtempSync(join(tmpdir(), 'oc-verbose-'))
  tempDirs.push(dbDir)
  const dbPath = join(dbDir, 'opencode-verbose.db')
  const db = new DatabaseSync(dbPath)
  db.exec(
    'CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created REAL, time_archived REAL, parent_id TEXT)',
  )
  db.exec('CREATE TABLE message (session_id TEXT, id TEXT, time_created REAL, data BLOB)')
  db.exec('CREATE TABLE part (session_id TEXT, message_id TEXT, id TEXT, data BLOB)')
  db.prepare('INSERT INTO session (id, directory, title, time_created) VALUES (?, ?, ?, ?)').run(
    sessionId,
    DIR,
    `title-${sessionId}`,
    1750000000,
  )
  db.prepare('INSERT INTO message (session_id, id, time_created, data) VALUES (?, ?, ?, ?)').run(
    sessionId,
    `${sessionId}-m0`,
    1750000000,
    JSON.stringify({ role: 'system' }),
  )
  db.close()
  return { dbDir, source: { path: `${dbPath}:${sessionId}`, project: DIR } }
}

/** Only the reader's own notice, so a stray write from elsewhere cannot be
 *  counted as the gate being open (and vice versa). */
function captureNotices(): { lines: () => string[] } {
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  return { lines: () => spy.mock.calls.map(call => String(call[0])).filter(line => line.includes('yielded 0 calls')) }
}

async function parse(
  source: { path: string; project: string },
  config: SqliteProviderConfig,
  paths?: AppPaths,
): Promise<void> {
  for await (const _ of createSqliteSessionParser(
    { ...source, provider: config.providerName },
    new Set(),
    config,
    paths,
  ).parse()) {
    void _
  }
}

const verboseIsOn = process.env['WATCHTOWER_VERBOSE'] === '1'

describe('the sqlite reader verbose gate (WATCHTOWER_VERBOSE seam)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a threaded "1" opens the notice, with the session it is about', async () => {
    const sessionId = 'ses-verbose-threaded-on'
    const { dbDir, source } = zeroYieldFixture(sessionId)
    const config = configFor(dbDir, `Verbose On ${sessionId}`, 'verbose-on')
    const { lines } = captureNotices()

    await parse(source, config, pathsWith({ WATCHTOWER_VERBOSE: '1' }))

    expect(lines()).toEqual([
      `watchtower: ${config.displayName} session has 1 messages (0 unparseable, 1 non-user/assistant roles) ` +
        `but yielded 0 calls. Parts: 0.\n`,
    ])
  })

  it.each([['0'], ['true'], ['']])('a threaded %j leaves it shut (=== "1", not truthiness)', async raw => {
    // Three separate session ids: the notice carries the display name, so a
    // shared one would let one case's write stand in for another's.
    const sessionId = `ses-verbose-threaded-${raw === '' ? 'empty' : raw}`
    const { dbDir, source } = zeroYieldFixture(sessionId)
    const config = configFor(dbDir, `Verbose Off ${raw} ${sessionId}`, 'verbose-off')
    const { lines } = captureNotices()

    await parse(source, config, pathsWith({ WATCHTOWER_VERBOSE: raw }))

    expect(lines()).toEqual([])
  })

  it('a record without the key is inert even where the ambient env has it set', async () => {
    // A threaded record REPLACES the overrides map rather than merging with
    // `process.env` (documented `overrideFor` semantics), so an empty record
    // resolves the flag to `undefined` on a machine that exports
    // `WATCHTOWER_VERBOSE=1` too. That is the behavior worth pinning: once a
    // record is threaded, the seam reads the record, not the host.
    const sessionId = 'ses-verbose-threaded-inert'
    const { dbDir, source } = zeroYieldFixture(sessionId)
    const config = configFor(dbDir, `Verbose Inert ${sessionId}`, 'verbose-inert')
    const { lines } = captureNotices()

    await parse(source, config, pathsWith({}))

    expect(lines()).toEqual([])
  })

  it('the unthreaded call still reads the ambient gate, and only "1" opens it', async () => {
    const sessionId = 'ses-verbose-unthreaded'
    const { dbDir, source } = zeroYieldFixture(sessionId)
    const config = configFor(dbDir, `Verbose Unthreaded ${sessionId}`, 'verbose-unthreaded')
    const { lines } = captureNotices()

    // Omitted argument — the shape `kilo-code.ts` uses today, and the reason
    // omitting it is behavior-preserving rather than a silent opt-out.
    await parse(source, config)

    expect(lines().length).toBe(verboseIsOn ? 1 : 0)
    if (verboseIsOn) expect(lines()[0]).toContain('yielded 0 calls')
  })

  it('the notice is gated on yieldCount === 0: a session that yields a call stays quiet', async () => {
    // The guard is unchanged by the seam, so a session with ONE real assistant
    // call never reaches the write even with the flag threaded on.
    const sessionId = 'ses-verbose-yields'
    const dbDir = mkdtempSync(join(tmpdir(), 'oc-verbose-'))
    tempDirs.push(dbDir)
    const dbPath = join(dbDir, 'opencode-verbose.db')
    const db = new DatabaseSync(dbPath)
    db.exec(
      'CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created REAL, time_archived REAL, parent_id TEXT)',
    )
    db.exec('CREATE TABLE message (session_id TEXT, id TEXT, time_created REAL, data BLOB)')
    db.exec('CREATE TABLE part (session_id TEXT, message_id TEXT, id TEXT, data BLOB)')
    db.prepare('INSERT INTO session (id, directory, title, time_created) VALUES (?, ?, ?, ?)').run(
      sessionId,
      DIR,
      `title-${sessionId}`,
      1750000000,
    )
    db.prepare('INSERT INTO message (session_id, id, time_created, data) VALUES (?, ?, ?, ?)').run(
      sessionId,
      `${sessionId}-m0`,
      1750000000,
      JSON.stringify({ role: 'assistant', modelID: 'gpt-4o', tokens: { input: 10, output: 5 } }),
    )
    db.prepare('INSERT INTO part (session_id, message_id, id, data) VALUES (?, ?, ?, ?)').run(
      sessionId,
      `${sessionId}-m0`,
      `${sessionId}-p0`,
      JSON.stringify({ type: 'text', text: 'an answer' }),
    )
    db.close()

    const config = configFor(dbDir, `Verbose Yields ${sessionId}`, 'verbose-yields')
    const { lines } = captureNotices()
    const calls: string[] = []
    for await (const call of createSqliteSessionParser(
      { path: `${dbPath}:${sessionId}`, project: DIR, provider: 'verbose-yields' },
      new Set(),
      config,
      pathsWith({ WATCHTOWER_VERBOSE: '1' }),
    ).parse()) {
      calls.push(call.deduplicationKey)
    }

    expect(calls.length).toBeGreaterThan(0)
    expect(lines()).toEqual([])
  })
})
