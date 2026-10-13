import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import { Effect, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  databaseOpens: [] as string[],
  databaseCloses: [] as string[],
  databaseQueries: [] as string[],
  databaseBusyQuery: null as string | null,
  databaseCloseFailurePath: null as string | null,
  requests: [] as Array<{ path: string; body: string }>,
}))

vi.mock('../src/main/pipeline/sqlite.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/pipeline/sqlite.js')>()
  return {
    ...actual,
    openDatabase: (path: string) => {
      hooks.databaseOpens.push(path)
      const db = actual.openDatabase(path)
      return {
        ...db,
        query: <T extends Record<string, unknown>>(sql: string) => {
          hooks.databaseQueries.push(sql)
          if (hooks.databaseBusyQuery && sql.includes(hooks.databaseBusyQuery)) {
            throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
          }
          return db.query<T>(sql)
        },
        close: () => {
          hooks.databaseCloses.push(path)
          db.close()
          if (hooks.databaseCloseFailurePath === path) throw new Error('SQLite close failure')
        },
      }
    },
  }
})

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      callback(
        null,
        'language_server_antigravity --https_server_port 43125 --csrf_token conversationeffecttoken123 --app_data_dir antigravity-cli',
      )
      return {} as ReturnType<typeof actual.execFile>
    },
  }
})

vi.mock('https', async importOriginal => {
  const actual = await importOriginal<typeof import('node:https')>()
  class Emitter {
    private readonly listeners = new Map<string, Array<(value?: Buffer) => void>>()
    destroyed = false

    on(event: string, listener: (value?: Buffer) => void): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      return this
    }

    once(event: string, listener: (value?: Buffer) => void): this {
      const wrapped = (value?: Buffer): void => {
        this.listeners.set(
          event,
          (this.listeners.get(event) ?? []).filter(existing => existing !== wrapped),
        )
        listener(value)
      }
      return this.on(event, wrapped)
    }

    emit(event: string, value?: Buffer): void {
      for (const listener of this.listeners.get(event) ?? []) listener(value)
    }

    destroy(): void {
      this.destroyed = true
      queueMicrotask(() => this.emit('close'))
    }
  }
  const request = (options: { path: string }, onResponse: (response: Emitter & { statusCode: number }) => void) => {
    const req = new Emitter() as Emitter & { write: (value: string) => void; end: () => void }
    let body = ''
    const recorded = { path: options.path, body: '' }
    hooks.requests.push(recorded)
    req.write = value => {
      body += value
      recorded.body = body
    }
    req.end = () => {
      const response = Object.assign(new Emitter(), { statusCode: 200 })
      onResponse(response)
      queueMicrotask(() => {
        const payload = options.path.endsWith('GetAvailableModels')
          ? {
              models: {
                'gemini-3-pro': { model: 'gemini-3-pro', displayName: 'Gemini 3 Pro' },
                'mapped-model': { model: '99', displayName: 'Gemini 3 Pro' },
                unused: null,
              },
            }
          : {
              generatorMetadata: [
                {
                  chatModel: {
                    usage: {
                      model: 99,
                      inputTokens: '10',
                      outputTokens: '5',
                      responseOutputTokens: '5',
                      responseId: 123,
                      apiProvider: { malformed: true },
                    },
                    chatStartMetadata: { createdAt: null, unused: 'malformed but ignored' },
                  },
                },
                {
                  chatModel: {
                    usage: {
                      model: 'gemini-3-pro',
                      inputTokens: '11',
                      outputTokens: '5',
                      responseOutputTokens: '5',
                      responseId: 'rpc-invalid-timestamp',
                      apiProvider: { malformed: true },
                    },
                    chatStartMetadata: { createdAt: 42 },
                  },
                },
                {
                  chatModel: {
                    usage: {
                      model: 100,
                      inputTokens: '12',
                      outputTokens: '5',
                      responseOutputTokens: '5',
                      responseId: 'rpc-unmapped-model',
                    },
                    chatStartMetadata: { createdAt: null },
                  },
                },
              ],
            }
        response.emit('data', Buffer.from(JSON.stringify(payload)))
        response.emit('end')
        req.emit('close')
      })
    }
    return req
  }
  function Agent(): Record<string, never> {
    return {}
  }
  return { ...actual, request, Agent, default: { ...actual, request, Agent } } as unknown as typeof actual
})

import type { SessionSource } from '../src/main/pipeline/providers/types.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'

let root = ''
let provider: typeof import('../src/main/pipeline/providers/antigravity.js')
let appPaths: typeof import('../src/main/env.js')

beforeEach(async () => {
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'watchtower-antigravity-conversation-effect-'))
  hooks.databaseOpens.length = 0
  hooks.databaseCloses.length = 0
  hooks.databaseQueries.length = 0
  hooks.databaseBusyQuery = null
  hooks.databaseCloseFailurePath = null
  hooks.requests.length = 0
  appPaths = await import('../src/main/env.js')
  appPaths.initAppPaths({ cacheDir: root })
  provider = await import('../src/main/pipeline/providers/antigravity.js')
})

afterEach(() => {
  const resolvedRoot = resolve(root)
  if (
    dirname(resolvedRoot) !== resolve(tmpdir()) ||
    !basename(resolvedRoot).startsWith('watchtower-antigravity-conversation-effect-')
  ) {
    throw new Error(`Refusing to remove unexpected Antigravity test directory: ${resolvedRoot}`)
  }
  rmSync(resolvedRoot, { recursive: true, force: true })
})

function source(path: string, project = 'antigravity-cli'): SessionSource {
  return { path, project, provider: 'antigravity' }
}

function encodeVarint(value: number): number[] {
  const bytes: number[] = []
  let remaining = value
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80)
    remaining >>>= 7
  }
  bytes.push(remaining)
  return bytes
}

function varintField(number: number, value: number): number[] {
  return [...encodeVarint(number * 8), ...encodeVarint(value)]
}

function bytesField(number: number, value: Uint8Array): number[] {
  return [...encodeVarint(number * 8 + 2), ...encodeVarint(value.length), ...value]
}

function sqliteMetadata(idx: number, responseId?: string): Uint8Array {
  const usage = [
    ...varintField(2, 10 + idx),
    ...varintField(3, 5),
    ...varintField(9, 5),
    ...(responseId ? bytesField(11, new TextEncoder().encode(responseId)) : []),
  ]
  const chat = [
    ...bytesField(4, Uint8Array.from(usage)),
    ...bytesField(19, new TextEncoder().encode('gemini-3-pro')),
    ...bytesField(21, new TextEncoder().encode('Gemini 3 Pro')),
  ]
  return Uint8Array.from(bytesField(1, Uint8Array.from(chat)))
}

function createSqliteSource(cascadeId: string, workspacePaths?: readonly string[]): string {
  const conversations = join(root, '.gemini', 'antigravity-cli', 'conversations')
  mkdirSync(conversations, { recursive: true })
  const path = join(conversations, `${cascadeId}.db`)
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE gen_metadata (idx INTEGER, data BLOB)')
  db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, sqliteMetadata(1, `${cascadeId}-one`))
  db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(2, sqliteMetadata(2, `${cascadeId}-two`))
  if (workspacePaths?.length) {
    db.exec('CREATE TABLE trajectory_metadata_blob (data BLOB)')
    const insertWorkspace = db.prepare('INSERT INTO trajectory_metadata_blob (data) VALUES (?)')
    for (const workspacePath of workspacePaths) {
      insertWorkspace.run(Buffer.from(`project_root:${pathToFileURL(workspacePath).href}`))
    }
  }
  db.close()
  return path
}

function testPricing(): { pricing: ScanPricing; calculateCost: ReturnType<typeof vi.fn> } {
  const calculateCost = vi.fn((model: string, inputTokens: number, outputTokens: number) => inputTokens + outputTokens)
  return {
    pricing: { calculateCost, calculateLocalModelSavings: () => null },
    calculateCost,
  }
}

function parserFor(path: string, seen: Set<string>, pricing: ScanPricing, project?: string, signal?: AbortSignal) {
  return provider
    .createAntigravityProvider()
    .createSessionParser(source(path, project ?? 'antigravity-cli'), seen, undefined, {
      pricing,
      signal,
    })
}

describe('Antigravity conversation parser Effects', () => {
  it('streams SQLite facts with workspace and fallback timestamps, then caches only at EOF', async () => {
    const workspacePath = join(root, 'workspace', 'project-name')
    mkdirSync(workspacePath, { recursive: true })
    const path = createSqliteSource('sqlite-stream', [workspacePath, join(root, 'second-workspace')])
    const { pricing, calculateCost } = testPricing()
    const parser = parserFor(path, new Set(), pricing, 'antigravity-ide')
    const parseStream = parser.parseStream
    if (!parseStream) throw new Error('Antigravity native parser stream is unavailable')

    let unparsed = 0
    const calls = await Effect.runPromise(Stream.runCollect(parseStream(Effect.sync(() => (unparsed += 1)))))
    expect(unparsed).toBe(0)
    expect(Array.from(calls)).toMatchObject([
      {
        model: 'gemini-3-pro',
        inputTokens: 11,
        outputTokens: 5,
        project: basename(workspacePath),
        projectPath: workspacePath,
      },
      {
        model: 'gemini-3-pro',
        inputTokens: 12,
        outputTokens: 5,
        project: basename(workspacePath),
        projectPath: workspacePath,
      },
    ])
    expect(calculateCost.mock.calls.map(([model]) => model)).toEqual(['gemini-3-pro', 'gemini-3-pro'])
    expect(hooks.databaseCloses).toEqual(hooks.databaseOpens)
    expect(hooks.databaseOpens).toHaveLength(1)
    expect(hooks.databaseQueries).toHaveLength(2)
    expect(hooks.databaseQueries[0]).toContain('FROM trajectory_metadata_blob')
    expect(hooks.databaseQueries[1]).toContain('FROM gen_metadata')

    await Effect.runPromise(provider.flushAntigravityCacheEffect())
    const cache = JSON.parse(readFileSync(join(root, 'antigravity-results.json'), 'utf8')) as {
      cascades: Record<string, { calls: unknown[] }>
    }
    expect(cache.cascades['sqlite-stream']?.calls).toHaveLength(2)
  })

  it('uses the warm SQLite cache with only the workspace projection', async () => {
    const workspacePath = join(root, 'workspace', 'warm-cache')
    const path = createSqliteSource('sqlite-warm-cache', [workspacePath, join(root, 'workspace', 'second-cache')])
    const { pricing, calculateCost } = testPricing()
    const coldParser = parserFor(path, new Set(), pricing, 'antigravity-ide')
    const coldStream = coldParser.parseStream
    if (!coldStream) throw new Error('Antigravity native parser stream is unavailable')
    const coldCalls = await Effect.runPromise(Stream.runCollect(coldStream()))
    expect(coldCalls).toHaveLength(2)
    expect(Array.from(coldCalls)[0]).toMatchObject({ project: basename(workspacePath), projectPath: workspacePath })

    const warmParser = parserFor(path, new Set(), pricing, 'antigravity-ide')
    const warmStream = warmParser.parseStream
    if (!warmStream) throw new Error('Antigravity native parser stream is unavailable')
    const warmCalls = await Effect.runPromise(Stream.runCollect(warmStream()))
    expect(warmCalls).toHaveLength(2)
    expect(Array.from(warmCalls)[0]).toMatchObject({ project: basename(workspacePath), projectPath: workspacePath })

    expect(calculateCost).toHaveBeenCalledTimes(2)
    expect(hooks.databaseOpens).toHaveLength(2)
    expect(hooks.databaseCloses).toEqual(hooks.databaseOpens)
    expect(hooks.databaseQueries).toHaveLength(3)
    expect(hooks.databaseQueries.map(query => query.includes('FROM gen_metadata'))).toEqual([false, true, false])
  })

  it('falls back to the SQLite file bytes when the optional workspace table is missing', async () => {
    const workspacePath = join(root, 'workspace', 'file-byte-fallback')
    const path = createSqliteSource('sqlite-file-byte-fallback')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE incidental_text (data TEXT)')
    db.prepare('INSERT INTO incidental_text (data) VALUES (?)').run(`project_root:${pathToFileURL(workspacePath).href}`)
    db.close()
    const { pricing } = testPricing()
    const parser = parserFor(path, new Set(), pricing, 'antigravity-ide')
    const parseStream = parser.parseStream
    if (!parseStream) throw new Error('Antigravity native parser stream is unavailable')

    const calls = await Effect.runPromise(Stream.runCollect(parseStream()))
    expect(Array.from(calls)[0]).toMatchObject({ project: basename(workspacePath), projectPath: workspacePath })
    expect(hooks.databaseOpens).toHaveLength(1)
    expect(hooks.databaseCloses).toEqual(hooks.databaseOpens)
  })

  it('does not mark a partially consumed SQLite stream as a complete cache entry', async () => {
    const path = createSqliteSource('sqlite-partial')
    const seen = new Set<string>()
    const { pricing, calculateCost } = testPricing()
    const parser = parserFor(path, seen, pricing)
    const parseStream = parser.parseStream
    if (!parseStream) throw new Error('Antigravity native parser stream is unavailable')

    const iterator = Stream.toAsyncIterable(parseStream())[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(first.value?.deduplicationKey).toBe('antigravity:sqlite-partial:sqlite-partial-one')
    expect(calculateCost).toHaveBeenCalledTimes(1)
    expect(hooks.databaseCloses).toEqual(hooks.databaseOpens)
    await iterator.return?.()

    const nextParser = parserFor(path, seen, pricing)
    const nextStream = nextParser.parseStream
    if (!nextStream) throw new Error('Antigravity native parser stream is unavailable')
    const remaining = await Effect.runPromise(Stream.runCollect(nextStream()))
    expect(Array.from(remaining).map(call => call.deduplicationKey)).toEqual([
      'antigravity:sqlite-partial:sqlite-partial-two',
    ])
    expect(calculateCost).toHaveBeenCalledTimes(3)
    expect(hooks.databaseCloses).toEqual(hooks.databaseOpens)
    expect(hooks.databaseOpens).toHaveLength(2)
    expect(hooks.databaseQueries).toHaveLength(4)
  })

  it('preserves SQLite fallback IDs for nonnumeric index values', async () => {
    const path = createSqliteSource('sqlite-string-index')
    const db = new DatabaseSync(path)
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run('legacy-index', sqliteMetadata(3))
    db.close()
    const { pricing } = testPricing()
    const parser = parserFor(path, new Set(), pricing)
    const parseStream = parser.parseStream
    if (!parseStream) throw new Error('Antigravity native parser stream is unavailable')

    const calls = await Effect.runPromise(Stream.runCollect(parseStream()))
    expect(Array.from(calls).map(call => call.deduplicationKey)).toContain(
      'antigravity:sqlite-string-index:legacy-index',
    )
    expect(hooks.databaseOpens).toHaveLength(1)
    expect(hooks.databaseCloses).toEqual(hooks.databaseOpens)
  })

  it('closes its SQLite snapshot and does not cache when an in-flight parse is interrupted', async () => {
    const path = createSqliteSource('sqlite-interrupted')
    const controller = new AbortController()
    const calculateCost = vi.fn(() => {
      controller.abort()
      return 1
    })
    const pricing: ScanPricing = { calculateCost, calculateLocalModelSavings: () => null }
    const parser = parserFor(path, new Set(), pricing, undefined, controller.signal)
    const parseStream = parser.parseStream
    if (!parseStream) throw new Error('Antigravity native parser stream is unavailable')

    await expect(Effect.runPromise(Stream.runCollect(parseStream()))).rejects.toHaveProperty('name', 'ScanAbortedError')
    expect(hooks.databaseCloses).toEqual(hooks.databaseOpens)
    expect(hooks.databaseOpens).toHaveLength(1)
    await Effect.runPromise(provider.flushAntigravityCacheEffect())
    expect(() => readFileSync(join(root, 'antigravity-results.json'))).toThrow()
  })

  it('propagates a busy generator query after closing the shared snapshot without caching', async () => {
    const path = createSqliteSource('sqlite-busy')
    hooks.databaseBusyQuery = 'FROM gen_metadata'
    const { pricing, calculateCost } = testPricing()
    const parser = parserFor(path, new Set(), pricing)
    const parseStream = parser.parseStream
    if (!parseStream) throw new Error('Antigravity native parser stream is unavailable')

    await expect(Effect.runPromise(Stream.runCollect(parseStream()))).rejects.toMatchObject({
      _tag: 'AntigravityConversationDatabaseError',
      operation: 'read',
    })
    expect(hooks.databaseCloses).toEqual(hooks.databaseOpens)
    expect(hooks.databaseOpens).toHaveLength(1)
    expect(calculateCost).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'antigravity-results.json'))).toBe(false)
  })

  it('propagates a busy workspace query before the generator projection', async () => {
    const path = createSqliteSource('sqlite-workspace-busy')
    hooks.databaseBusyQuery = 'FROM trajectory_metadata_blob'
    const { pricing, calculateCost } = testPricing()
    const parser = parserFor(path, new Set(), pricing)
    const parseStream = parser.parseStream
    if (!parseStream) throw new Error('Antigravity native parser stream is unavailable')

    await expect(Effect.runPromise(Stream.runCollect(parseStream()))).rejects.toMatchObject({
      _tag: 'AntigravityConversationDatabaseError',
      operation: 'read',
      cause: { code: 'SQLITE_BUSY' },
    })
    expect(hooks.databaseCloses).toEqual(hooks.databaseOpens)
    expect(hooks.databaseOpens).toHaveLength(1)
    expect(hooks.databaseQueries).toHaveLength(1)
    expect(hooks.databaseQueries[0]).toContain('FROM trajectory_metadata_blob')
    expect(calculateCost).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'antigravity-results.json'))).toBe(false)
  })

  it('propagates SQLite close failure before pricing or cache publication', async () => {
    const path = createSqliteSource('sqlite-close-failure')
    hooks.databaseCloseFailurePath = path
    const { pricing, calculateCost } = testPricing()
    const parser = parserFor(path, new Set(), pricing)
    const parseStream = parser.parseStream
    if (!parseStream) throw new Error('Antigravity native parser stream is unavailable')

    await expect(Effect.runPromise(Stream.runCollect(parseStream()))).rejects.toMatchObject({
      _tag: 'AntigravityConversationDatabaseError',
      operation: 'close',
    })
    expect(hooks.databaseCloses).toEqual(hooks.databaseOpens)
    expect(hooks.databaseOpens).toHaveLength(1)
    expect(calculateCost).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'antigravity-results.json'))).toBe(false)
  })

  it('keeps pricing callback defects untyped and does not cache the failed parse', async () => {
    const path = createSqliteSource('sqlite-pricing-defect')
    const failedPricing: ScanPricing = {
      calculateCost: () => {
        throw new Error('pricing defect')
      },
      calculateLocalModelSavings: () => null,
    }
    const failedParser = parserFor(path, new Set(), failedPricing)
    const failedStream = failedParser.parseStream
    if (!failedStream) throw new Error('Antigravity native parser stream is unavailable')

    await expect(Effect.runPromise(Stream.runCollect(failedStream()))).rejects.toThrow('pricing defect')
    expect(hooks.databaseCloses).toEqual(hooks.databaseOpens)
    expect(hooks.databaseOpens).toHaveLength(1)
    expect(existsSync(join(root, 'antigravity-results.json'))).toBe(false)

    const { pricing } = testPricing()
    const retryParser = parserFor(path, new Set(), pricing)
    const retryStream = retryParser.parseStream
    if (!retryStream) throw new Error('Antigravity native parser stream is unavailable')
    expect(await Effect.runPromise(Stream.runCollect(retryStream()))).toHaveLength(2)
    expect(hooks.databaseOpens).toHaveLength(2)
  })

  it('keeps valid RPC usage when unused alternatives are malformed', async () => {
    const directory = join(root, '.gemini', 'antigravity-cli', 'conversations')
    mkdirSync(directory, { recursive: true })
    const path = join(directory, 'rpc-selected-fields.pb')
    writeFileSync(path, new Uint8Array())
    const { pricing, calculateCost } = testPricing()
    const parser = parserFor(path, new Set(), pricing)
    const parseStream = parser.parseStream
    if (!parseStream) throw new Error('Antigravity native parser stream is unavailable')

    let unparsed = 0
    const calls = await Effect.runPromise(Stream.runCollect(parseStream(Effect.sync(() => (unparsed += 1)))))
    expect(unparsed).toBe(2)
    expect(Array.from(calls)).toHaveLength(1)
    expect(Array.from(calls)[0]).toMatchObject({
      model: 'gemini-3-pro',
      inputTokens: 10,
      outputTokens: 5,
      costUSD: 15,
      deduplicationKey: 'antigravity:rpc-selected-fields:123',
    })
    expect(calculateCost).toHaveBeenCalledTimes(1)
    expect(calculateCost).toHaveBeenCalledWith('gemini-3-pro', 10, 5, 0, 0, 0)
    expect(hooks.requests.map(request => request.path.endsWith('GetCascadeTrajectoryGeneratorMetadata'))).toEqual([
      false,
      true,
    ])
  })
})
