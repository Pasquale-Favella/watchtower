import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { type AppPaths, appPaths } from '../src/main/env.js'
import { writeCachedResults } from '../src/main/pipeline/cursor-cache.js'
import { createCursorProvider } from '../src/main/pipeline/providers/cursor.js'
import type { ParsedProviderCall, Provider } from '../src/main/pipeline/providers/types.js'

// `WATCHTOWER_SUPPRESS_CACHE_WRITES` call-site-root exemplar: the value is
// carried on the `AppPaths` snapshot and threaded from `createCursorProvider`
// down to `writeCachedResults`, which keeps its own `??` fallback for callers
// that thread nothing. Every case below READS `process.env` (never writes it)
// and injects through the snapshot, so the test is honest about whatever the
// ambient env happens to be on the machine that runs it.
//
// `cursor-cache.ts` hard-codes its cache dir to
// `join(homedir(), '.cache', 'watchtower')` — unlike its sibling
// `codex-cache.ts`, it does not go through `resolveCacheDir()` — so running
// this seam against the real fs would read and overwrite the developer's own
// cursor cache. The `fs/promises` seam is stubbed instead: `stat` still runs
// for real against a temp DB file (a genuine fingerprint), every call is
// recorded, and nothing outside the temp dir is ever read or written.
const { fsCalls } = vi.hoisted(() => ({ fsCalls: [] as string[] }))

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      fsCalls.push(`${name}(${String(args[0])})`)
      return Promise.resolve(undefined)
    }
  return {
    ...actual,
    // "No cursor cache on disk" for the read path, so every parse reaches the
    // write path instead of short-circuiting on some other run's entry.
    readFile: () => {
      fsCalls.push('readFile')
      return Promise.reject(new Error('cursor cache stubbed'))
    },
    stat: (...args: unknown[]) => {
      fsCalls.push(`stat(${String(args[0])})`)
      return (actual.stat as unknown as (...a: unknown[]) => unknown)(...args)
    },
    mkdir: record('mkdir'),
    writeFile: record('writeFile'),
    rename: record('rename'),
    unlink: record('unlink'),
  }
})

const FLOOR = '2024-01-01T00:00:00.000Z'

/** What the ambient env says right now, read once and never mutated. */
const ENV_SUPPRESSES = Boolean(process.env['WATCHTOWER_SUPPRESS_CACHE_WRITES'])

/** A minimal `AppPaths` record: only the field this seam reads is overridden,
 *  every other field falls back to the ambient env exactly as production. */
function snapshotOf(suppressCacheWrites: boolean): AppPaths {
  return { ...appPaths(), suppressCacheWrites }
}

function emptyDb(): string {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'tr-cursor-paths-')), 'state.vscdb')
  writeFileSync(dbPath, '')
  return dbPath
}

/** A cursor-shaped `globalStorage/state.vscdb`: one assistant bubble, which is
 *  all `validateSchema` needs for the parse to reach the cache write. */
function cursorDb(): string {
  const root = mkdtempSync(join(tmpdir(), 'tr-cursor-db-'))
  const globalStorage = join(root, 'User', 'globalStorage')
  mkdirSync(globalStorage, { recursive: true })
  const dbPath = join(globalStorage, 'state.vscdb')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)')
  db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    'bubbleId:11111111-1111-1111-1111-111111111111:bubble-1',
    JSON.stringify({
      type: 2,
      createdAt: new Date().toISOString(),
      text: 'a stub assistant bubble',
      requestId: 'stub-request-1',
      tokenCount: { inputTokens: 100, outputTokens: 20 },
      modelInfo: { modelName: 'claude-sonnet-4-5' },
      codeBlocks: [],
    }),
  )
  db.close()
  return dbPath
}

async function parseAll(provider: Provider): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  for (const source of await provider.discoverSessions()) {
    for await (const call of provider.createSessionParser(source, new Set()).parse()) calls.push(call)
  }
  return calls
}

/** Did the cache write actually run? The seam's guard is the only thing between
 *  the two answers, and the write is the first observable effect past it. */
function wroteCache(): boolean {
  return fsCalls.some(call => call.startsWith('writeFile('))
}

beforeEach(() => {
  fsCalls.length = 0
})

describe('writeCachedResults (suppress-writes seam)', () => {
  it('an explicit `suppressWrites: true` returns before any fs work', async () => {
    await writeCachedResults(emptyDb(), [], FLOOR, true)
    expect(fsCalls).toEqual([])
  })

  it('an explicit `suppressWrites: false` writes the cache', async () => {
    const dbPath = emptyDb()
    await writeCachedResults(dbPath, [], FLOOR, false)
    expect(fsCalls).toContain(`stat(${dbPath})`)
    expect(wroteCache()).toBe(true)
  })

  it('with no argument it follows the current process.env value', async () => {
    await writeCachedResults(emptyDb(), [], FLOOR)
    expect(wroteCache()).toBe(!ENV_SUPPRESSES)
  })

  it('a process.env-injected suppression and a snapshot-injected one agree', async () => {
    // The uninitialized snapshot REPORTS the ambient env (byte-identical to the
    // pre-snapshot read), so the seam must reach the same decision either way.
    const snapshot = appPaths()
    expect(snapshot.suppressCacheWrites).toBe(ENV_SUPPRESSES)

    await writeCachedResults(emptyDb(), [], FLOOR)
    const fromEnv = wroteCache()

    fsCalls.length = 0
    await writeCachedResults(emptyDb(), [], FLOOR, snapshot.suppressCacheWrites)
    expect(wroteCache()).toBe(fromEnv)
  })
})

describe('createCursorProvider (suppress-writes call-site root)', () => {
  it('threads a snapshot that suppresses the cache write', async () => {
    const dbPath = cursorDb()
    const provider = createCursorProvider(dbPath, snapshotOf(true))
    await expect(parseAll(provider)).resolves.toHaveLength(1)
    expect(fsCalls.filter(call => call.startsWith('stat('))).toHaveLength(1)
    expect(wroteCache()).toBe(false)
  })

  it('threads a snapshot that lets the cache write through', async () => {
    const dbPath = cursorDb()
    const provider = createCursorProvider(dbPath, snapshotOf(false))
    await expect(parseAll(provider)).resolves.toHaveLength(1)
    expect(wroteCache()).toBe(true)
  })

  it('an unthreaded provider falls back to the ambient process.env value', async () => {
    const dbPath = cursorDb()
    await parseAll(createCursorProvider(dbPath))
    expect(wroteCache()).toBe(!ENV_SUPPRESSES)
  })
})
