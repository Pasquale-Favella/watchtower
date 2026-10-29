import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { it as effectIt } from '@effect/vitest'
import { Cause, Effect, Exit, Option, Stream } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sqliteState = vi.hoisted(() => ({
  closeCount: 0,
  openError: undefined as Error | undefined,
  readError: undefined as Error | undefined,
  closeError: undefined as Error | undefined,
  abortAfterSessionRead: undefined as AbortController | undefined,
}))

vi.mock('../src/infrastructure/ingestion/sqlite.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/infrastructure/ingestion/sqlite.js')>()
  return {
    ...actual,
    isSqliteAvailable: () => true,
    openDatabase(path: string) {
      if (sqliteState.openError) throw sqliteState.openError
      const db = actual.openDatabase(path)
      return {
        query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
          if (sqliteState.readError && (sql.includes('WHERE id = ?') || sql.includes('ORDER BY updated_at DESC')))
            throw sqliteState.readError
          const rows = db.query<T>(sql, params)
          if (sql.includes('WHERE id = ?')) sqliteState.abortAfterSessionRead?.abort()
          return rows
        },
        close() {
          sqliteState.closeCount++
          db.close()
          if (sqliteState.closeError) throw sqliteState.closeError
        },
      }
    },
  }
})

import { type AppPaths, Env } from '../src/infrastructure/config/environment.js'
import { createGooseProvider, getGooseDbPath } from '../src/infrastructure/provider-adapters/goose.js'
import type { ParsedProviderCall, SessionParser } from '../src/infrastructure/provider-adapters/types.js'
import { ScanAbortedError } from '../src/core/ingestion/reconciliation/scan-control.js'
import type { ScanPricing } from '../src/core/domain/pricing/scan-pricing.js'

let root = ''
let databasePath = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-goose-effect-'))
  databasePath = join(root, 'data', 'sessions', 'sessions.db')
  sqliteState.closeCount = 0
  sqliteState.openError = undefined
  sqliteState.readError = undefined
  sqliteState.closeError = undefined
  sqliteState.abortAfterSessionRead = undefined
  mkdirSync(join(root, 'data', 'sessions'), { recursive: true })
  const db = new DatabaseSync(databasePath)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT, name, working_dir, created_at, updated_at,
      accumulated_input_tokens, accumulated_output_tokens, provider_name, model_config_json
    );
    CREATE TABLE messages (session_id TEXT, role TEXT, content_json BLOB, created_timestamp INTEGER);
    INSERT INTO sessions VALUES (
      'goose-session', 'name', '/work/project', '2026-01-02T03:04:05Z',
      '2026-01-02T04:05:06Z', 100, 25, 'provider',
      '{"model_name":"fixture-model","reasoning":true,"sibling":"ignored"}'
    );
    INSERT INTO messages VALUES (
      'goose-session', 'user', '[{"type":"text","text":"question","sibling":true}]', 1
    );
    INSERT INTO messages VALUES (
      'goose-session', 'assistant',
      '[{"type":"toolRequest","toolCall":{"value":{"name":"developer__shell","arguments":{"command":"echo hello","file_path":"/tmp/a","sibling":1}}},"sibling":true}]',
      2
    );
  `)
  db.close()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function paths(overrides: AppPaths['overrides'] = { GOOSE_PATH_ROOT: root }): AppPaths {
  return {
    cacheDir: root,
    codexHome: root,
    suppressCacheWrites: false,
    platform: { appData: null, localAppData: null, xdgConfigHome: null, xdgDataHome: null },
    overrides,
  }
}

function parser(context?: Parameters<ReturnType<typeof createGooseProvider>['createSessionParser']>[3]): SessionParser {
  return createGooseProvider(paths()).createSessionParser(
    { path: `${databasePath}:goose-session`, project: 'fixture', provider: 'goose' },
    new Set(),
    undefined,
    context,
  )
}

function nativeStream(value: SessionParser): NonNullable<SessionParser['parseStream']> {
  if (!value.parseStream) throw new Error('Goose parser has no native Stream')
  return value.parseStream
}

function nativeDiscovery(provider: ReturnType<typeof createGooseProvider>) {
  const discover = provider.discoverSessionsEffect
  if (!discover) throw new Error('Goose native discovery is unavailable')
  return discover().pipe(Effect.provide(Env.layer))
}

function pricing(calculateCost: ScanPricing['calculateCost']): ScanPricing {
  return { calculateCost, calculateLocalModelSavings: () => null }
}

async function collect(value: SessionParser): Promise<ParsedProviderCall[]> {
  return [...(await Effect.runPromise(Stream.runCollect(nativeStream(value)())))]
}

describe('Goose native Effect provider', () => {
  it('keeps optional message queries best effort when their columns are absent', async () => {
    const db = new DatabaseSync(databasePath)
    db.exec('DROP TABLE messages; CREATE TABLE messages (unrelated TEXT)')
    db.close()
    const calls = await collect(parser({ pricing: pricing(() => 1) }))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ inputTokens: 100, userMessage: '', tools: [], bashCommands: [] })
    expect(sqliteState.closeCount).toBe(1)
  })

  it('keeps a missing required messages table empty and closes the source', async () => {
    const db = new DatabaseSync(databasePath)
    db.exec('DROP TABLE messages')
    db.close()
    expect(await collect(parser())).toEqual([])
    expect(sqliteState.closeCount).toBe(1)
  })

  it('resolves the registered root override and discovers billable sessions', async () => {
    expect(getGooseDbPath(paths())).toBe(databasePath)
    const provider = createGooseProvider(paths())

    await expect(Effect.runPromise(nativeDiscovery(provider))).resolves.toEqual([
      { path: `${databasePath}:goose-session`, project: 'work-project', provider: 'goose' },
    ])
    expect(sqliteState.closeCount).toBe(1)
  })

  it('keeps discovery read errors empty and reports close errors as typed failures', async () => {
    const provider = createGooseProvider(paths())
    sqliteState.readError = new Error('session query failed')
    await expect(Effect.runPromise(nativeDiscovery(provider))).resolves.toEqual([])
    expect(sqliteState.closeCount).toBe(1)

    sqliteState.readError = undefined
    sqliteState.closeError = new Error('close failed')
    const result = await Effect.runPromiseExit(nativeDiscovery(provider))
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const error = Option.getOrThrow(Cause.findErrorOption(result.cause))
      expect(error).toMatchObject({ _tag: 'GooseDatabaseError', operation: 'close', cause: sqliteState.closeError })
    }
    expect(sqliteState.closeCount).toBe(2)
  })

  it('parses selected fields, preserves tool order and sibling data, and captures pricing', async () => {
    const calculations: unknown[][] = []
    const selected = parser({
      pricing: pricing((...args) => {
        expect(sqliteState.closeCount).toBe(1)
        calculations.push(args)
        return 12.5
      }),
    })
    const calls = await collect(selected)

    expect(calls).toEqual([
      expect.objectContaining({
        provider: 'goose',
        model: 'fixture-model',
        inputTokens: 100,
        outputTokens: 25,
        costUSD: 12.5,
        tools: ['Bash'],
        bashCommands: ['echo'],
        userMessage: 'question',
        sessionId: 'goose-session',
        timestamp: '2026-01-02T04:05:06.000Z',
      }),
    ])
    expect(calls[0]?.toolSequence).toBeUndefined()
    expect(calculations).toEqual([['fixture-model', 100, 25, 0, 0, 0]])
    expect(sqliteState.closeCount).toBe(1)
  })

  it('prices and admits only the call consumed before an early stop', async () => {
    const seen = new Set<string>()
    const pricingCalls: number[] = []
    const selected = createGooseProvider(paths()).createSessionParser(
      { path: `${databasePath}:goose-session`, project: 'fixture', provider: 'goose' },
      seen,
      undefined,
      {
        pricing: pricing((_, input) => {
          pricingCalls.push(input)
          return input
        }),
      },
    )
    const first = await Effect.runPromise(Stream.runHead(nativeStream(selected)()))

    expect(Option.isSome(first)).toBe(true)
    expect(seen).toEqual(new Set(['goose:goose-session']))
    expect(pricingCalls).toEqual([100])
    expect(sqliteState.closeCount).toBe(1)
  })

  it('skips and tallies rows whose consumed token fields fail Schema decoding', async () => {
    const db = new DatabaseSync(databasePath)
    db.prepare("UPDATE sessions SET accumulated_input_tokens = 'bad'").run()
    db.close()
    let unparsed = 0

    const seen = new Set<string>()
    const pricingCalls: number[] = []
    const selected = createGooseProvider(paths()).createSessionParser(
      { path: `${databasePath}:goose-session`, project: 'fixture', provider: 'goose' },
      seen,
      undefined,
      {
        pricing: pricing((_, input) => {
          pricingCalls.push(input)
          return input
        }),
      },
    )
    const calls = await Effect.runPromise(
      Stream.runCollect(
        nativeStream(selected)(
          Effect.sync(() => {
            unparsed++
          }),
        ),
      ),
    )
    expect(calls).toEqual([])
    expect(unparsed).toBe(1)
    expect(seen).toEqual(new Set(['goose:goose-session']))
    expect(pricingCalls).toEqual([])
    expect(sqliteState.closeCount).toBe(1)
  })

  it('preserves useful session data when unrelated discovery columns contain bad values', async () => {
    const db = new DatabaseSync(databasePath)
    db.prepare('UPDATE sessions SET name = ?, provider_name = ?, model_config_json = ?').run(
      Buffer.from([0xff]),
      42,
      '{"model_name":"fixture-model","reasoning":42,"sibling":[false]}',
    )
    db.close()
    const provider = createGooseProvider(paths())

    await expect(Effect.runPromise(nativeDiscovery(provider))).resolves.toHaveLength(1)
    await expect(collect(parser())).resolves.toHaveLength(1)
    expect(sqliteState.closeCount).toBe(2)
  })

  it('omits an invalid consumed model after admission without pricing it', async () => {
    const db = new DatabaseSync(databasePath)
    db.prepare('UPDATE sessions SET model_config_json = ?').run('{"model_name":42,"sibling":true}')
    db.close()
    let unparsed = 0
    const seen = new Set<string>()
    let priced = false
    const selected = createGooseProvider(paths()).createSessionParser(
      { path: `${databasePath}:goose-session`, project: 'fixture', provider: 'goose' },
      seen,
      undefined,
      {
        pricing: pricing(model => {
          priced = true
          return model.length
        }),
      },
    )

    const calls = await Effect.runPromise(
      Stream.runCollect(
        nativeStream(selected)(
          Effect.sync(() => {
            unparsed++
          }),
        ),
      ),
    )
    expect(calls).toEqual([])
    expect(unparsed).toBe(1)
    expect(seen).toEqual(new Set(['goose:goose-session']))
    expect(priced).toBe(false)
    expect(sqliteState.closeCount).toBe(1)
  })

  it('keeps usage with the unknown model fallback for empty and malformed config JSON', async () => {
    let unparsed = 0

    for (const config of ['', '{malformed', '[]']) {
      const db = new DatabaseSync(databasePath)
      db.prepare('UPDATE sessions SET model_config_json = ?').run(config)
      db.close()

      const seen = new Set<string>()
      const selected = createGooseProvider(paths()).createSessionParser(
        { path: `${databasePath}:goose-session`, project: 'fixture', provider: 'goose' },
        seen,
        undefined,
        {
          pricing: pricing(model => {
            expect(model).toBe('unknown')
            return 3
          }),
        },
      )
      const calls = await Effect.runPromise(
        Stream.runCollect(
          nativeStream(selected)(
            Effect.sync(() => {
              unparsed++
            }),
          ),
        ),
      )

      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ model: 'unknown', inputTokens: 100, outputTokens: 25, costUSD: 3 })
      expect(seen).toEqual(new Set(['goose:goose-session']))
    }

    expect(unparsed).toBe(0)
    expect(sqliteState.closeCount).toBe(3)
  })

  it('uses unknown for null or absent model names without counting drift', async () => {
    const db = new DatabaseSync(databasePath)
    db.prepare('UPDATE sessions SET model_config_json = ?').run('{"model_name":null,"sibling":true}')
    db.close()

    let unparsed = 0
    const nullModelCalls = await Effect.runPromise(
      Stream.runCollect(
        nativeStream(parser({ pricing: pricing(() => 1) }))(
          Effect.sync(() => {
            unparsed++
          }),
        ),
      ),
    )
    expect(nullModelCalls).toHaveLength(1)
    expect(nullModelCalls[0]?.model).toBe('unknown')
    expect(unparsed).toBe(0)

    const missingFieldDb = new DatabaseSync(databasePath)
    missingFieldDb.prepare('UPDATE sessions SET model_config_json = ?').run('{"sibling":true}')
    missingFieldDb.close()
    const missingModelCalls = await collect(parser({ pricing: pricing(() => 1) }))
    expect(missingModelCalls).toHaveLength(1)
    expect(missingModelCalls[0]?.model).toBe('unknown')
    expect(unparsed).toBe(0)
    expect(sqliteState.closeCount).toBe(2)
  })

  it('keeps Date fallback behavior when stored timestamp metadata is not a string', async () => {
    const db = new DatabaseSync(databasePath)
    db.prepare('UPDATE sessions SET created_at = ?, updated_at = NULL').run(42)
    db.close()

    const calls = await collect(parser({ pricing: pricing(() => 1) }))
    expect(calls[0]?.timestamp).toBe(new Date(42).toISOString())
    expect(sqliteState.closeCount).toBe(1)
  })

  effectIt.effect('uses the Effect Clock when malformed session timestamps fall back to now', () =>
    Effect.gen(function* () {
      const db = new DatabaseSync(databasePath)
      db.prepare('UPDATE sessions SET created_at = ?, updated_at = NULL').run('not-a-timestamp')
      db.close()
      const selected = parser({ pricing: pricing(() => 1) })
      const nowMs = Date.parse('2026-10-15T12:30:00.000Z')

      yield* TestClock.setTime(nowMs)
      const calls = yield* Stream.runCollect(nativeStream(selected)())

      expect(calls[0]?.timestamp).toBe(new Date(nowMs).toISOString())
      expect(sqliteState.closeCount).toBe(1)
    }),
  )

  it('closes an acquired connection when cancellation arrives after the row query', async () => {
    const controller = new AbortController()
    sqliteState.abortAfterSessionRead = controller
    const selected = parser({ signal: controller.signal })
    const result = await Effect.runPromiseExit(Stream.runCollect(nativeStream(selected)()))

    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const error = Option.getOrThrow(Cause.findErrorOption(result.cause))
      expect(error).toBeInstanceOf(ScanAbortedError)
    }
    expect(sqliteState.closeCount).toBe(1)
  })

  it('keeps native SQLite failures in the stream error channel and closes once', async () => {
    const queryError = new Error('session query failed')
    sqliteState.readError = queryError
    await expect(Effect.runPromise(Stream.runCollect(nativeStream(parser())()))).rejects.toMatchObject({
      _tag: 'GooseDatabaseError',
      operation: 'read',
      cause: queryError,
    })
    expect(sqliteState.closeCount).toBe(1)
  })

  it('keeps close failures in the native stream error channel and closes once', async () => {
    const closeError = new Error('close failed')
    sqliteState.closeError = closeError
    const selected = parser()
    const result = await Effect.runPromiseExit(Stream.runCollect(nativeStream(selected)()))
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const error = Option.getOrThrow(Cause.findErrorOption(result.cause))
      expect(error).toMatchObject({ _tag: 'GooseDatabaseError', operation: 'close', cause: closeError })
    }

    expect(sqliteState.closeCount).toBe(1)
  })
})
