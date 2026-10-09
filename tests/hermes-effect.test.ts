import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SQLInputValue } from 'node:sqlite'
import { DatabaseSync } from 'node:sqlite'

import { Cause, Effect, Exit, Option, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  closed: 0,
  openError: undefined as Error | undefined,
  queryError: undefined as { includes: string; error: Error } | undefined,
  closeError: undefined as Error | undefined,
  sqliteAvailable: true,
}))

vi.mock('../src/main/pipeline/sqlite.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/pipeline/sqlite.js')>()
  return {
    ...actual,
    isSqliteAvailable: () => hooks.sqliteAvailable,
    openDatabase(path: string) {
      if (hooks.openError) throw hooks.openError
      const db = actual.openDatabase(path)
      return {
        query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
          if (hooks.queryError && sql.includes(hooks.queryError.includes)) throw hooks.queryError.error
          return db.query<T>(sql, params)
        },
        close() {
          hooks.closed++
          db.close()
          if (hooks.closeError) throw hooks.closeError
        },
      }
    },
  }
})

import { Env } from '../src/main/env.js'
import { takeQueuedLogRecords } from '../src/main/pipeline/file-errors.js'
import { createHermesProvider } from '../src/main/pipeline/providers/hermes.js'
import type {
  ParsedProviderCall,
  Provider,
  SessionParser,
  SessionSource,
} from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-hermes-effect-'))
  hooks.closed = 0
  hooks.openError = undefined
  hooks.queryError = undefined
  hooks.closeError = undefined
  hooks.sqliteAvailable = true
  takeQueuedLogRecords()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function createModernDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE sessions(
      id TEXT, source TEXT, model TEXT, cwd TEXT, billing_provider TEXT,
      input_tokens REAL, output_tokens REAL, cache_read_tokens REAL, cache_write_tokens REAL,
      reasoning_tokens REAL, estimated_cost_usd REAL, actual_cost_usd REAL,
      api_call_count REAL, tool_call_count REAL, started_at REAL, ended_at REAL, title TEXT
    );
    CREATE TABLE messages(
      id INTEGER, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT,
      tool_name TEXT, timestamp REAL
    );
  `)
  return db
}

function insertSession(
  db: DatabaseSync,
  overrides: Partial<{
    id: string
    source: string | null
    model: string | null
    cwd: string | null
    billingProvider: string | null
    input: number | null
    output: number | null
    cacheRead: number | null
    cacheWrite: number | null
    reasoning: number | null
    estimated: SQLInputValue
    actual: SQLInputValue
    apiCalls: number | null
    toolCalls: number | null
    started: number | null
    ended: number | null
    title: string | null
  }> = {},
): void {
  const value = {
    id: 'session-1',
    source: null,
    model: 'hermes-fixture-model',
    cwd: null,
    billingProvider: null,
    input: 10,
    output: 6,
    cacheRead: 4,
    cacheWrite: 2,
    reasoning: 3,
    estimated: null,
    actual: null,
    apiCalls: 1,
    toolCalls: 1,
    started: 1_700_000_000,
    ended: null,
    title: null,
    ...overrides,
  }
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    value.id,
    value.source,
    value.model,
    value.cwd,
    value.billingProvider,
    value.input,
    value.output,
    value.cacheRead,
    value.cacheWrite,
    value.reasoning,
    value.estimated,
    value.actual,
    value.apiCalls,
    value.toolCalls,
    value.started,
    value.ended,
    value.title,
  )
}

function insertMessage(
  db: DatabaseSync,
  id: SQLInputValue,
  role: string,
  content: SQLInputValue,
  toolCalls: SQLInputValue = null,
  toolName: SQLInputValue = null,
  timestamp: SQLInputValue = id,
  sessionId = 'session-1',
): void {
  db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    sessionId,
    role,
    content,
    toolCalls,
    toolName,
    timestamp,
  )
}

function nativeDiscovery(provider: Provider, signal?: AbortSignal) {
  if (!provider.discoverSessionsEffect) throw new Error('Hermes Effect discovery is unavailable')
  return provider.discoverSessionsEffect(signal ? { signal } : undefined).pipe(Effect.provide(Env.layer))
}

function parser(
  source: SessionSource,
  seen = new Set<string>(),
  signal?: AbortSignal,
  pricing?: ScanPricing,
  hermesHome = root,
): SessionParser {
  const context = signal || pricing ? { ...(signal ? { signal } : {}), ...(pricing ? { pricing } : {}) } : undefined
  return createHermesProvider(hermesHome).createSessionParser(source, seen, undefined, context)
}

function parserStream(value: SessionParser) {
  if (!value.parseStream) throw new Error('Hermes parser has no native Stream')
  return value.parseStream()
}

async function collect(value: SessionParser): Promise<ParsedProviderCall[]> {
  return [...(await Effect.runPromise(Stream.runCollect(parserStream(value))))]
}

function openSourceDb(path: string, create: (db: DatabaseSync) => void): void {
  const db = createModernDb(path)
  try {
    create(db)
  } finally {
    db.close()
  }
}

function pricingWithCost(cost: number): ScanPricing {
  return {
    calculateCost: () => cost,
    calculateLocalModelSavings: () => null,
  }
}

describe('Hermes Effect provider', () => {
  it('discovers root and profile databases in filesystem and SQL row order', async () => {
    const home = join(root, 'hermes')
    const profiles = join(home, 'profiles')
    const profileDir = join(profiles, 'alpha')
    mkdirSync(profileDir, { recursive: true })
    const rootDbPath = join(home, 'state.db')
    const profileDbPath = join(profileDir, 'state.db')

    openSourceDb(rootDbPath, db => {
      insertSession(db, { id: 'older', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, started: 10 })
      insertSession(db, { id: 'newer', input: 2, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, started: 30 })
    })
    openSourceDb(profileDbPath, db => {
      insertSession(db, { id: 'profile-session', input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
    })

    const sources = await Effect.runPromise(nativeDiscovery(createHermesProvider(home)))
    expect(sources).toEqual([
      { path: `${rootDbPath}#hermes-session=newer`, project: 'default', provider: 'hermes' },
      { path: `${rootDbPath}#hermes-session=older`, project: 'default', provider: 'hermes' },
      { path: `${profileDbPath}#hermes-session=profile-session`, project: 'alpha', provider: 'hermes' },
    ])
    expect(hooks.closed).toBe(2)
  })

  it('emits the complete parsed session with ordered message tools and validates JSON siblings independently', async () => {
    const home = join(root, 'hermes')
    const profileDir = join(home, 'profiles', 'alpha')
    mkdirSync(profileDir, { recursive: true })
    const path = join(profileDir, 'state.db')
    openSourceDb(path, db => {
      insertSession(db, { id: 'sesh/1', actual: 3.25, estimated: 8, cwd: null })
      insertMessage(
        db,
        1,
        'user',
        'Current working directory: /work/project',
        Buffer.from('ignored user tool_calls'),
        null,
        1,
        'sesh/1',
      )
      insertMessage(
        db,
        'ignored assistant id',
        'assistant',
        Buffer.from('ignored assistant content'),
        JSON.stringify([
          null,
          { function: { name: 'terminal', arguments: JSON.stringify({ command: 'npm test', path: '/tmp/task' }) } },
          { function: { name: 'read_file', arguments: '[]' } },
          { function: { name: 42, arguments: '{}' } },
        ]),
        null,
        'ignored assistant timestamp',
        'sesh/1',
      )
      insertMessage(
        db,
        'ignored tool id',
        'tool',
        Buffer.from('ignored tool content'),
        null,
        'mcp_composio_lookup',
        'ignored tool timestamp',
        'sesh/1',
      )
    })

    const calculateCost = vi.fn(() => 99)
    const seen = new Set<string>()
    const calls = await collect(
      parser(
        { path: `${path}#hermes-session=sesh%2F1`, project: 'alpha', provider: 'hermes' },
        seen,
        undefined,
        {
          calculateCost,
          calculateLocalModelSavings: () => null,
        },
        home,
      ),
    )

    expect(calls).toEqual([
      {
        provider: 'hermes',
        model: 'hermes-fixture-model',
        inputTokens: 10,
        outputTokens: 6,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 4,
        cachedInputTokens: 4,
        reasoningTokens: 3,
        webSearchRequests: 0,
        costUSD: 3.25,
        costIsEstimated: false,
        tools: ['Bash', 'Read', 'MCP'],
        bashCommands: ['npm test'],
        timestamp: '2023-11-14T22:13:20.000Z',
        speed: 'standard',
        deduplicationKey: 'hermes:alpha:sesh/1',
        turnId: 'sesh/1:session',
        toolSequence: [[{ tool: 'Bash', command: 'npm test', file: '/tmp/task' }, { tool: 'Read' }]],
        userMessage: 'Current working directory: /work/project',
        sessionId: 'sesh/1',
        project: 'work-project',
        projectPath: '/work/project',
      },
    ])
    expect(seen).toEqual(new Set(['hermes:alpha:sesh/1']))
    expect(calculateCost).toHaveBeenCalledWith('hermes-fixture-model', 10, 9, 2, 4, 0)
    expect(hooks.closed).toBe(1)
  })

  it.each([
    { actual: 4.5, estimated: 2.5, expected: 4.5, estimatedFlag: false },
    { actual: 0, estimated: 2.5, expected: 2.5, estimatedFlag: false },
    { actual: 0, estimated: 0, expected: 99, estimatedFlag: true },
  ])(
    'uses positive actual, then positive estimated, then calculated cost',
    async ({ actual, estimated, expected, estimatedFlag }) => {
      const path = join(root, 'state.db')
      openSourceDb(path, db => insertSession(db, { actual, estimated }))
      const pricing = pricingWithCost(99)
      const calls = await collect(
        parser(
          { path: `${path}#hermes-session=session-1`, project: 'default', provider: 'hermes' },
          new Set(),
          undefined,
          pricing,
        ),
      )
      expect(calls[0]).toMatchObject({ costUSD: expected, costIsEstimated: estimatedFlag })
    },
  )

  it.each([
    { actual: 'not-a-cost', estimated: 2.5, expected: 2.5, estimatedFlag: false },
    { actual: Buffer.from('not-a-cost'), estimated: 2.5, expected: 2.5, estimatedFlag: false },
    { actual: 4.5, estimated: 'not-a-cost', expected: 4.5, estimatedFlag: false },
    { actual: 'not-a-cost', estimated: 'also-not-a-cost', expected: 99, estimatedFlag: true },
  ])(
    'ignores malformed unselected recorded costs while retaining legacy cost precedence',
    async ({ actual, estimated, expected, estimatedFlag }) => {
      const path = join(root, 'state.db')
      openSourceDb(path, db => insertSession(db, { actual, estimated }))
      const calculateCost = vi.fn(() => 99)
      const seen = new Set<string>()
      const calls = await collect(
        parser({ path: `${path}#hermes-session=session-1`, project: 'default', provider: 'hermes' }, seen, undefined, {
          calculateCost,
          calculateLocalModelSavings: () => null,
        }),
      )

      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ costUSD: expected, costIsEstimated: estimatedFlag })
      expect(calculateCost).toHaveBeenCalledTimes(1)
      expect(seen).toEqual(new Set(['hermes:default:session-1']))
    },
  )

  it('counts an invalid selected SQLite scalar after closing, pricing and marking the key', async () => {
    const path = join(root, 'state.db')
    openSourceDb(path, db => insertSession(db, { actual: new Uint8Array([4]), estimated: 2.5 }))
    const seen = new Set<string>()
    const calculateCost = vi.fn(() => {
      expect(hooks.closed).toBe(1)
      expect(seen).toEqual(new Set(['hermes:default:session-1']))
      return 99
    })
    const value = parser(
      { path: `${path}#hermes-session=session-1`, project: 'default', provider: 'hermes' },
      seen,
      undefined,
      { calculateCost, calculateLocalModelSavings: () => null },
    )
    if (!value.parseStream) throw new Error('Hermes native parser is unavailable')
    const rejected = vi.fn()

    const calls = await Effect.runPromise(Stream.runCollect(value.parseStream(Effect.sync(rejected))))

    expect([...calls]).toEqual([])
    expect(calculateCost).toHaveBeenCalledOnce()
    expect(rejected).toHaveBeenCalledOnce()
    expect(hooks.closed).toBe(1)
  })

  it('evaluates computed pricing before recorded-cost selection and marks the key before callback failure', async () => {
    const path = join(root, 'state.db')
    openSourceDb(path, db => insertSession(db, { actual: 'not-a-cost', estimated: 'also-not-a-cost' }))
    const seen = new Set<string>()
    const pricingError = new Error('pricing callback failed')
    const pricing = {
      calculateCost: vi.fn(() => {
        throw pricingError
      }),
      calculateLocalModelSavings: () => null,
    } satisfies ScanPricing

    await expect(
      Effect.runPromise(
        Stream.runCollect(
          parserStream(
            parser(
              {
                path: `${path}#hermes-session=session-1`,
                project: 'default',
                provider: 'hermes',
              },
              seen,
              undefined,
              pricing,
            ),
          ),
        ),
      ),
    ).rejects.toBe(pricingError)
    expect(seen).toEqual(new Set(['hermes:default:session-1']))
    expect(pricing.calculateCost).toHaveBeenCalledTimes(1)
  })

  it('uses optional-column defaults for older schemas', async () => {
    const path = join(root, 'legacy.db')
    const db = new DatabaseSync(path)
    try {
      db.exec(`
        CREATE TABLE sessions(id TEXT, input_tokens REAL, output_tokens REAL);
        CREATE TABLE messages(session_id TEXT, role TEXT, content TEXT, tool_calls TEXT);
        INSERT INTO sessions VALUES ('legacy-session', 5, 1);
        INSERT INTO messages VALUES ('legacy-session', 'user', 'hello', NULL);
      `)
    } finally {
      db.close()
    }

    const calls = await collect(
      parser({ path: `${path}#hermes-session=legacy-session`, project: 'fixture', provider: 'hermes' }),
    )
    expect(calls).toEqual([
      {
        provider: 'hermes',
        model: 'unknown',
        inputTokens: 5,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD: expect.any(Number),
        costIsEstimated: true,
        tools: [],
        bashCommands: [],
        timestamp: '',
        speed: 'standard',
        deduplicationKey: 'hermes:default:legacy-session',
        turnId: 'legacy-session:session',
        toolSequence: undefined,
        userMessage: 'hello',
        sessionId: 'legacy-session',
        project: 'default',
        projectPath: undefined,
      },
    ])
  })

  it('keeps open, read, busy, close and schema fallbacks distinct', async () => {
    const path = join(root, 'state.db')
    openSourceDb(path, db => insertSession(db))
    const source = { path: `${path}#hermes-session=session-1`, project: 'default', provider: 'hermes' } as const

    hooks.openError = Object.assign(new Error('cannot open'), { code: 'ENOENT' })
    expect(await collect(parser(source))).toEqual([])
    expect(takeQueuedLogRecords()).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ provider: 'hermes', code: 'ENOENT' }) }),
    ])

    hooks.openError = undefined
    hooks.queryError = { includes: 'FROM sessions', error: new Error('select failed') }
    expect(await collect(parser(source))).toEqual([])
    expect(takeQueuedLogRecords()).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ provider: 'hermes', code: 'db-query-failed' }) }),
    ])

    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
    hooks.queryError = { includes: 'FROM sessions', error: busy }
    await expect(collect(parser(source))).rejects.toBe(busy)

    hooks.queryError = undefined
    hooks.closeError = new Error('close failed')
    await expect(collect(parser(source))).rejects.toBe(hooks.closeError)
    expect(hooks.closed).toBe(3)
  })

  it('keeps discovery query failures as an empty fallback but propagates SQLite busy and close errors', async () => {
    const home = join(root, 'hermes')
    mkdirSync(home, { recursive: true })
    openSourceDb(join(home, 'state.db'), db => insertSession(db))

    hooks.queryError = { includes: 'SELECT id,', error: new Error('select failed') }
    await expect(Effect.runPromise(nativeDiscovery(createHermesProvider(home)))).resolves.toEqual([])
    expect(takeQueuedLogRecords()).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ provider: 'hermes', code: 'db-query-failed' }) }),
    ])

    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
    hooks.queryError = { includes: 'SELECT id,', error: busy }
    await expect(Effect.runPromise(nativeDiscovery(createHermesProvider(home)))).rejects.toBe(busy)

    hooks.queryError = undefined
    hooks.closeError = new Error('close failed')
    await expect(Effect.runPromise(nativeDiscovery(createHermesProvider(home)))).rejects.toBe(hooks.closeError)
  })

  it('closes SQLite before pricing, evaluates price only when pulled, and preserves the abort reason', async () => {
    const path = join(root, 'state.db')
    openSourceDb(path, db => insertSession(db))
    const controller = new AbortController()
    const abortReason = new ScanAbortedError({ message: 'stop after pricing' })
    const calculateCost = vi.fn(() => {
      expect(hooks.closed).toBe(1)
      controller.abort(abortReason)
      return 12
    })
    const seen = new Set<string>()
    const value = parser(
      { path: `${path}#hermes-session=session-1`, project: 'default', provider: 'hermes' },
      seen,
      controller.signal,
      { calculateCost, calculateLocalModelSavings: () => null },
    )
    const stream = parserStream(value)
    expect(calculateCost).not.toHaveBeenCalled()
    expect(seen).toEqual(new Set())
    const exit = await Effect.runPromiseExit(Stream.runCollect(stream))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBe(abortReason)
    expect(calculateCost).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(new Set(['hermes:default:session-1']))
    expect(hooks.closed).toBe(1)
  })

  it('preserves a caller abort reason before discovery or parser IO', async () => {
    const reason = new ScanAbortedError({ message: 'stop Hermes scan' })
    const controller = new AbortController()
    controller.abort(reason)
    await expect(Effect.runPromise(nativeDiscovery(createHermesProvider(root), controller.signal))).rejects.toBe(reason)

    const value = parser(
      { path: `${join(root, 'missing.db')}#hermes-session=missing`, project: 'default', provider: 'hermes' },
      new Set(),
      controller.signal,
    )
    const exit = await Effect.runPromiseExit(Stream.runCollect(parserStream(value)))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBe(reason)
    expect(hooks.closed).toBe(0)
  })
})
