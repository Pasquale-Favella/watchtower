import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  closed: 0,
  openError: undefined as Error | undefined,
  queryError: undefined as Error | undefined,
  closeError: undefined as Error | undefined,
  afterQuery: undefined as ((sql: string) => void) | undefined,
}))

vi.mock('../src/main/pipeline/sqlite.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/pipeline/sqlite.js')>()
  return {
    ...actual,
    isSqliteAvailable: () => true,
    openDatabase(path: string) {
      if (hooks.openError) throw hooks.openError
      const db = actual.openDatabase(path)
      return {
        query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
          hooks.afterQuery?.(sql)
          if (hooks.queryError && sql.includes('FROM sessions') && !sql.includes('WHERE 0')) {
            throw hooks.queryError
          }
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

import { appPaths, Env } from '../src/main/env.js'
import { takeQueuedLogRecords } from '../src/main/pipeline/file-errors.js'
import { setPriceOverrides } from '../src/main/pipeline/models.js'
import { createCrushProvider } from '../src/main/pipeline/providers/crush.js'
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
  root = mkdtempSync(join(tmpdir(), 'watchtower-crush-effect-'))
  hooks.closed = 0
  hooks.openError = undefined
  hooks.queryError = undefined
  hooks.closeError = undefined
  hooks.afterQuery = undefined
  setPriceOverrides({})
  takeQueuedLogRecords()
})

afterEach(() => {
  setPriceOverrides({})
  rmSync(root, { recursive: true, force: true })
})

function makeProject(name: string, sessions: Array<Record<string, string | number | null | undefined>> = []): string {
  const projectPath = join(root, name)
  const dataDir = join(projectPath, '.crush')
  mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(join(dataDir, 'crush.db'))
  try {
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT,
      prompt_tokens,
      completion_tokens,
      cost,
      created_at,
      updated_at
    ); CREATE TABLE messages (session_id TEXT, model);`)
    const insert = db.prepare(
      'INSERT INTO sessions (id, parent_session_id, prompt_tokens, completion_tokens, cost, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    for (const session of sessions) {
      insert.run(
        session['id'] ?? '',
        session['parent_session_id'] ?? null,
        session['prompt_tokens'] ?? null,
        session['completion_tokens'] ?? null,
        session['cost'] ?? null,
        session['created_at'] ?? null,
        session['updated_at'] ?? null,
      )
      const model = session['model'] ?? null
      if (model !== null) {
        db.prepare('INSERT INTO messages (session_id, model) VALUES (?, ?)').run(session['id'] ?? '', model)
      }
    }
  } finally {
    db.close()
  }
  return projectPath
}

function writeRegistry(entries: unknown, name = 'projects.json'): string {
  const path = join(root, name)
  writeFileSync(path, JSON.stringify(entries))
  return path
}

function pathsAt(registryRoot: string) {
  const paths = appPaths()
  return { ...paths, overrides: { ...paths.overrides, CRUSH_GLOBAL_DATA: registryRoot } }
}

function sourceFor(dbPath: string, sessionId = 'session-1'): SessionSource {
  return { path: `${dbPath}:${sessionId}`, project: 'fixture', provider: 'crush' }
}

function parser(
  dbPath: string,
  context?: { signal?: AbortSignal; pricing?: ScanPricing },
  sessionId = 'session-1',
  seenKeys = new Set<string>(),
): SessionParser {
  return createCrushProvider().createSessionParser(sourceFor(dbPath, sessionId), seenKeys, undefined, context)
}

function fixedPricing(cost: number): ScanPricing {
  return { calculateCost: () => cost, calculateLocalModelSavings: () => null }
}

function parseStream(
  value: SessionParser,
  onUnparsedCall?: Effect.Effect<void>,
): Stream.Stream<ParsedProviderCall, Error> {
  if (!value.parseStream) throw new Error('Crush parser has no native Stream')
  return value.parseStream(onUnparsedCall)
}

async function collect(value: SessionParser, onUnparsedCall?: Effect.Effect<void>): Promise<ParsedProviderCall[]> {
  return [...(await Effect.runPromise(Stream.runCollect(parseStream(value, onUnparsedCall))))]
}

async function discover(provider: Provider, signal?: AbortSignal) {
  if (!provider.discoverSessionsEffect) throw new Error('Crush Effect discovery is unavailable')
  return Effect.runPromise(
    provider.discoverSessionsEffect(signal ? { signal } : undefined).pipe(Effect.provide(Env.layer)),
  )
}

describe('Crush Effect provider', () => {
  it.each(['array', 'object'] as const)(
    'decodes valid %s registry siblings independently and discovers sequential projects',
    async shape => {
      const first = makeProject('first', [
        { id: 'newer', prompt_tokens: 2, completion_tokens: 1, cost: 1, created_at: 2 },
        { id: 'older', prompt_tokens: 1, completion_tokens: 1, cost: 1, created_at: 1 },
        { id: 'child', parent_session_id: 'newer', prompt_tokens: 3, cost: 2, created_at: 3 },
      ])
      const second = makeProject('second', [{ id: 'second-session', prompt_tokens: 1, cost: 1, created_at: 3 }])
      const entries = [
        { path: first, data_dir: '.crush' },
        { path: second, data_dir: '.crush' },
      ]
      // Each root form keeps valid siblings when other entries are malformed.
      const registryValue =
        shape === 'array'
          ? [...entries, null, { path: 3, data_dir: '.crush' }]
          : { first: entries[0], second: entries[1], invalid: null, alsoInvalid: { path: '/wrong' } }
      writeRegistry(registryValue)
      const provider = createCrushProvider(pathsAt(root))

      const found = await discover(provider)
      expect(found.map(source => source.path)).toEqual([
        join(first, '.crush', 'crush.db') + ':newer',
        join(first, '.crush', 'crush.db') + ':older',
        join(second, '.crush', 'crush.db') + ':second-session',
      ])
      expect(found.map(source => source.project)).toEqual([first, first, second])
      expect(hooks.closed).toBe(2)
    },
  )

  it('keeps positive recorded cost ahead of fallback pricing and preserves timestamp/model selection', async () => {
    const project = makeProject('project', [
      { id: 'session-1', prompt_tokens: 10, completion_tokens: 5, cost: 4.5, created_at: 10, updated_at: 20 },
    ])
    const dbPath = join(project, '.crush', 'crush.db')
    const db = new DatabaseSync(dbPath)
    try {
      db.prepare('INSERT INTO messages (session_id, model) VALUES (?, ?)').run('session-1', 'model-b')
      db.prepare('INSERT INTO messages (session_id, model) VALUES (?, ?)').run('session-1', 'model-b')
      db.prepare('INSERT INTO messages (session_id, model) VALUES (?, ?)').run('session-1', 'model-a')
    } finally {
      db.close()
    }
    const pricing = { ...fixedPricing(99), calculateCost: vi.fn(() => 99) }
    const calls = await collect(parser(dbPath, { pricing }))
    expect(calls[0]).toMatchObject({
      model: 'model-b',
      inputTokens: 10,
      outputTokens: 5,
      costUSD: 4.5,
      timestamp: new Date(20_000).toISOString(),
      tools: [],
      bashCommands: [],
    })
    expect(pricing.calculateCost).not.toHaveBeenCalled()
    expect(hooks.closed).toBe(1)
  })

  it('uses null defaults, unknown model, and epoch timestamp while ignoring unused columns', async () => {
    const projectPath = join(root, 'null-project')
    const dataDir = join(projectPath, '.crush')
    mkdirSync(dataDir, { recursive: true })
    const dbPath = join(dataDir, 'crush.db')
    const db = new DatabaseSync(dbPath)
    try {
      db.exec(`CREATE TABLE sessions (
        id TEXT PRIMARY KEY, parent_session_id TEXT, prompt_tokens, completion_tokens,
        cost, created_at, updated_at, unused_column
      ); CREATE TABLE messages (session_id TEXT, model);`)
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        'session-1',
        null,
        null,
        null,
        2.5,
        null,
        null,
        'malformed-but-unused',
      )
    } finally {
      db.close()
    }

    const calls = await collect(parser(dbPath, { pricing: fixedPricing(99) }))
    expect(calls[0]).toMatchObject({
      model: 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 2.5,
      timestamp: new Date(0).toISOString(),
    })
  })

  it('omits and tallies malformed consumed token values after seen admission', async () => {
    const project = makeProject('invalid', [
      { id: 'invalid', prompt_tokens: 'bad', completion_tokens: 1, cost: 1 },
      { id: 'valid', prompt_tokens: 2, completion_tokens: 1, cost: 1 },
    ])
    const dbPath = join(project, '.crush', 'crush.db')
    const db = new DatabaseSync(dbPath)
    try {
      db.prepare('INSERT INTO messages VALUES (?, ?)').run('valid', 'model-valid')
    } finally {
      db.close()
    }
    const seen = new Set<string>()
    let unparsed = 0
    const invalid = parser(dbPath, undefined, 'invalid', seen)
    expect(
      await collect(
        invalid,
        Effect.sync(() => void unparsed++),
      ),
    ).toEqual([])
    expect(unparsed).toBe(1)
    expect(seen).toEqual(new Set(['crush:invalid']))

    const valid = parser(dbPath, undefined, 'valid', seen)
    expect((await collect(valid)).map(call => call.deduplicationKey)).toEqual(['crush:valid'])
  })

  it('uses only the selected timestamp and falls back to epoch for an invalid selection', async () => {
    const project = makeProject('timestamps', [
      { id: 'unused-created', prompt_tokens: 1, cost: 1, created_at: 'bad', updated_at: 10 },
      { id: 'invalid-selected', prompt_tokens: 1, cost: 1, created_at: 20, updated_at: 'bad' },
    ])
    const dbPath = join(project, '.crush', 'crush.db')
    const validUpdated = await collect(parser(dbPath, undefined, 'unused-created'))
    const invalidUpdated = await collect(parser(dbPath, undefined, 'invalid-selected'))
    expect(validUpdated[0]?.timestamp).toBe(new Date(10_000).toISOString())
    expect(invalidUpdated[0]?.timestamp).toBe(new Date(0).toISOString())
  })

  it('uses pricing for a malformed nonpositive recorded cost and omits a malformed positive one', async () => {
    const project = makeProject('cost-decoding', [
      { id: 'invalid-nonpositive', prompt_tokens: 1, cost: 'bad' },
      { id: 'invalid-positive', prompt_tokens: 1, cost: Number.POSITIVE_INFINITY },
    ])
    const dbPath = join(project, '.crush', 'crush.db')
    const fallback = await collect(parser(dbPath, { pricing: fixedPricing(99) }, 'invalid-nonpositive'))
    expect(fallback[0]).toMatchObject({ inputTokens: 1, costUSD: 99 })

    let unparsed = 0
    const seen = new Set<string>()
    const malformedPositive = parser(dbPath, { pricing: fixedPricing(99) }, 'invalid-positive', seen)
    expect(
      await collect(
        malformedPositive,
        Effect.sync(() => void unparsed++),
      ),
    ).toEqual([])
    expect(unparsed).toBe(1)
    expect(seen).toEqual(new Set(['crush:invalid-positive']))
  })

  it('admits only root sessions and marks a fallback-priced session seen before pricing', async () => {
    const project = makeProject('root-filter', [
      { id: 'root-session', prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      { id: 'child-session', parent_session_id: 'root-session', prompt_tokens: 5, cost: 1 },
    ])
    const dbPath = join(project, '.crush', 'crush.db')
    const seen = new Set<string>()
    const pricing: ScanPricing = {
      calculateCost: () => {
        throw new Error('price lookup failed')
      },
      calculateLocalModelSavings: () => null,
    }
    const provider = createCrushProvider()
    const rootParser = provider.createSessionParser(sourceFor(dbPath, 'root-session'), seen, undefined, { pricing })
    await expect(collect(rootParser)).rejects.toThrow('price lookup failed')
    expect(seen).toEqual(new Set(['crush:root-session']))

    const childParser = provider.createSessionParser(sourceFor(dbPath, 'child-session'), new Set(), undefined, {
      pricing: fixedPricing(99),
    })
    await expect(collect(childParser)).resolves.toEqual([])
    expect(hooks.closed).toBe(2)
  })

  it('captures fallback pricing when the parser is created', async () => {
    const project = makeProject('pricing', [
      { id: 'session-1', prompt_tokens: 1_000_000, completion_tokens: 0, cost: 0 },
    ])
    const dbPath = join(project, '.crush', 'crush.db')
    const db = new DatabaseSync(dbPath)
    try {
      db.prepare('INSERT INTO messages VALUES (?, ?)').run('session-1', 'crush-captured-model')
    } finally {
      db.close()
    }

    setPriceOverrides({ 'crush-captured-model': { input: 1, output: 1 } })
    const capturedParser = parser(dbPath)
    setPriceOverrides({ 'crush-captured-model': { input: 2, output: 2 } })
    const captured = await collect(capturedParser)
    const fresh = await collect(parser(dbPath))
    expect(captured[0]?.costUSD).toBeGreaterThan(0)
    expect(fresh[0]?.costUSD).toBe(captured[0]?.costUSD * 2)
  })

  it('closes the parser connection once at EOF and after an early stream stop', async () => {
    const project = makeProject('close', [{ id: 'session-1', prompt_tokens: 1, completion_tokens: 1, cost: 1 }])
    const dbPath = join(project, '.crush', 'crush.db')
    await collect(parser(dbPath))
    expect(hooks.closed).toBe(1)

    hooks.closed = 0
    const iterator = Stream.toAsyncIterable(parseStream(parser(dbPath)))[Symbol.asyncIterator]()
    expect((await iterator.next()).value?.sessionId).toBe('session-1')
    await iterator.return?.()
    expect(hooks.closed).toBe(1)
  })

  it('closes after a read error and preserves the native error in the legacy adapter', async () => {
    const project = makeProject('read-error', [{ id: 'session-1', prompt_tokens: 1, completion_tokens: 1, cost: 1 }])
    const dbPath = join(project, '.crush', 'crush.db')
    hooks.queryError = new Error('session read failed')
    const nativeParser = parser(dbPath)
    await expect(collect(nativeParser)).rejects.toThrow('session read failed')
    expect(hooks.closed).toBe(1)

    hooks.closed = 0
    await expect(nativeParser.parse().next()).rejects.toBe(hooks.queryError)
    expect(hooks.closed).toBe(1)
  })

  it('unwraps the original close error at EOF for the legacy parser adapter', async () => {
    const project = makeProject('close-error', [{ id: 'session-1', prompt_tokens: 1, completion_tokens: 1, cost: 1 }])
    const dbPath = join(project, '.crush', 'crush.db')
    const closeError = new Error('native close failed')
    hooks.closeError = closeError
    const legacyParser = parser(dbPath)
    const consume = async () => {
      const calls: ParsedProviderCall[] = []
      for await (const call of legacyParser.parse()) calls.push(call)
      return calls
    }

    await expect(consume()).rejects.toBe(closeError)
    expect(hooks.closed).toBe(1)
  })

  it('keeps the native open errno in the existing provider notice', async () => {
    const missingPath = join(root, 'missing.db')
    hooks.openError = Object.assign(new Error('database missing'), { code: 'ENOENT' })
    expect(await collect(parser(missingPath))).toEqual([])
    expect(takeQueuedLogRecords()).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ provider: 'crush', code: 'ENOENT' }) }),
    ])
  })

  it('closes after caller abort during the native query', async () => {
    const project = makeProject('abort', [{ id: 'session-1', prompt_tokens: 1, completion_tokens: 1, cost: 1 }])
    const dbPath = join(project, '.crush', 'crush.db')
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'caller stopped' })
    hooks.afterQuery = sql => {
      if (sql.includes('FROM sessions') && !sql.includes('WHERE 0')) controller.abort(abort)
    }
    const result = await Effect.runPromiseExit(
      Stream.runCollect(parseStream(parser(dbPath, { signal: controller.signal }))),
    )
    expect(result._tag).toBe('Failure')
    expect(hooks.closed).toBe(1)
  })

  it('keeps missing registry and discovery database read failures empty', async () => {
    const provider = createCrushProvider(pathsAt(join(root, 'missing')))
    await expect(discover(provider)).resolves.toEqual([])

    const project = makeProject('discovery-failure', [{ id: 'session-1', prompt_tokens: 1, cost: 1 }])
    writeRegistry([{ path: project, data_dir: '.crush' }])
    const providerAtRoot = createCrushProvider(pathsAt(root))
    hooks.queryError = new Error('discovery select failed')
    await expect(discover(providerAtRoot)).resolves.toEqual([])
    expect(hooks.closed).toBe(1)
  })

  it('resolves the registry root on each discovery call', async () => {
    const project = makeProject('call-time-root', [{ id: 'session-1', prompt_tokens: 1, cost: 1 }])
    writeRegistry([{ path: project, data_dir: '.crush' }])
    const previous = process.env['CRUSH_GLOBAL_DATA']
    try {
      process.env['CRUSH_GLOBAL_DATA'] = root
      const provider = createCrushProvider()
      expect(await discover(provider)).toHaveLength(1)
      process.env['CRUSH_GLOBAL_DATA'] = join(root, 'missing-registry')
      expect(await discover(provider)).toEqual([])
      expect(hooks.closed).toBe(1)
    } finally {
      if (previous === undefined) delete process.env['CRUSH_GLOBAL_DATA']
      else process.env['CRUSH_GLOBAL_DATA'] = previous
    }
  })

  it('retains discovery and model fallback when optional message columns are absent', async () => {
    const project = makeProject('optional-model', [{ id: 'session-1', prompt_tokens: 1, cost: 1 }])
    const dbPath = join(project, '.crush', 'crush.db')
    const db = new DatabaseSync(dbPath)
    db.exec('DROP TABLE messages; CREATE TABLE messages (unrelated TEXT)')
    db.close()
    writeRegistry([{ path: project, data_dir: '.crush' }])
    expect(await discover(createCrushProvider(pathsAt(root)))).toHaveLength(1)
    const calls = await collect(parser(dbPath))
    expect(calls[0]).toMatchObject({ inputTokens: 1, model: 'unknown', costUSD: 1 })
    expect(hooks.closed).toBe(2)
  })
})
