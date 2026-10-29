import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { it as effectIt } from '@effect/vitest'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { ConfigProvider, Effect, Stream } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  openCount: 0,
  closeCount: 0,
  failRead: false,
  invalidInputTokens: false,
  includeNullTimestampPrompt: false,
  onOpen: undefined as (() => void) | undefined,
  cached: null as unknown,
  cacheWrites: 0,
  cachedWrites: [] as unknown[][],
  queries: [] as string[],
  cacheTimeFloors: [] as string[],
  busyError: new Error('SQLITE_BUSY: database is locked'),
}))

vi.mock('../src/infrastructure/ingestion/sqlite.js', () => ({
  isSqliteAvailable: () => true,
  isSqliteBusyError: (error: unknown) =>
    error === hooks.busyError || (error instanceof Error && error.cause === hooks.busyError),
  blobToText: (value: Uint8Array | string | null) => (value == null ? '' : String(value)),
  openDatabase: () => {
    hooks.openCount++
    hooks.onOpen?.()
    return {
      query: (sql: string) => {
        hooks.queries.push(sql)
        if (sql.includes('COUNT(*)')) return [{ cnt: 2 }]
        if (sql.includes('composerData:')) return []
        if (sql.includes('agentKv:blob:')) return []
        if (sql.includes("json_extract(value, '$.type') = 1")) {
          return hooks.includeNullTimestampPrompt
            ? [
                {
                  bubble_key: 'bubbleId:11111111-1111-1111-1111-111111111111:null-user',
                  text: 'prompt with null timestamp',
                },
                {
                  bubble_key: 'bubbleId:11111111-1111-1111-1111-111111111111:dated-user',
                  text: 'dated prompt',
                },
              ]
            : []
        }
        if (sql.includes('key as bubble_key')) {
          if (hooks.failRead) throw hooks.busyError
          const rows: Array<Record<string, unknown>> = [
            ...(hooks.includeNullTimestampPrompt
              ? [
                  {
                    bubble_key: 'bubbleId:11111111-1111-1111-1111-111111111111:dated-user',
                    input_tokens: 0,
                    output_tokens: 0,
                    model: null,
                    created_at: '2026-10-01T00:00:00.000Z',
                    request_id: null,
                    user_text: 'dated prompt',
                    text_length: 12,
                    bubble_type: 1,
                    code_blocks: '[]',
                  },
                ]
              : []),
            {
              bubble_key: 'bubbleId:11111111-1111-1111-1111-111111111111:one',
              input_tokens: 8,
              output_tokens: 4,
              model: 'claude-sonnet-4-5',
              created_at: '2026-10-01T00:00:00.000Z',
              request_id: null,
              user_text: 'reply one',
              text_length: 9,
              bubble_type: 2,
              code_blocks: '[]',
            },
            {
              bubble_key: 'bubbleId:11111111-1111-1111-1111-111111111111:two',
              input_tokens: 8,
              output_tokens: 4,
              model: 'claude-sonnet-4-5',
              created_at: '2026-10-01T00:00:01.000Z',
              request_id: null,
              user_text: 'reply two',
              text_length: 9,
              bubble_type: 2,
              code_blocks: '[]',
            },
          ]
          const firstRow = rows[0]
          if (firstRow) {
            if (hooks.invalidInputTokens) firstRow.input_tokens = 'unreadable'
            firstRow.unusedTitle = { malformed: true }
          }
          return rows
        }
        return []
      },
      close: () => {
        hooks.closeCount++
      },
    }
  },
}))

vi.mock('../src/infrastructure/ingestion/cursor-cache.js', async () => {
  const { Effect } = await import('effect')
  return {
    readCachedResultsEffect: (_dbPath: string, timeFloor: string) => {
      hooks.cacheTimeFloors.push(timeFloor)
      return Effect.succeed(hooks.cached)
    },
    writeCachedResultsEffect: (_dbPath: string, calls: unknown[]) =>
      Effect.sync(() => {
        hooks.cacheWrites++
        hooks.cachedWrites.push(calls)
      }),
  }
})

import { Env } from '../src/infrastructure/config/environment.js'
import {
  clearCursorWorkspaceMapCache,
  createCursorProvider,
  getCursorTimeFloor,
} from '../src/infrastructure/provider-adapters/cursor.js'
import type { ParsedProviderCall, SessionSource } from '../src/infrastructure/provider-adapters/types.js'
import type { ScanPricing } from '../src/core/domain/pricing/scan-pricing.js'

function source(): SessionSource {
  return { path: 'cursor-test-db', project: 'cursor', provider: 'cursor' }
}

function parser(signal?: AbortSignal, pricing?: ScanPricing) {
  return createCursorProvider().createSessionParser(source(), new Set(), undefined, { signal, pricing })
}

function nativeStream(signal?: AbortSignal, pricing?: ScanPricing): Stream.Stream<ParsedProviderCall, Error> {
  const stream = parser(signal, pricing).parseStream
  if (!stream) throw new Error('Cursor parser did not expose its native stream')
  return stream().pipe(Stream.provide(NodeFileSystem.layer))
}

beforeEach(() => {
  hooks.openCount = 0
  hooks.closeCount = 0
  hooks.failRead = false
  hooks.invalidInputTokens = false
  hooks.includeNullTimestampPrompt = false
  hooks.onOpen = undefined
  hooks.cached = null
  hooks.cacheWrites = 0
  hooks.cachedWrites = []
  hooks.queries = []
  hooks.cacheTimeFloors = []
  clearCursorWorkspaceMapCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  clearCursorWorkspaceMapCache()
})

describe('Cursor native Effect stream', () => {
  it('closes its database when the stream reaches EOF', async () => {
    const calls = await Effect.runPromise(Stream.runCollect(nativeStream()))
    expect(calls).toHaveLength(2)
    expect(hooks.openCount).toBe(1)
    expect(hooks.closeCount).toBe(1)
    expect(hooks.cacheWrites).toBe(1)
    expect(hooks.cachedWrites[0]).toHaveLength(2)
  })

  it('reads WATCHTOWER_CURSOR_MAX_BUBBLES when the owned read runs', async () => {
    const stream = nativeStream()

    await Effect.runPromise(
      Stream.runCollect(stream).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({ WATCHTOWER_CURSOR_MAX_BUBBLES: '1' }, { preserveEmptyStrings: true }),
        ),
      ),
    )

    expect(hooks.queries.some(sql => sql.includes('ROWID < ?'))).toBe(true)
  })

  effectIt.effect('captures the six-month SQL window from the Effect Clock when parsing starts', () =>
    Effect.gen(function* () {
      const stream = nativeStream()
      const nowMs = Date.parse('2020-10-15T12:30:00.000Z')

      yield* TestClock.setTime(nowMs)
      yield* Stream.runCollect(stream)

      expect(hooks.cacheTimeFloors).toEqual([getCursorTimeFloor(undefined, new Date(nowMs))])
      expect(hooks.cacheTimeFloors[0]).toContain('2020-04')
    }),
  )

  it('closes its database when a consumer stops early', async () => {
    const calls = await Effect.runPromise(Stream.runCollect(nativeStream().pipe(Stream.take(1))))
    expect(calls).toHaveLength(1)
    expect(hooks.closeCount).toBe(1)
    expect(hooks.cacheWrites).toBe(0)
  })

  it('prices and admits only pulled cold calls and leaves no partial cache', async () => {
    const calculateCost = vi.fn(() => 1)
    const pricing = { calculateCost, calculateLocalModelSavings: () => null }
    const calls = await Effect.runPromise(Stream.runCollect(nativeStream(undefined, pricing).pipe(Stream.take(1))))
    expect(calls).toHaveLength(1)
    expect(calculateCost).toHaveBeenCalledTimes(1)
    expect(hooks.cacheWrites).toBe(0)
  })

  it('reuses validated warm calls without repricing', async () => {
    const coldPricing: ScanPricing = { calculateCost: () => 7, calculateLocalModelSavings: () => null }
    const coldCalls = await Effect.runPromise(Stream.runCollect(nativeStream(undefined, coldPricing)))
    hooks.cached = hooks.cachedWrites[0]
    hooks.openCount = 0
    hooks.cacheWrites = 0
    const warmCalculate = vi.fn(() => 99)
    const warmPricing: ScanPricing = { calculateCost: warmCalculate, calculateLocalModelSavings: () => null }

    const warmCalls = await Effect.runPromise(Stream.runCollect(nativeStream(undefined, warmPricing)))

    expect(warmCalls).toEqual(coldCalls)
    expect(warmCalculate).not.toHaveBeenCalled()
    expect(hooks.openCount).toBe(0)
    expect(hooks.cacheWrites).toBe(0)
  })

  it('closes its database and preserves the SQLite busy cause on failure', async () => {
    hooks.failRead = true
    await expect(Effect.runPromise(Stream.runCollect(nativeStream()))).rejects.toMatchObject({
      _tag: 'CursorDatabaseError',
      cause: hooks.busyError,
    })
    expect(hooks.closeCount).toBe(1)
  })

  it('checks abort before opening the SQLite database', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(Effect.runPromise(Stream.runCollect(nativeStream(controller.signal)))).rejects.toMatchObject({
      _tag: 'ScanAbortedError',
    })
    expect(hooks.openCount).toBe(0)
  })

  it('closes its database when the scan is aborted while emitting calls', async () => {
    const controller = new AbortController()
    const interrupted = nativeStream(controller.signal).pipe(Stream.tap(() => Effect.sync(() => controller.abort())))
    await expect(Effect.runPromise(Stream.runCollect(interrupted))).rejects.toMatchObject({
      _tag: 'ScanAbortedError',
    })
    expect(hooks.closeCount).toBe(1)
  })

  it('registers cleanup before observing an abort that happens during database acquisition', async () => {
    const controller = new AbortController()
    hooks.onOpen = () => controller.abort()
    await expect(Effect.runPromise(Stream.runCollect(nativeStream(controller.signal)))).rejects.toMatchObject({
      _tag: 'ScanAbortedError',
    })
    expect(hooks.openCount).toBe(1)
    expect(hooks.closeCount).toBe(1)
  })

  it('rejects cached calls with invalid consumed fields and reparses the database', async () => {
    hooks.cached = [{ provider: 'cursor', deduplicationKey: 'bad-cache-entry' }]
    const calls = await Effect.runPromise(Stream.runCollect(nativeStream()))
    expect(calls).toHaveLength(2)
    expect(hooks.openCount).toBe(1)
    expect(calls.some(call => call.deduplicationKey === 'bad-cache-entry')).toBe(false)
  })

  it('skips a bubble with an invalid selected field and ignores an unused alternative field', async () => {
    hooks.invalidInputTokens = true
    const calls = await Effect.runPromise(Stream.runCollect(nativeStream()))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.deduplicationKey).toContain(':two')
  })

  it('keeps user prompts with NULL timestamps available for pairing', async () => {
    hooks.includeNullTimestampPrompt = true
    const calls = await Effect.runPromise(Stream.runCollect(nativeStream()))
    expect(calls[0]?.userMessage).toContain('prompt with null timestamp')
  })

  it('discovers the catch-all source through the native Effect hook', async () => {
    const root = mkdtempSync(join(tmpdir(), 'watchtower-cursor-effect-discovery-'))
    try {
      const globalStorage = join(root, 'User', 'globalStorage')
      mkdirSync(globalStorage, { recursive: true })
      const dbPath = join(globalStorage, 'state.vscdb')
      writeFileSync(dbPath, '')
      const provider = createCursorProvider(dbPath)
      if (!provider.discoverSessionsEffect) throw new Error('Cursor provider did not expose native discovery')
      const sources = await Effect.runPromise(
        provider
          .discoverSessionsEffect()
          .pipe(Effect.provide(Env.layerWithGatewayKey(null)), Effect.provide(NodeFileSystem.layer)),
      )
      expect(sources).toEqual([{ path: `${dbPath}#cursor-ws=__orphan__`, project: 'cursor', provider: 'cursor' }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
