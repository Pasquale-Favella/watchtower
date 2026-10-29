import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Cause, Effect, Exit, Option, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const databaseState = vi.hoisted(() => ({
  closeCount: 0,
  queryError: undefined as Error | undefined,
  queryMatch: undefined as string | undefined,
  closeError: undefined as Error | undefined,
}))

vi.mock('../src/infrastructure/ingestion/sqlite.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/infrastructure/ingestion/sqlite.js')>()
  return {
    ...actual,
    openDatabase(path: string) {
      const db = actual.openDatabase(path)
      return {
        query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
          if (databaseState.queryError && (!databaseState.queryMatch || sql.includes(databaseState.queryMatch))) {
            throw databaseState.queryError
          }
          return db.query<T>(sql, params)
        },
        close() {
          databaseState.closeCount++
          db.close()
          if (databaseState.closeError) throw databaseState.closeError
        },
      }
    },
  }
})

import { Env } from '../src/infrastructure/config/environment.js'
import type {
  Provider,
  ProviderScanContext,
  SessionParser,
  SessionSource,
} from '../src/infrastructure/provider-adapters/types.js'
import { createWarpProvider } from '../src/infrastructure/provider-adapters/warp.js'
import type { ScanPricing } from '../src/core/domain/pricing/scan-pricing.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-warp-effect-'))
  databaseState.closeCount = 0
  databaseState.queryError = undefined
  databaseState.queryMatch = undefined
  databaseState.closeError = undefined
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function createDatabase(exchanges = 2): { dbPath: string; source: SessionSource } {
  const dbPath = join(root, 'warp.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec(
    'CREATE TABLE agent_conversations (conversation_id TEXT, conversation_data TEXT, last_modified_at TEXT);' +
      'CREATE TABLE ai_queries (exchange_id TEXT, conversation_id TEXT, start_ts TEXT, input TEXT, working_directory TEXT, output_status TEXT, model_id TEXT, planning_model_id TEXT, coding_model_id TEXT);' +
      'CREATE TABLE blocks (block_id TEXT, start_ts TEXT, stylized_command BLOB, ai_metadata TEXT);',
  )
  db.prepare('INSERT INTO agent_conversations VALUES (?, ?, ?)').run(
    'conversation-one',
    JSON.stringify({
      conversation_usage_metadata: {
        token_usage: [
          {
            model_id: 'fixture-model',
            warp_tokens: 80,
            warp_token_usage_by_category: { primary_agent: 30 },
            byok_token_usage_by_category: { primary_agent: 10 },
            sibling: 'ignored',
          },
        ],
      },
      unrelated: { retained: true },
    }),
    '2026-01-01T00:00:00Z',
  )
  const insert = db.prepare('INSERT INTO ai_queries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  for (let index = 0; index < exchanges; index++) {
    insert.run(
      `exchange-${index + 1}`,
      'conversation-one',
      `2026-01-01 00:00:0${index}`,
      JSON.stringify([{ Query: { text: index === 0 ? 'short prompt' : 'a much longer prompt for weighting' } }]),
      'C:/workspace/project',
      'Completed',
      'fixture-model',
      '',
      '',
    )
  }
  db.prepare('INSERT INTO blocks VALUES (?, ?, ?, ?)').run(
    'block-one',
    '2026-01-01 00:00:00',
    Buffer.from('echo one'),
    JSON.stringify({ conversation_id: 'conversation-one' }),
  )
  db.close()
  return {
    dbPath,
    source: { path: `${dbPath}:conversation-one`, project: 'workspace', provider: 'warp' },
  }
}

function parser(
  dbPath: string,
  source: SessionSource,
  context?: ProviderScanContext,
  seen = new Set<string>(),
): SessionParser {
  return createWarpProvider(dbPath).createSessionParser(source, seen, undefined, context)
}

function parseStream(value: SessionParser): NonNullable<SessionParser['parseStream']> {
  if (!value.parseStream) throw new Error('Warp parser did not expose its native stream')
  return value.parseStream
}

function providerDiscovery(provider: Provider, context?: ProviderScanContext) {
  if (!provider.discoverSessionsEffect) throw new Error('Warp provider did not expose native discovery')
  return provider.discoverSessionsEffect(context).pipe(Effect.provide(Env.layer))
}

function pricing(calculateCost: ScanPricing['calculateCost']): ScanPricing {
  return { calculateCost, calculateLocalModelSavings: () => null }
}

describe('Warp native Effect provider', () => {
  it('discovers conversations with project paths and tolerates missing databases', async () => {
    const { dbPath } = createDatabase()
    await expect(Effect.runPromise(providerDiscovery(createWarpProvider(dbPath)))).resolves.toEqual([
      { path: `${dbPath}:conversation-one`, project: 'C:-workspace-project', provider: 'warp' },
    ])
    await expect(
      Effect.runPromise(providerDiscovery(createWarpProvider(join(root, 'missing.sqlite')))),
    ).resolves.toEqual([])
  })

  it('allocates the conversation total but prices and marks exchanges only when consumed', async () => {
    const { dbPath, source } = createDatabase(3)
    const seen = new Set<string>()
    const calculateCost = vi.fn(() => 7)
    const stream = parseStream(parser(dbPath, source, { pricing: pricing(calculateCost) }, seen))()
    const calls = await Effect.runPromise(Stream.runCollect(stream.pipe(Stream.take(1))))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.inputTokens).toBeGreaterThan(0)
    expect(calls[0]?.costUSD).toBe(7)
    expect(calculateCost).toHaveBeenCalledTimes(1)
    expect([...seen]).toEqual(['warp:conversation-one:exchange-1'])
    expect(databaseState.closeCount).toBe(1)
  })

  it('preserves tools, commands, model aliases, project attribution, and timestamps', async () => {
    const { dbPath, source } = createDatabase(1)
    const db = new DatabaseSync(dbPath)
    db.prepare('UPDATE ai_queries SET model_id = ?, working_directory = ?').run(
      'Claude Sonnet 4.6',
      '/Users/me/project',
    )
    db.close()

    const calls = await Effect.runPromise(Stream.runCollect(parseStream(parser(dbPath, source))()))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      provider: 'warp',
      model: 'claude-sonnet-4-6',
      tools: ['Bash'],
      bashCommands: ['echo'],
      timestamp: '2026-01-01T00:00:00.000Z',
      project: 'Users-me-project',
      projectPath: '/Users/me/project',
      userMessage: 'short prompt',
      sessionId: 'conversation-one',
      outputTokens: 0,
      costIsEstimated: true,
    })
  })

  it('handles malformed bytes and unused model or block timestamps without rejecting a valid call', async () => {
    const { dbPath, source } = createDatabase(1)
    const db = new DatabaseSync(dbPath)
    db.prepare('UPDATE ai_queries SET planning_model_id = ?, coding_model_id = ?').run(42, Buffer.from([0xfe]))
    db.prepare('UPDATE blocks SET start_ts = ?').run(Buffer.from([0xff]))
    db.close()

    const calls = await Effect.runPromise(Stream.runCollect(parseStream(parser(dbPath, source))()))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.model).toBe('fixture-model')
    expect(calls[0]?.tools).toEqual([])
    expect(databaseState.closeCount).toBe(1)
  })

  it('retains a seen key when pricing fails and still closes the database', async () => {
    const { dbPath, source } = createDatabase(1)
    const seen = new Set<string>()
    const pricingError = new Error('warp pricing failed')
    const calculateCost = vi.fn(() => {
      throw pricingError
    })
    const result = await Effect.runPromiseExit(
      Stream.runCollect(parseStream(parser(dbPath, source, { pricing: pricing(calculateCost) }, seen))()),
    )

    expect(Exit.isFailure(result)).toBe(true)
    expect(calculateCost).toHaveBeenCalledTimes(1)
    expect([...seen]).toEqual(['warp:conversation-one:exchange-1'])
    expect(databaseState.closeCount).toBe(1)
  })

  it('counts a malformed model only when the fallback chain consumes it', async () => {
    const { dbPath, source } = createDatabase(1)
    const db = new DatabaseSync(dbPath)
    db.prepare('UPDATE ai_queries SET model_id = NULL, planning_model_id = ?').run('fallback-model')
    db.close()
    let unparsed = 0

    const calls = await Effect.runPromise(
      Stream.runCollect(parseStream(parser(dbPath, source))(Effect.sync(() => unparsed++))),
    )

    expect(calls).toHaveLength(0)
    expect(unparsed).toBe(1)
  })

  it('reports selected exchange decode failures and continues the stream', async () => {
    const { dbPath, source } = createDatabase(2)
    const db = new DatabaseSync(dbPath)
    db.prepare('UPDATE ai_queries SET exchange_id = NULL WHERE exchange_id = ?').run('exchange-1')
    db.close()
    let unparsed = 0
    const calls = await Effect.runPromise(
      Stream.runCollect(parseStream(parser(dbPath, source))(Effect.sync(() => unparsed++))),
    )

    expect(calls).toHaveLength(1)
    expect(unparsed).toBe(1)
  })

  it('fails natively on SQLite reads and releases the database once', async () => {
    const { dbPath, source } = createDatabase()
    databaseState.queryError = new Error('warp read failed')
    databaseState.queryMatch = 'FROM ai_queries WHERE conversation_id'
    const result = await Effect.runPromiseExit(Stream.runCollect(parseStream(parser(dbPath, source))()))

    expect(Exit.isFailure(result)).toBe(true)
    expect(databaseState.closeCount).toBe(1)
    if (!Exit.isFailure(result)) throw new Error('Expected the database read to fail')
    const failure = Option.getOrThrow(Cause.findErrorOption(result.cause)) as unknown as {
      _tag: string
      operation: string
      cause: unknown
    }
    expect(failure).toMatchObject({ _tag: 'WarpDatabaseError', operation: 'read' })
    expect(failure.cause).toBe(databaseState.queryError)
  })

  it('preserves the original SQLite cause in the native stream error channel', async () => {
    const { dbPath, source } = createDatabase()
    databaseState.queryError = new Error('warp native read failed')
    databaseState.queryMatch = 'FROM ai_queries WHERE conversation_id'

    const result = await Effect.runPromiseExit(Stream.runCollect(parseStream(parser(dbPath, source))()))
    expect(Exit.isFailure(result)).toBe(true)
    expect(databaseState.closeCount).toBe(1)
    if (!Exit.isFailure(result)) throw new Error('Expected the query to fail')
    const failure = Option.getOrThrow(Cause.findErrorOption(result.cause)) as unknown as {
      _tag: string
      operation: string
      cause: unknown
    }
    expect(failure).toMatchObject({ _tag: 'WarpDatabaseError', operation: 'read' })
    expect(failure.cause).toBe(databaseState.queryError)
  })

  it('preserves the original close error identity and closes only once', async () => {
    const { dbPath, source } = createDatabase(1)
    databaseState.closeError = new Error('warp close failed')
    const result = await Effect.runPromiseExit(Stream.runCollect(parseStream(parser(dbPath, source))()))

    expect(Exit.isFailure(result)).toBe(true)
    expect(databaseState.closeCount).toBe(1)
    if (!Exit.isFailure(result)) throw new Error('Expected the database close to fail')
    const failure = Option.getOrThrow(Cause.findErrorOption(result.cause)) as unknown as {
      _tag: string
      operation: string
      cause: unknown
    }
    expect(failure).toMatchObject({ _tag: 'WarpDatabaseError', operation: 'close' })
    expect(failure.cause).toBe(databaseState.closeError)
  })

  it('stops before opening a database when the scan is aborted', async () => {
    const { dbPath, source } = createDatabase(1)
    const controller = new AbortController()
    controller.abort()
    const result = await Effect.runPromiseExit(
      Stream.runCollect(parseStream(parser(dbPath, source, { signal: controller.signal }))()),
    )

    expect(Exit.isFailure(result)).toBe(true)
    expect(databaseState.closeCount).toBe(0)
  })
})
