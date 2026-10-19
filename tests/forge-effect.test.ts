import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Cause, Effect, Exit, Option, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nativeDb = vi.hoisted(() => ({
  closed: 0,
  queryError: undefined as Error | undefined,
  closeError: undefined as Error | undefined,
  queries: [] as Array<{ sql: string; rows: number }>,
}))

vi.mock('../src/main/pipeline/sqlite.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/pipeline/sqlite.js')>()
  return {
    ...actual,
    openDatabase(path: string) {
      const db = actual.openDatabase(path)
      return {
        query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
          if (
            nativeDb.queryError &&
            (sql.includes('WHERE conversation_id') || sql.includes('WHERE context IS NOT NULL'))
          )
            throw nativeDb.queryError
          const rows = db.query<T>(sql, params)
          nativeDb.queries.push({ sql, rows: rows.length })
          return rows
        },
        close() {
          nativeDb.closed++
          db.close()
          if (nativeDb.closeError) throw nativeDb.closeError
        },
      }
    },
  }
})

import { Env } from '../src/main/env.js'
import { createForgeProvider } from '../src/main/pipeline/providers/forge.js'
import type { ProviderScanContext, SessionParser, SessionSource } from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'
import { providerParserIterator } from './fixtures/provider-effects.js'

let directory = ''

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'watchtower-forge-effect-'))
  nativeDb.closed = 0
  nativeDb.queryError = undefined
  nativeDb.closeError = undefined
  nativeDb.queries.length = 0
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function createDb(path: string, messages: unknown[]): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(
      'CREATE TABLE conversations (conversation_id TEXT, title TEXT, workspace_id INTEGER, context TEXT, created_at TEXT, updated_at TEXT)',
    )
    db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?)').run(
      'conversation-id',
      null,
      9,
      JSON.stringify({ messages, unrelated: { retained: true } }),
      '2026-01-02 03:04:05',
      null,
    )
  } finally {
    db.close()
  }
}

function source(path: string): SessionSource {
  return { path: `${path}:conversation-id`, project: 'fixture', provider: 'forge' }
}

function parser(path: string, context?: ProviderScanContext, seen = new Set<string>()): SessionParser {
  return createForgeProvider(path).createSessionParser(source(path), seen, undefined, context)
}

function nativeDiscovery(path: string, context?: ProviderScanContext) {
  const provider = createForgeProvider(path)
  const discover = provider.discoverSessionsEffect
  if (!discover) throw new Error('Forge native discovery is unavailable')
  return discover(context).pipe(Effect.provide(Env.layer))
}

function assistant(callId: string, model = 'fixture-model'): unknown {
  return {
    message: {
      text: {
        role: 'assistant',
        content: 'answer',
        model,
        tool_calls: [{ name: 'bash', call_id: callId, arguments: { command: 'echo one' } }],
      },
    },
    usage: {
      prompt_tokens: { actual: 100 },
      completion_tokens: { actual: 20 },
      cached_tokens: { actual: 10 },
      sibling: 'ignored',
    },
    sibling: true,
  }
}

function fixedPricing(calculate: (model: string) => number): ScanPricing {
  return {
    calculateCost: model => calculate(model),
    calculateLocalModelSavings: () => null,
  }
}

describe('Forge native Effect path', () => {
  it('discovers sessions natively and preserves the title fallback and source path', async () => {
    const path = join(directory, 'forge.db')
    createDb(path, [assistant('one')])
    const sessions = await Effect.runPromise(nativeDiscovery(path))
    expect(sessions).toEqual([{ path: `${path}:conversation-id`, project: '9', provider: 'forge' }])
  })

  it('keeps discovery read failures soft and closes its database once', async () => {
    const path = join(directory, 'forge.db')
    createDb(path, [assistant('one')])
    nativeDb.queryError = new Error('native discovery read failure')

    await expect(Effect.runPromise(nativeDiscovery(path))).resolves.toEqual([])
    expect(nativeDb.closed).toBe(1)
  })

  it('does not read a context row for schema detection or reject unused projection fields', async () => {
    const path = join(directory, 'forge.db')
    createDb(path, [assistant('one')])
    const db = new DatabaseSync(path)
    db.prepare('UPDATE conversations SET workspace_id = NULL, title = ?').run('Kept title')
    db.close()

    expect(await Effect.runPromise(nativeDiscovery(path))).toEqual([
      { path: `${path}:conversation-id`, project: 'Kept title', provider: 'forge' },
    ])
    expect(await Effect.runPromise(Stream.runCollect(parser(path).parseStream?.() ?? Stream.empty))).toHaveLength(1)

    const update = new DatabaseSync(path)
    update.prepare('UPDATE conversations SET title = NULL').run()
    update.close()
    expect(await Effect.runPromise(nativeDiscovery(path))).toEqual([
      { path: `${path}:conversation-id`, project: 'null', provider: 'forge' },
    ])

    const unused = new DatabaseSync(path)
    unused.prepare('UPDATE conversations SET title = ?').run(Buffer.from([0xff]))
    unused.close()
    expect(await Effect.runPromise(Stream.runCollect(parser(path).parseStream?.() ?? Stream.empty))).toHaveLength(1)
    const probes = nativeDb.queries.filter(query => query.sql.includes('WHERE 0'))
    expect(probes).toHaveLength(4)
    expect(probes.every(query => query.rows === 0)).toBe(true)
    const reads = nativeDb.queries.filter(query => query.sql.includes('WHERE conversation_id'))
    expect(reads.every(query => !query.sql.includes('workspace_id') && !query.sql.includes('title'))).toBe(true)
  })

  it('decodes malformed stored context bytes without a native UTF-8 read', async () => {
    const path = join(directory, 'forge.db')
    createDb(path, [assistant('one')])
    const db = new DatabaseSync(path)
    db.prepare('UPDATE conversations SET context = ?').run(Buffer.from([0xff, 0xfe]))
    db.close()

    expect(await Effect.runPromise(Stream.runCollect(parser(path).parseStream?.() ?? Stream.empty))).toEqual([])
    expect(nativeDb.closed).toBe(1)
  })

  it('uses consumed fields from tolerant JSON, keeps the last user prompt, and remains lazy per pull', async () => {
    const path = join(directory, 'forge.db')
    createDb(path, [
      { message: { text: { role: 'user', content: 'question'.repeat(80), unrelated: 1 } }, sibling: true },
      assistant('first'),
      assistant('second', 'later-model'),
    ])
    const priced: string[] = []
    const selected = parser(path, {
      pricing: fixedPricing(model => {
        priced.push(model)
        return 4
      }),
    })
    const head = await Effect.runPromise(Stream.runHead(selected.parseStream?.() ?? Stream.empty))
    expect(Option.isSome(head)).toBe(true)
    if (Option.isSome(head)) {
      expect(head.value.inputTokens).toBe(90)
      expect(head.value.cacheReadInputTokens).toBe(10)
      expect(head.value.userMessage).toBe('question'.repeat(80).slice(0, 500))
      expect(head.value.timestamp).toBe('2026-01-02T03:04:05.000Z')
      expect(head.value.tools).toEqual(['Bash'])
      expect(head.value.bashCommands).toEqual(['echo'])
    }
    expect(priced).toEqual(['fixture-model'])
    expect(nativeDb.closed).toBe(1)
  })

  it('keeps actual iterator index and seen-before-pricing semantics', async () => {
    const path = join(directory, 'forge.db')
    createDb(path, [{ message: { text: { role: 'system' } } }, assistant('claimed')])
    const seen = new Set<string>()
    let priceCalls = 0
    const pricingError = new Error('pricing failed')
    const selected = parser(
      path,
      {
        pricing: fixedPricing(() => {
          priceCalls++
          throw pricingError
        }),
      },
      seen,
    )
    await expect(Effect.runPromise(Stream.runCollect(selected.parseStream?.() ?? Stream.empty))).rejects.toBe(
      pricingError,
    )
    expect(seen.has('forge:conversation-id:claimed')).toBe(true)
    expect(priceCalls).toBe(1)
  })

  it('keeps tolerant per-field fallbacks for malformed consumed values', async () => {
    const path = join(directory, 'forge.db')
    createDb(path, [
      {
        message: { text: { role: 'assistant', content: 9, model: { malformed: true }, tool_calls: 'bad' } },
        usage: { prompt_tokens: { actual: 'bad' }, completion_tokens: { actual: 2 } },
      },
    ])
    const calls = await Effect.runPromise(Stream.runCollect(parser(path).parseStream?.() ?? Stream.empty))

    expect([...calls]).toMatchObject([
      {
        model: 'unknown',
        inputTokens: 0,
        outputTokens: 2,
        userMessage: '',
        tools: [],
        bashCommands: [],
      },
    ])
    expect(nativeDb.closed).toBe(1)
  })

  it('fails an already-aborted native parse with ScanAbortedError', async () => {
    const path = join(directory, 'forge.db')
    createDb(path, [assistant('one')])
    const controller = new AbortController()
    controller.abort()
    const selected = parser(path, { signal: controller.signal })
    await expect(Effect.runPromise(Stream.runCollect(selected.parseStream?.() ?? Stream.empty))).rejects.toBeInstanceOf(
      ScanAbortedError,
    )
  })

  it('keeps read and close errors in the native stream channel and closes once', async () => {
    const path = join(directory, 'forge.db')
    createDb(path, [assistant('one')])
    const readError = new Error('native read failure')
    nativeDb.queryError = readError
    const selected = parser(path)
    const nativeExit = await Effect.runPromiseExit(Stream.runCollect(selected.parseStream?.() ?? Stream.empty))
    expect(Exit.isFailure(nativeExit)).toBe(true)
    if (Exit.isFailure(nativeExit)) {
      const failure = Option.getOrUndefined(Cause.findErrorOption(nativeExit.cause)) as { cause?: Error } | undefined
      expect(failure?.cause).toBe(readError)
    }
    expect(nativeDb.closed).toBe(1)

    nativeDb.queryError = undefined
    nativeDb.closed = 0
    nativeDb.closeError = new Error('native close failure')
    const closeExit = await Effect.runPromiseExit(Stream.runCollect(parser(path).parseStream?.() ?? Stream.empty))
    expect(Exit.isFailure(closeExit)).toBe(true)
    expect(nativeDb.closed).toBe(1)
    if (Exit.isFailure(closeExit)) {
      const failure = Option.getOrUndefined(Cause.findErrorOption(closeExit.cause)) as { cause?: Error } | undefined
      expect(failure?.cause).toBe(nativeDb.closeError)
    }
  })

  it('closes the database once when the consumer stops after the first call', async () => {
    const path = join(directory, 'forge.db')
    createDb(path, [assistant('first'), assistant('second')])
    const iterator = providerParserIterator(parser(path))[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: false })
    await iterator.return?.(undefined)
    expect(nativeDb.closed).toBe(1)
  })
})
