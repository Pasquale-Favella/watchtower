import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  openCount: 0,
  closeCount: 0,
  failRead: false,
  invalidInputTokens: false,
  includeNullTimestampPrompt: false,
  onOpen: undefined as (() => void) | undefined,
  cached: null as unknown,
  busyError: new Error('SQLITE_BUSY: database is locked'),
}))

vi.mock('../src/main/pipeline/sqlite.js', () => ({
  isSqliteAvailable: () => true,
  isSqliteBusyError: (error: unknown) =>
    error === hooks.busyError || (error instanceof Error && error.cause === hooks.busyError),
  blobToText: (value: Uint8Array | string | null) => (value == null ? '' : String(value)),
  openDatabase: () => {
    hooks.openCount++
    hooks.onOpen?.()
    return {
      query: (sql: string) => {
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

vi.mock('../src/main/pipeline/cursor-cache.js', () => ({
  readCachedResults: async () => hooks.cached,
  writeCachedResults: async () => undefined,
}))

import { Env } from '../src/main/env.js'
import { clearCursorWorkspaceMapCache, createCursorProvider } from '../src/main/pipeline/providers/cursor.js'
import type { ParsedProviderCall, SessionSource } from '../src/main/pipeline/providers/types.js'

function source(): SessionSource {
  return { path: 'cursor-test-db', project: 'cursor', provider: 'cursor' }
}

function parser(signal?: AbortSignal) {
  return createCursorProvider().createSessionParser(source(), new Set(), undefined, { signal })
}

function nativeStream(signal?: AbortSignal): Stream.Stream<ParsedProviderCall, Error> {
  const stream = parser(signal).parseStream
  if (!stream) throw new Error('Cursor parser did not expose its native stream')
  return stream()
}

beforeEach(() => {
  hooks.openCount = 0
  hooks.closeCount = 0
  hooks.failRead = false
  hooks.invalidInputTokens = false
  hooks.includeNullTimestampPrompt = false
  hooks.onOpen = undefined
  hooks.cached = null
  clearCursorWorkspaceMapCache()
})

afterEach(() => {
  vi.restoreAllMocks()
  clearCursorWorkspaceMapCache()
})

describe('Cursor native Effect stream', () => {
  it('closes its database when the stream reaches EOF', async () => {
    const calls = await Effect.runPromise(Stream.runCollect(nativeStream()))
    expect(calls).toHaveLength(2)
    expect(hooks.openCount).toBe(1)
    expect(hooks.closeCount).toBe(1)
  })

  it('closes its database when a consumer stops early', async () => {
    const calls = await Effect.runPromise(Stream.runCollect(nativeStream().pipe(Stream.take(1))))
    expect(calls).toHaveLength(1)
    expect(hooks.closeCount).toBe(1)
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
        provider.discoverSessionsEffect().pipe(Effect.provide(Env.layerWithGatewayKey(null))),
      )
      expect(sources).toEqual([{ path: `${dbPath}#cursor-ws=__orphan__`, project: 'cursor', provider: 'cursor' }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
