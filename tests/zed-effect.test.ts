import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

import { Cause, Effect, Exit, Option, Result, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const logState = vi.hoisted(() => ({ entries: [] as unknown[], issues: [] as unknown[] }))
const databaseState = vi.hoisted(() => ({ closeError: undefined as Error | undefined, closeCount: 0 }))

vi.mock('../src/main/pipeline/file-errors.js', () => ({
  fileErrorCode: (_cause: unknown, fallback: string) => fallback,
  queueLogRecord: (entry: unknown) => logState.entries.push(entry),
  reportProviderIssue: (...issue: unknown[]) => logState.issues.push(issue),
}))

vi.mock('../src/main/pipeline/sqlite.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/pipeline/sqlite.js')>()
  return {
    ...actual,
    openDatabase(path: string) {
      const database = actual.openDatabase(path)
      return {
        query: database.query,
        close() {
          database.close()
          databaseState.closeCount++
          if (databaseState.closeError) throw databaseState.closeError
        },
      }
    },
  }
})

import { Env } from '../src/main/env.js'
import type { Provider, SessionParser, SessionSource } from '../src/main/pipeline/providers/types.js'
import { createZedProvider } from '../src/main/pipeline/providers/zed.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-zed-effect-'))
  logState.entries.length = 0
  logState.issues.length = 0
  databaseState.closeError = undefined
  databaseState.closeCount = 0
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function nativeStream(parser: SessionParser): NonNullable<SessionParser['parseStream']> {
  if (!parser.parseStream) throw new Error('Zed parser did not expose its native stream')
  return parser.parseStream
}

function source(path: string): SessionSource {
  return { path, project: 'zed', provider: 'zed' }
}

function createDatabase(): { dbPath: string; db: DatabaseSync } {
  const dbPath = join(root, 'threads.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE threads (id TEXT, summary TEXT, updated_at TEXT, data_type TEXT, data BLOB)')
  return { dbPath, db }
}

function insertThread(
  db: DatabaseSync,
  row: {
    id: SQLInputValue
    summary?: SQLInputValue
    updatedAt?: SQLInputValue
    dataType: SQLInputValue
    data: SQLInputValue
  },
): void {
  db.prepare('INSERT INTO threads (id, summary, updated_at, data_type, data) VALUES (?, ?, ?, ?, ?)').run(
    row.id,
    row.summary ?? null,
    row.updatedAt ?? null,
    row.dataType,
    row.data,
  )
}

function pricing(calculateCost: ScanPricing['calculateCost']): ScanPricing {
  return { calculateCost, calculateLocalModelSavings: () => null }
}

function discovery(provider: Provider, signal?: AbortSignal) {
  if (!provider.discoverSessionsEffect) throw new Error('Zed provider did not expose native discovery')
  return provider.discoverSessionsEffect(signal ? { signal } : undefined).pipe(Effect.provide(Env.layer))
}

describe('Zed native Effect provider', () => {
  it('discovers one existing database and returns empty for a missing override', async () => {
    const { dbPath, db } = createDatabase()
    db.close()

    await expect(Effect.runPromise(discovery(createZedProvider(dbPath)))).resolves.toEqual([
      { path: dbPath, project: 'zed', provider: 'zed' },
    ])
    await expect(Effect.runPromise(discovery(createZedProvider(join(root, 'missing.db'))))).resolves.toEqual([])
  })

  it('prices and admits only entries consumed before an early stream stop', async () => {
    const { dbPath, db } = createDatabase()
    insertThread(db, {
      id: 'thread-one',
      summary: 'prompt',
      updatedAt: '2026-01-01T00:00:00.000Z',
      dataType: 'json',
      data: Buffer.from(
        JSON.stringify({
          model: { model: 'fixture-model' },
          request_token_usage: {
            first: { input_tokens: 2, output_tokens: 3 },
            second: { cache_creation_input_tokens: 4 },
            later: { input_tokens: 99 },
          },
          cumulative_token_usage: {
            input_tokens: 5,
            output_tokens: 3,
            cache_creation_input_tokens: 4,
            cache_read_input_tokens: 7,
          },
          unrelated_sibling: { tolerated: true },
        }),
      ),
    })
    db.close()

    const seen = new Set([`zed:thread-one:first`])
    const priced: Array<[string, number, number, number, number]> = []
    const calculateCost = vi.fn((model: string, input: number, output: number, write: number, read: number) => {
      priced.push([model, input, output, write, read])
      if (input === 99) throw new Error('later request must remain unpriced')
      return 1
    })
    const parser = createZedProvider(dbPath).createSessionParser(source(dbPath), seen, undefined, {
      pricing: pricing(calculateCost),
    })

    const first = await Effect.runPromise(Stream.runHead(nativeStream(parser)()))
    expect(Option.getOrThrow(first)).toMatchObject({ deduplicationKey: 'zed:thread-one:second' })
    expect(priced).toEqual([
      ['fixture-model', 2, 3, 0, 0],
      ['fixture-model', 0, 0, 4, 0],
    ])
    expect(calculateCost).toHaveBeenCalledTimes(2)
    expect(seen).toEqual(new Set(['zed:thread-one:first', 'zed:thread-one:second']))
  })

  it('collects request entries and the cumulative remainder in order', async () => {
    const { dbPath, db } = createDatabase()
    insertThread(db, {
      id: 'thread-one',
      summary: 'prompt',
      updatedAt: '2026-01-01T00:00:00.000Z',
      dataType: 'json',
      data: Buffer.from(
        JSON.stringify({
          model: { model: 'fixture-model' },
          request_token_usage: {
            first: { input_tokens: 2, output_tokens: 3 },
            second: { cache_creation_input_tokens: 4 },
          },
          cumulative_token_usage: {
            input_tokens: 5,
            output_tokens: 3,
            cache_creation_input_tokens: 4,
            cache_read_input_tokens: 7,
          },
        }),
      ),
    })
    db.close()

    const priced: Array<[string, number, number, number, number]> = []
    const calculateCost = vi.fn((model: string, input: number, output: number, write: number, read: number) => {
      priced.push([model, input, output, write, read])
      return 1
    })
    const parser = createZedProvider(dbPath).createSessionParser(source(dbPath), new Set(), undefined, {
      pricing: pricing(calculateCost),
    })
    const calls = await Effect.runPromise(Stream.runCollect(nativeStream(parser)()))

    expect([...calls].map(call => call.deduplicationKey)).toEqual([
      'zed:thread-one:first',
      'zed:thread-one:second',
      'zed:thread-one:cumulative-remainder',
    ])
    expect([...calls]).toMatchObject([
      { inputTokens: 2, outputTokens: 3, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 4, cacheReadInputTokens: 0 },
      { inputTokens: 3, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 7 },
    ])
    expect(priced).toEqual([
      ['fixture-model', 2, 3, 0, 0],
      ['fixture-model', 0, 0, 4, 0],
      ['fixture-model', 3, 0, 0, 7],
    ])
    expect(calculateCost).toHaveBeenCalledTimes(3)
    expect(logState.entries).toHaveLength(0)
  })

  it('preserves array request keys and remainder order', async () => {
    const { dbPath, db } = createDatabase()
    insertThread(db, {
      id: 'array-thread',
      summary: 'prompt',
      updatedAt: '2026-01-01T00:00:00.000Z',
      dataType: 'json',
      data: Buffer.from(
        JSON.stringify({
          model: { model: 'fixture-model' },
          request_token_usage: [{ input_tokens: 2 }, { output_tokens: 3 }],
          cumulative_token_usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 4 },
        }),
      ),
    })
    db.close()

    const parser = createZedProvider(dbPath).createSessionParser(source(dbPath), new Set(), undefined, {
      pricing: pricing(() => 0),
    })
    const calls = await Effect.runPromise(Stream.runCollect(nativeStream(parser)()))

    expect([...calls].map(call => call.deduplicationKey)).toEqual([
      'zed:array-thread:0',
      'zed:array-thread:1',
      'zed:array-thread:cumulative-remainder',
    ])
    expect([...calls]).toMatchObject([
      { inputTokens: 2, outputTokens: 0 },
      { inputTokens: 0, outputTokens: 3 },
      { inputTokens: 3, outputTokens: 0, cacheCreationInputTokens: 4 },
    ])
  })

  it('stops pricing a thread after a pricing error and continues with later threads', async () => {
    const { dbPath, db } = createDatabase()
    const threadData = (requestTokenUsage: Record<string, unknown>) =>
      Buffer.from(JSON.stringify({ model: { model: 'fixture-model' }, request_token_usage: requestTokenUsage }))
    insertThread(db, {
      id: 'thread-one',
      summary: 'prompt',
      updatedAt: '2026-01-01T00:00:00.000Z',
      dataType: 'json',
      data: threadData({ first: { input_tokens: 1 }, second: { input_tokens: 2 } }),
    })
    insertThread(db, {
      id: 'thread-two',
      summary: 'later',
      updatedAt: '2026-01-02T00:00:00.000Z',
      dataType: 'json',
      data: threadData({ third: { input_tokens: 3 } }),
    })
    db.close()

    const priced: number[] = []
    const parser = createZedProvider(dbPath).createSessionParser(source(dbPath), new Set(), undefined, {
      pricing: pricing((_model, input) => {
        priced.push(input)
        if (input === 1) throw new Error('price failed')
        return 0
      }),
    })
    const calls = await Effect.runPromise(Stream.runCollect(nativeStream(parser)()))

    expect([...calls].map(call => call.deduplicationKey)).toEqual(['zed:thread-two:third'])
    expect(priced).toEqual([1, 3])
    expect(logState.entries).toHaveLength(1)
    expect(logState.entries[0]).toMatchObject({ fields: { provider: 'zed', code: 'entries-unreadable', count: 1 } })
  })

  it('surfaces EOF close failures as typed errors with the original cause', async () => {
    const { dbPath, db } = createDatabase()
    insertThread(db, {
      id: 'thread-one',
      summary: 'prompt',
      updatedAt: '2026-01-01T00:00:00.000Z',
      dataType: 'json',
      data: Buffer.from(
        JSON.stringify({ model: { model: 'fixture-model' }, request_token_usage: { first: { input_tokens: 1 } } }),
      ),
    })
    db.close()
    const closeError = new Error('close failed')
    databaseState.closeError = closeError
    const parser = createZedProvider(dbPath).createSessionParser(source(dbPath), new Set(), undefined, {
      pricing: pricing(() => 0),
    })

    const exit = await Effect.runPromiseExit(Stream.runCollect(nativeStream(parser)()))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(databaseState.closeCount).toBe(1)
    if (Exit.isFailure(exit)) {
      const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause)) as { cause?: unknown } | undefined
      expect(failure?.cause).toBe(closeError)
    }
  })

  it('unwraps an early scope close failure to the original native error', async () => {
    const { dbPath, db } = createDatabase()
    insertThread(db, {
      id: 'thread-one',
      summary: 'prompt',
      updatedAt: '2026-01-01T00:00:00.000Z',
      dataType: 'json',
      data: Buffer.from(
        JSON.stringify({ model: { model: 'fixture-model' }, request_token_usage: { first: { input_tokens: 1 } } }),
      ),
    })
    db.close()
    const closeError = new Error('close failed')
    databaseState.closeError = closeError
    const parser = createZedProvider(dbPath).createSessionParser(source(dbPath), new Set(), undefined, {
      pricing: pricing(() => 0),
    })

    const iterator = parser.parse()
    await expect(iterator.next()).resolves.toMatchObject({ done: false })
    await expect(iterator.return(undefined)).rejects.toBe(closeError)
    expect(databaseState.closeCount).toBe(1)
  })

  it('preserves unexpected transformation defects and still closes the database', async () => {
    const { dbPath, db } = createDatabase()
    insertThread(db, {
      id: 'thread-one',
      summary: 'prompt',
      updatedAt: '2026-01-01T00:00:00.000Z',
      dataType: 'json',
      data: Buffer.from(
        JSON.stringify({ model: { model: 'fixture-model' }, request_token_usage: { first: { input_tokens: 1 } } }),
      ),
    })
    db.close()
    const defect = new Error('unexpected timestamp transformation defect')
    const toISOString = vi.spyOn(Date.prototype, 'toISOString').mockImplementation(() => {
      throw defect
    })
    const parser = createZedProvider(dbPath).createSessionParser(source(dbPath), new Set(), undefined, {
      pricing: pricing(() => 0),
    })

    const exit = await Effect.runPromiseExit(Stream.runCollect(nativeStream(parser)())).finally(() => {
      toISOString.mockRestore()
    })
    expect(Exit.isFailure(exit)).toBe(true)
    expect(databaseState.closeCount).toBe(1)
    if (Exit.isFailure(exit)) {
      const failure = Cause.findDefect(exit.cause)
      expect(Result.isSuccess(failure) ? failure.success : undefined).toBe(defect)
    }
  })

  it('normalizes malformed siblings and counts unreadable rows once while skipping invalid timestamps silently', async () => {
    const { dbPath, db } = createDatabase()
    insertThread(db, {
      id: 'future-type',
      dataType: 'future',
      updatedAt: '2026-01-01T00:00:00Z',
      data: Buffer.from('{}'),
    })
    insertThread(db, {
      id: 'invalid-date',
      dataType: 'json',
      updatedAt: 'not a date',
      data: Buffer.from('{broken'),
    })
    insertThread(db, {
      id: 'malformed-json',
      summary: 'fallback prompt',
      dataType: 'json',
      updatedAt: '2026-01-01T00:00:00Z',
      data: Buffer.from('{broken'),
    })
    insertThread(db, {
      id: 'corrupt-zstd',
      dataType: 'zstd',
      updatedAt: '2026-01-01T12:00:00Z',
      data: Buffer.from('not-zstd'),
    })
    insertThread(db, {
      id: 'valid',
      summary: 'kept prompt',
      dataType: 'json',
      updatedAt: '2026-01-02T00:00:00Z',
      data: Buffer.from(
        JSON.stringify({
          model: { model: 'valid-model', ignored: Symbol.for('non-json sibling') },
          request_token_usage: {
            zero: { input_tokens: -4, output_tokens: 0 },
            billable: { input_tokens: 5, output_tokens: 3, extra: { tolerated: true } },
          },
        }),
      ),
    })
    db.close()

    const parser = createZedProvider(dbPath).createSessionParser(source(dbPath), new Set(), undefined, {
      pricing: pricing(() => 0),
    })
    const calls = await Effect.runPromise(Stream.runCollect(nativeStream(parser)()))
    expect([...calls]).toMatchObject([
      { model: 'valid-model', inputTokens: 5, outputTokens: 3, userMessage: 'kept prompt' },
    ])
    expect(logState.entries).toHaveLength(1)
    expect(logState.entries[0]).toMatchObject({ fields: { provider: 'zed', code: 'entries-unreadable', count: 3 } })
  })

  it('omits invalid selected models and summaries through the canonical rejection tally', async () => {
    const { dbPath, db } = createDatabase()
    insertThread(db, {
      id: 'invalid-model',
      summary: 'prompt',
      dataType: 'json',
      updatedAt: '2026-01-01T00:00:00Z',
      data: Buffer.from(
        JSON.stringify({
          model: { model: { malformed: true } },
          request_token_usage: { request: { input_tokens: 4 } },
        }),
      ),
    })
    insertThread(db, {
      id: 'invalid-summary',
      summary: Buffer.from('42'),
      dataType: 'json',
      updatedAt: '2026-01-02T00:00:00Z',
      data: Buffer.from(
        JSON.stringify({
          model: { model: 'valid-model' },
          request_token_usage: { request: { output_tokens: 2 } },
        }),
      ),
    })
    db.close()

    const seen = new Set<string>()
    const calculateCost = vi.fn(() => 0)
    let rejected = 0
    const parser = createZedProvider(dbPath).createSessionParser(source(dbPath), seen, undefined, {
      pricing: pricing(calculateCost),
    })
    const calls = await Effect.runPromise(Stream.runCollect(nativeStream(parser)(Effect.sync(() => (rejected += 1)))))

    expect([...calls]).toEqual([])
    expect(rejected).toBe(2)
    expect(calculateCost).not.toHaveBeenCalled()
    expect(seen).toEqual(new Set(['zed:invalid-model:request', 'zed:invalid-summary:request']))
  })
})
