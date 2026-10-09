import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Cause, Effect, Exit, Option, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  closed: 0,
  openError: undefined as Error | undefined,
  queryError: undefined as Error | undefined,
  closeError: undefined as Error | undefined,
  readFailure: false,
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
          if (hooks.queryError && (sql.includes('tool_usage') || sql.includes('JOIN model_usage'))) {
            throw hooks.queryError
          }
          if (hooks.readFailure && sql.includes('JOIN model_usage')) throw new Error('discovery read failed')
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
import type { ParsedProviderCall, Provider, SessionParser } from '../src/main/pipeline/providers/types.js'
import { createZcodeProvider } from '../src/main/pipeline/providers/zcode.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'

let root = ''
let dbPath = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-zcode-effect-'))
  dbPath = join(root, 'db.sqlite')
  hooks.closed = 0
  hooks.openError = undefined
  hooks.queryError = undefined
  hooks.closeError = undefined
  hooks.readFailure = false
  takeQueuedLogRecords()
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE session(id TEXT, directory TEXT);
    CREATE TABLE model_usage(
      id TEXT, session_id TEXT, turn_id TEXT, model_id TEXT, input_tokens, output_tokens,
      reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens,
      started_at, completed_at
    );
    CREATE TABLE tool_usage(session_id TEXT, turn_id TEXT, tool_name TEXT, started_at INTEGER);
    INSERT INTO session VALUES ('session-1', '/work/project');
    INSERT INTO tool_usage VALUES ('session-1', 'turn-1', 'Read', 1);
    INSERT INTO tool_usage VALUES ('session-1', 'turn-1', 'Bash', 2);
  `)
  db.close()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function insertUsage(
  id: string,
  turnId: string | null,
  input: number | string | null,
  output: number | string | null,
  reasoning: number | string | null,
  cacheCreation: number | string | null,
  cacheRead: number | string | null,
  started: number | string | null,
  completed: number | string | null,
): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.prepare('INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      'session-1',
      turnId,
      'test-model',
      input,
      output,
      reasoning,
      cacheCreation,
      cacheRead,
      started,
      completed,
    )
  } finally {
    db.close()
  }
}

function parser(seen = new Set<string>(), signal?: AbortSignal, pricing?: ScanPricing): SessionParser {
  const context = signal || pricing ? { ...(signal ? { signal } : {}), ...(pricing ? { pricing } : {}) } : undefined
  return createZcodeProvider(dbPath).createSessionParser(
    { path: `${dbPath}:session-1`, project: 'project', provider: 'zcode' },
    seen,
    undefined,
    context,
  )
}

function nativeDiscovery(provider: Provider, signal?: AbortSignal) {
  if (!provider.discoverSessionsEffect) throw new Error('ZCode Effect discovery is unavailable')
  return provider.discoverSessionsEffect(signal ? { signal } : undefined).pipe(Effect.provide(Env.layer))
}

async function collect(value: SessionParser): Promise<ParsedProviderCall[]> {
  if (!value.parseStream) throw new Error('ZCode parser has no native Stream')
  return [...(await Effect.runPromise(Stream.runCollect(value.parseStream())))]
}

describe('ZCode Effect provider', () => {
  it('discovers sessions with billable token usage and closes the database', async () => {
    insertUsage('billable', null, 0, 0, 3, 0, 0, 100, null)
    insertUsage('empty', null, 0, 0, 0, 0, 0, 200, null)
    const sources = await Effect.runPromise(nativeDiscovery(createZcodeProvider(dbPath)))
    expect(sources).toEqual([{ path: `${dbPath}:session-1`, project: 'work-project', provider: 'zcode' }])
    expect(hooks.closed).toBe(1)
  })

  it('keeps discovery read failures as an empty fallback and still propagates close failures', async () => {
    hooks.readFailure = true
    await expect(Effect.runPromise(nativeDiscovery(createZcodeProvider(dbPath)))).resolves.toEqual([])
    expect(hooks.closed).toBe(1)
    hooks.readFailure = false
    hooks.closeError = new Error('close failed')
    await expect(Effect.runPromise(nativeDiscovery(createZcodeProvider(dbPath)))).rejects.toThrow('close failed')
  })

  it('retains the native errno in the open-failure notice', async () => {
    hooks.openError = Object.assign(new Error('missing database'), { code: 'ENOENT' })
    expect(await collect(parser())).toEqual([])
    expect(takeQueuedLogRecords()).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ provider: 'zcode', code: 'ENOENT' }) }),
    ])
  })

  it('splits cached input, preserves reasoning and timestamp fallback, and attaches turn tools once', async () => {
    insertUsage('first', 'turn-1', 100, 20, 5, 10, 30, 10, null)
    insertUsage('second', 'turn-1', 10, 1, 2, 0, 0, 20, 30)
    const calls = await collect(parser())
    expect(calls).toEqual([
      expect.objectContaining({
        deduplicationKey: 'zcode:first',
        inputTokens: 60,
        outputTokens: 20,
        reasoningTokens: 5,
        cacheCreationInputTokens: 10,
        cacheReadInputTokens: 30,
        timestamp: new Date(10).toISOString(),
        tools: ['Read', 'Bash'],
      }),
      expect.objectContaining({
        deduplicationKey: 'zcode:second',
        tools: [],
        timestamp: new Date(30).toISOString(),
      }),
    ])
    expect(hooks.closed).toBe(1)
  })

  it('preserves epoch fallback and uses a valid completion time despite a malformed start time', async () => {
    insertUsage('null-start', null, 1, 1, 0, 0, 0, null, null)
    insertUsage('bad-start-complete', null, 1, 1, 0, 0, 0, 'bad', 99)
    insertUsage('nonfinite-complete', null, 1, 1, 0, 0, 0, 99, Infinity)
    const calls = await collect(parser())
    expect(calls.map(call => call.timestamp)).toEqual([
      new Date(0).toISOString(),
      new Date(0).toISOString(),
      new Date(99).toISOString(),
    ])
    expect(calls.find(call => call.deduplicationKey === 'zcode:bad-start-complete')?.timestamp).toBe(
      new Date(99).toISOString(),
    )
  })

  it('captures pricing once and admits only a consumed call before closing', async () => {
    insertUsage('one', 'turn-1', 10, 1, 0, 0, 0, 1, null)
    insertUsage('two', 'turn-2', 20, 2, 0, 0, 0, 2, null)
    insertUsage('three', 'turn-3', 30, 3, 0, 0, 0, 3, null)
    const priced: number[] = []
    const pricing = {
      calculateCost: (_model: string, input: number) => {
        priced.push(input)
        return input
      },
      calculateLocalModelSavings: () => null,
    } satisfies ScanPricing
    const seen = new Set<string>()
    const parseStream = parser(seen, undefined, pricing).parseStream
    if (!parseStream) throw new Error('ZCode parser has no native Stream')
    const stream = parseStream()
    const first = await Effect.runPromise(Stream.runHead(stream))
    expect(first).toMatchObject({ _tag: 'Some', value: { deduplicationKey: 'zcode:one', costUSD: 10 } })
    expect(seen).toEqual(new Set(['zcode:one']))
    expect(priced).toEqual([10])
    expect(hooks.closed).toBe(1)
  })

  it('marks a usage key seen before a pricing failure, matching the legacy admission order', async () => {
    insertUsage('pricing-fails', null, 1, 1, 0, 0, 0, 1, null)
    const seen = new Set<string>()
    const pricing = {
      calculateCost: () => {
        throw new Error('pricing failed')
      },
      calculateLocalModelSavings: () => null,
    } satisfies ScanPricing
    await expect(collect(parser(seen, undefined, pricing))).rejects.toThrow('pricing failed')
    expect(seen).toEqual(new Set(['zcode:pricing-fails']))
  })

  it('skips malformed consumed usage values without emitting them', async () => {
    insertUsage('malformed', 'turn-1', 'not-a-number', 1, 0, 0, 0, 1, null)
    insertUsage('valid', 'turn-2', 5, 1, 0, 0, 0, 2, null)
    expect((await collect(parser())).map(call => call.deduplicationKey)).toEqual(['zcode:valid'])
  })

  it('retains the caller abort error and closes the connection on failure', async () => {
    insertUsage('one', null, 1, 1, 0, 0, 0, 1, null)
    const controller = new AbortController()
    const aborted = new ScanAbortedError({ message: 'caller stopped' })
    controller.abort(aborted)
    const result = await Effect.runPromiseExit(collectStream(parser(new Set(), controller.signal)))
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) expect(Option.getOrThrow(Cause.findErrorOption(result.cause))).toBe(aborted)
    expect(hooks.closed).toBe(0)
  })

  it('keeps SQL and close failures in the Effect error channel', async () => {
    insertUsage('one', null, 1, 1, 0, 0, 0, 1, null)
    hooks.queryError = new Error('select failed')
    await expect(collect(parser())).rejects.toBe(hooks.queryError)
    expect(hooks.closed).toBe(1)
    hooks.queryError = undefined
    hooks.closeError = new Error('close failed')
    await expect(collect(parser())).rejects.toThrow('close failed')
  })
})

function collectStream(value: SessionParser) {
  if (!value.parseStream) throw new Error('ZCode parser has no native Stream')
  return Stream.runCollect(value.parseStream())
}
