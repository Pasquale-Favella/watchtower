import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect, Stream } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { Env } from '../src/main/env.js'
import { setPriceOverrides } from '../src/main/pipeline/models.js'
import { createQuickdeskProvider } from '../src/main/pipeline/providers/quickdesk.js'
import type { ParsedProviderCall, SessionParser, SessionSource } from '../src/main/pipeline/providers/types.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'
import { estimateTokensFromChars } from '../src/main/pipeline/token-estimate.js'

const directories: string[] = []

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-quickdesk-effect-'))
  directories.push(directory)
  return directory
}

function providerAt(root: string) {
  return createQuickdeskProvider(root)
}

function fixedPricing(cost: number): ScanPricing {
  return {
    calculateCost: () => cost,
    calculateLocalModelSavings: () => null,
  }
}

function makeMetricsSource(path: string, sourcePath = resolve(path, '..', '..')): SessionSource {
  return { path, project: 'fixture', provider: 'quickdesk', sourceId: 'metrics', sourcePath }
}

function makeDatabaseSource(path: string, sourcePath: string): SessionSource {
  return { path, project: 'fixture', provider: 'quickdesk', sourceId: 'sessions-db', sourcePath }
}

function parseStream(parser: SessionParser): Stream.Stream<ParsedProviderCall, Error> {
  if (!parser.parseStream) throw new Error('QuickDesk parser did not provide parseStream')
  return parser.parseStream()
}

async function collect(parser: SessionParser): Promise<ParsedProviderCall[]> {
  return Array.from(await Effect.runPromise(Stream.runCollect(parseStream(parser))))
}

function createDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE sessions (id TEXT, created_at INTEGER, deleted_at TEXT);
    CREATE TABLE session_messages (
      session_id TEXT,
      role TEXT,
      content TEXT,
      tool_names TEXT,
      timestamp INTEGER
    );`)
  return db
}

afterEach(() => {
  setPriceOverrides({})
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('QuickDesk Effect provider', () => {
  it('discovers profiles in manifest order, sorted metrics before each database, and the legacy root once', async () => {
    const root = tempDirectory()
    const first = join(root, 'profiles', 'first')
    const second = join(root, 'profiles', 'second')
    mkdirSync(join(first, 'metrics'), { recursive: true })
    mkdirSync(join(first, 'sessions'), { recursive: true })
    mkdirSync(join(second, 'metrics'), { recursive: true })
    mkdirSync(join(second, 'sessions'), { recursive: true })
    mkdirSync(join(root, 'sessions'), { recursive: true })
    writeFileSync(
      join(root, 'profiles.json'),
      JSON.stringify({
        entries: [
          { id: 'first-profile', data_path: 'profiles/first' },
          { id: 'duplicate', data_path: first },
          { id: 'second-profile', data_path: 'profiles/second' },
          { id: 'bad-sibling', data_path: 2 },
        ],
      }),
    )
    writeFileSync(join(first, 'metrics', 'metrics-2026-02-01.jsonl'), '')
    writeFileSync(join(first, 'metrics', 'metrics-2026-01-01.jsonl'), '')
    writeFileSync(join(first, 'metrics', 'metrics-2026-13-01.jsonl'), '')
    writeFileSync(join(second, 'metrics', 'metrics-2026-03-01.jsonl'), '')
    writeFileSync(join(first, 'sessions', 'sessions.db'), '')
    writeFileSync(join(second, 'sessions', 'sessions.db'), '')
    writeFileSync(join(root, 'sessions', 'sessions.db'), '')

    const discovered = await providerAt(root).discoverSessionsEffect?.()
    if (!discovered) throw new Error('QuickDesk provider did not provide discoverSessionsEffect')
    const sources = await Effect.runPromise(discovered.pipe(Effect.provide(Env.layer)))

    expect(sources.map(source => [source.project, source.sourceId, source.path])).toEqual([
      ['first-profile', 'metrics', join(first, 'metrics', 'metrics-2026-01-01.jsonl')],
      ['first-profile', 'metrics', join(first, 'metrics', 'metrics-2026-02-01.jsonl')],
      ['first-profile', 'metrics', join(first, 'metrics', 'metrics-2026-13-01.jsonl')],
      ['first-profile', 'sessions-db', join(first, 'sessions', 'sessions.db')],
      ['second-profile', 'metrics', join(second, 'metrics', 'metrics-2026-03-01.jsonl')],
      ['second-profile', 'sessions-db', join(second, 'sessions', 'sessions.db')],
      ['default', 'sessions-db', join(root, 'sessions', 'sessions.db')],
    ])
    expect(await providerAt(root).probeRoots?.()).toEqual([
      { path: first, label: 'first-profile' },
      { path: second, label: 'second-profile' },
      { path: root, label: 'default' },
    ])
  })

  it.each(['{malformed json', JSON.stringify({ entries: [] }), JSON.stringify({ entries: [null] })])(
    'falls back to the legacy root for an unusable profile manifest: %s',
    async manifest => {
      const root = tempDirectory()
      mkdirSync(join(root, 'metrics'), { recursive: true })
      writeFileSync(join(root, 'metrics', 'metrics-2026-01-01.jsonl'), '')
      writeFileSync(join(root, 'profiles.json'), manifest)

      const discovered = await providerAt(root).discoverSessionsEffect?.()
      if (!discovered) throw new Error('QuickDesk provider did not provide discoverSessionsEffect')
      const sources = await Effect.runPromise(discovered.pipe(Effect.provide(Env.layer)))

      expect(sources).toEqual([
        {
          path: join(root, 'metrics', 'metrics-2026-01-01.jsonl'),
          project: 'default',
          provider: 'quickdesk',
          sourceId: 'metrics',
          sourcePath: root,
        },
      ])
    },
  )

  it('keeps malformed metric siblings isolated, recorded zero exact, fallback pricing captured, and tools attributed', async () => {
    const root = tempDirectory()
    const metricsPath = join(root, 'metrics', 'metrics-2026-01-02.jsonl')
    mkdirSync(join(root, 'metrics'), { recursive: true })
    writeFileSync(
      metricsPath,
      [
        '{malformed json',
        JSON.stringify({ ToolName: 'read_file', session_id: 'recorded-session' }),
        JSON.stringify({
          Model: 'recorded-model',
          InputTokens: 10,
          OutputTokens: 4,
          CostUSD: 0,
          session_id: 'recorded-session',
          _aws: { Timestamp: 1_767_312_000_000 },
        }),
        JSON.stringify({ Model: 'fallback-model', InputTokens: 20, OutputTokens: 5, CostUSD: -1 }),
        JSON.stringify({ Model: 'invalid-sibling', InputTokens: -1, OutputTokens: 5 }),
      ].join('\n'),
    )

    const calls = await collect(
      providerAt(root).createSessionParser(makeMetricsSource(metricsPath, root), new Set(), undefined, {
        pricing: fixedPricing(7.25),
      }),
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      model: 'recorded-model',
      inputTokens: 10,
      outputTokens: 4,
      costUSD: 0,
      costIsEstimated: false,
      tools: ['Read'],
      timestamp: '2026-01-02T00:00:00.000Z',
      sessionId: 'recorded-session',
    })
    expect(calls[1]).toMatchObject({
      model: 'fallback-model',
      costUSD: 7.25,
      costIsEstimated: true,
      timestamp: '2026-01-02T00:00:00.000Z',
    })
  })

  it('emits only unmetered live estimates using cross-profile metrics, message ordering, and mapped tools', async () => {
    const root = tempDirectory()
    const first = join(root, 'profiles', 'first')
    const second = join(root, 'profiles', 'second')
    mkdirSync(join(first, 'sessions'), { recursive: true })
    mkdirSync(join(second, 'metrics'), { recursive: true })
    writeFileSync(
      join(root, 'profiles.json'),
      JSON.stringify({
        entries: [
          { id: 'first', data_path: 'profiles/first' },
          { id: 'second', data_path: 'profiles/second' },
        ],
      }),
    )
    const dbPath = join(first, 'sessions', 'sessions.db')
    const db = createDatabase(dbPath)
    try {
      const session = db.prepare('INSERT INTO sessions (id, created_at, deleted_at) VALUES (?, ?, ?)')
      session.run('metered-elsewhere', 1_750_000_000, null)
      session.run('deleted-session', 1_750_000_001, 'deleted')
      session.run('estimate-seconds', 1_750_000_002, null)
      session.run('estimate-milliseconds', 1_750_000_003_000, null)
      session.run('empty-session', 1_750_000_004, null)
      const message = db.prepare(
        'INSERT INTO session_messages (session_id, role, content, tool_names, timestamp) VALUES (?, ?, ?, ?, ?)',
      )
      message.run('metered-elsewhere', 'user', 'metered', null, 1)
      message.run('deleted-session', 'user', 'deleted prompt', null, 1)
      message.run('estimate-seconds', 'assistant', 'answer', 'shell,read_file', 4)
      message.run('estimate-seconds', 'user', 'hello', null, 2)
      message.run('estimate-milliseconds', 'assistant', 'four', '[]', 1)
      message.run('empty-session', 'user', '', null, 1)
    } finally {
      db.close()
    }
    writeFileSync(
      join(second, 'metrics', 'metrics-2026-01-01.jsonl'),
      `${JSON.stringify({ Model: 'metered-model', InputTokens: 2, OutputTokens: 3, session_id: 'metered-elsewhere' })}\n`,
    )

    const calls = await collect(
      providerAt(root).createSessionParser(makeDatabaseSource(dbPath, first), new Set(), undefined, {
        pricing: fixedPricing(4.5),
      }),
    )

    expect(calls.map(call => call.sessionId)).toEqual(['estimate-seconds', 'estimate-milliseconds'])
    expect(calls[0]).toMatchObject({
      inputTokens: estimateTokensFromChars('hello'.length),
      outputTokens: estimateTokensFromChars('answer'.length),
      costUSD: 4.5,
      costIsEstimated: true,
      timestamp: new Date(1_750_000_002 * 1000).toISOString(),
      tools: ['Bash', 'Read'],
      userMessage: 'hello',
    })
    expect(calls[1]?.timestamp).toBe(new Date(1_750_000_003_000).toISOString())
  })

  it('supports older SQLite projections that omit deletion, timestamp, and tool columns', async () => {
    const root = tempDirectory()
    mkdirSync(join(root, 'sessions'), { recursive: true })
    const dbPath = join(root, 'sessions', 'sessions.db')
    const db = new DatabaseSync(dbPath)
    try {
      db.exec('CREATE TABLE sessions (id TEXT, created_at INTEGER);')
      db.exec('CREATE TABLE session_messages (session_id TEXT, role TEXT, content TEXT);')
      db.prepare('INSERT INTO sessions VALUES (?, ?)').run('legacy-session', 1_750_000_000)
      db.prepare('INSERT INTO session_messages VALUES (?, ?, ?)').run('legacy-session', 'user', 'abcd')
      db.prepare('INSERT INTO session_messages VALUES (?, ?, ?)').run('legacy-session', 'assistant', 'wxyz')
    } finally {
      db.close()
    }

    const calls = await collect(
      providerAt(root).createSessionParser(makeDatabaseSource(dbPath, root), new Set(), undefined, {
        pricing: fixedPricing(2),
      }),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionId: 'legacy-session',
      inputTokens: 1,
      outputTokens: 1,
      tools: [],
      userMessage: 'abcd',
    })
  })

  it('captures fallback prices when the parser is created, before its file reads', async () => {
    const root = tempDirectory()
    const metricsPath = join(root, 'metrics-2026-01-01.jsonl')
    writeFileSync(
      metricsPath,
      `${JSON.stringify({ Model: 'quickdesk-captured-model', InputTokens: 10, OutputTokens: 5 })}\n`,
    )
    const source = makeMetricsSource(metricsPath, root)
    setPriceOverrides({ 'quickdesk-captured-model': { input: 1, output: 1 } })
    const capturedParser = providerAt(root).createSessionParser(source, new Set())
    setPriceOverrides({ 'quickdesk-captured-model': { input: 2, output: 2 } })

    const captured = await collect(capturedParser)
    const fresh = await collect(providerAt(root).createSessionParser(source, new Set()))

    expect(captured[0]?.costUSD).toBeGreaterThan(0)
    expect(fresh[0]?.costUSD).toBe(captured[0]?.costUSD * 2)
  })

  it('closes and materializes the SQLite snapshot before the first pull, then yields one call per pull', async () => {
    const root = tempDirectory()
    mkdirSync(join(root, 'sessions'), { recursive: true })
    const dbPath = join(root, 'sessions', 'sessions.db')
    const db = createDatabase(dbPath)
    try {
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('first', 1_750_000_000, null)
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('second', 1_750_000_001, null)
      db.prepare('INSERT INTO session_messages VALUES (?, ?, ?, ?, ?)').run('first', 'user', 'prompt', null, 1)
      db.prepare('INSERT INTO session_messages VALUES (?, ?, ?, ?, ?)').run('second', 'user', 'prompt', null, 1)
    } finally {
      db.close()
    }

    const parser = providerAt(root).createSessionParser(makeDatabaseSource(dbPath, root), new Set(), undefined, {
      pricing: fixedPricing(1),
    })
    const iterator = Stream.toAsyncIterable(parseStream(parser))[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value?.sessionId).toBe('first')

    const movedPath = join(root, 'sessions', 'moved.db')
    renameSync(dbPath, movedPath)
    const second = await iterator.next()
    expect(second.value?.sessionId).toBe('second')
    await iterator.return?.()
  })

  it('checks cancellation between metric pulls', async () => {
    const root = tempDirectory()
    const metricsPath = join(root, 'metrics-2026-01-01.jsonl')
    writeFileSync(
      metricsPath,
      [
        JSON.stringify({ Model: 'first', InputTokens: 1, OutputTokens: 1 }),
        JSON.stringify({ Model: 'second', InputTokens: 1, OutputTokens: 1 }),
      ].join('\n'),
    )
    const controller = new AbortController()
    const parser = providerAt(root).createSessionParser(makeMetricsSource(metricsPath, root), new Set(), undefined, {
      pricing: fixedPricing(1),
      signal: controller.signal,
    })
    const iterator = Stream.toAsyncIterable(parseStream(parser))[Symbol.asyncIterator]()

    expect((await iterator.next()).value?.model).toBe('first')
    controller.abort()
    await expect(iterator.next()).rejects.toMatchObject({ _tag: 'ScanAbortedError' })
  })
})
