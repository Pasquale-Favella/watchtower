import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { Effect, FileSystem, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type AppPaths, appPaths } from '../src/infrastructure/config/environment.js'
import { writeCachedResultsEffect } from '../src/infrastructure/ingestion/cursor-cache.js'
import { createCursorProvider } from '../src/infrastructure/provider-adapters/cursor.js'
import type { ParsedProviderCall, Provider } from '../src/infrastructure/provider-adapters/types.js'
import { discoverProviderSessions } from './fixtures/provider-effects.js'

const state = vi.hoisted(() => ({ fsCalls: [] as string[], home: '' }))
const { fsCalls } = state
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => state.home }
})

const FLOOR = '2024-01-01T00:00:00.000Z'
const ENV_SUPPRESSES = Boolean(process.env['WATCHTOWER_SUPPRESS_CACHE_WRITES'])
let root = ''

function snapshotOf(suppressCacheWrites: boolean): AppPaths {
  return { ...appPaths(), suppressCacheWrites }
}

function observedFileSystem(fs: FileSystem.FileSystem): FileSystem.FileSystem {
  return {
    ...fs,
    makeDirectory: (path, options) => {
      fsCalls.push(`mkdir(${path})`)
      return fs.makeDirectory(path, options)
    },
    open: (path, options) => {
      fsCalls.push(`open(${path})`)
      return fs.open(path, options)
    },
    readFileString: path => {
      fsCalls.push(`readFile(${path})`)
      return Effect.fail(new Error('cache miss') as never)
    },
    rename: (from, to) => {
      fsCalls.push(`rename(${from})`)
      return fs.rename(from, to)
    },
    remove: (path, options) => {
      fsCalls.push(`remove(${path})`)
      return fs.remove(path, options)
    },
  }
}

function runWithFileSystem<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return yield* Effect.provideService(effect, FileSystem.FileSystem, observedFileSystem(fs))
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  )
}

function emptyDb(): string {
  const dbPath = join(root, `empty-${Math.random()}.vscdb`)
  writeFileSync(dbPath, '')
  return dbPath
}

function cursorDb(): string {
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

async function parseAll(provider: Provider<FileSystem.FileSystem>): Promise<ParsedProviderCall[]> {
  const fs = observedFileSystem(
    await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer))),
  )
  const calls: ParsedProviderCall[] = []
  for (const source of await discoverProviderSessions(provider)) {
    const stream = provider.createSessionParser(source, new Set()).parseStream()
    if (!stream) continue
    for await (const call of Stream.toAsyncIterable(stream.pipe(Stream.provideService(FileSystem.FileSystem, fs))))
      calls.push(call)
  }
  return calls
}

function wroteCache(): boolean {
  return fsCalls.some(call => call.startsWith('open('))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tr-cursor-paths-'))
  state.home = root
  fsCalls.length = 0
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('Cursor cache suppress-writes seam', () => {
  it('returns before filesystem access when writes are explicitly suppressed', async () => {
    await runWithFileSystem(Effect.scoped(writeCachedResultsEffect(emptyDb(), [], FLOOR, true)))
    expect(fsCalls).toEqual([])
  })

  it('writes the cache when writes are explicitly enabled', async () => {
    await runWithFileSystem(Effect.scoped(writeCachedResultsEffect(emptyDb(), [], FLOOR, false)))
    expect(wroteCache()).toBe(true)
  })

  it('uses the current process environment when no override is supplied', async () => {
    await runWithFileSystem(Effect.scoped(writeCachedResultsEffect(emptyDb(), [], FLOOR)))
    expect(wroteCache()).toBe(!ENV_SUPPRESSES)
  })

  it('uses the same suppression value from an AppPaths snapshot', async () => {
    const snapshot = appPaths()
    expect(snapshot.suppressCacheWrites).toBe(ENV_SUPPRESSES)
    await runWithFileSystem(Effect.scoped(writeCachedResultsEffect(emptyDb(), [], FLOOR)))
    const fromEnv = wroteCache()
    fsCalls.length = 0
    await runWithFileSystem(Effect.scoped(writeCachedResultsEffect(emptyDb(), [], FLOOR, snapshot.suppressCacheWrites)))
    expect(wroteCache()).toBe(fromEnv)
  })

  it('threads a snapshot that suppresses the provider cache write', async () => {
    const dbPath = cursorDb()
    await expect(parseAll(createCursorProvider(dbPath, snapshotOf(true)))).resolves.toHaveLength(1)
    expect(wroteCache()).toBe(false)
  })

  it('threads a snapshot that lets the provider cache write through', async () => {
    const dbPath = cursorDb()
    await expect(parseAll(createCursorProvider(dbPath, snapshotOf(false)))).resolves.toHaveLength(1)
    expect(wroteCache()).toBe(true)
  })

  it('an unthreaded provider follows the ambient environment value', async () => {
    const dbPath = cursorDb()
    await parseAll(createCursorProvider(dbPath))
    expect(wroteCache()).toBe(!ENV_SUPPRESSES)
  })
})
