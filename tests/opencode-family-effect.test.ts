import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Cause, Effect, Exit, Stream } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createSqliteSessionParser,
  discoverSqliteSessionsEffect,
  OPENCODE_FAMILY_1X,
  OPENCODE_FAMILY_2X,
  type SqliteProviderConfig,
} from '../src/main/pipeline/providers/opencode-family-sqlite.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'
import * as sqlite from '../src/main/pipeline/sqlite.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(generation: '1x' | '2x'): { config: SqliteProviderConfig; source: string } {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-opencode-effect-'))
  temporaryDirectories.push(directory)
  const databasePath = join(directory, 'opencode.db')
  const db = new DatabaseSync(databasePath)
  if (generation === '1x') {
    db.exec(
      'CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created REAL, time_archived REAL, parent_id TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, model_id TEXT);' +
        'CREATE TABLE message (session_id TEXT, id TEXT, time_created REAL, data BLOB);' +
        'CREATE TABLE part (session_id TEXT, message_id TEXT, id TEXT, data BLOB);',
    )
    db.prepare('INSERT INTO session (id, directory, title, time_created, model_id) VALUES (?, ?, ?, ?, ?)').run(
      'session-1',
      '/workspace/project',
      'fixture',
      1_750_000_000,
      'test-model',
    )
    const insertMessage = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
    insertMessage.run('session-1', 'user-1', 1_750_000_000, JSON.stringify({ role: 'user' }))
    insertMessage.run(
      'session-1',
      'assistant-1',
      1_750_000_001,
      JSON.stringify({ role: 'assistant', modelID: 'test-model', tokens: { input: 7, output: 4, reasoning: 2 } }),
    )
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run(
      'session-1',
      'user-1',
      'part-1',
      JSON.stringify({ type: 'text', text: 'hello' }),
    )
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run(
      'session-1',
      'assistant-1',
      'part-2',
      JSON.stringify({ type: 'tool', tool: 'bash', state: { input: { command: 'git status' } } }),
    )
  } else {
    db.exec(
      'CREATE TABLE session_v2 (id TEXT, directory TEXT, title TEXT, time_created REAL, time_archived REAL, parent_id TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, model_id TEXT);' +
        'CREATE TABLE session_message (session_id TEXT, id TEXT, type TEXT, seq INTEGER, time_created REAL, data BLOB);',
    )
    db.prepare('INSERT INTO session_v2 (id, directory, title, time_created, model_id) VALUES (?, ?, ?, ?, ?)').run(
      'session-2',
      '/workspace/project',
      'fixture',
      1_750_000_000,
      'test-model',
    )
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(
      'session-2',
      'assistant-2',
      'assistant',
      1,
      1_750_000_001,
      JSON.stringify({
        role: 'assistant',
        model: { id: 'test-model', providerID: 'openai' },
        tokens: { input: 7, output: 4, reasoning: 2 },
        summary: 'response',
      }),
    )
  }
  db.close()
  return {
    config: {
      providerName: 'opencode',
      displayName: 'OpenCode',
      dbDir: directory,
      dbFilePrefix: 'opencode',
      generations: generation === '1x' ? [OPENCODE_FAMILY_1X] : [OPENCODE_FAMILY_2X],
    },
    source: `${databasePath}:${generation === '1x' ? 'session-1' : 'session-2'}`,
  }
}

function pricing(calculateCost: ScanPricing['calculateCost'] = vi.fn(() => 0)): ScanPricing {
  return { calculateCost, calculateLocalModelSavings: () => null }
}

describe('OpenCode family native SQLite Effects', () => {
  it.each(['1x', '2x'] as const)(
    'discovers and parses %s rows with the full canonical projection',
    async generation => {
      const { config, source } = fixture(generation)
      const sessions = await Effect.runPromise(discoverSqliteSessionsEffect(config))
      expect(sessions).toHaveLength(1)
      expect(sessions[0]).toMatchObject({
        path: source,
        project: 'workspace-project',
        workingDirectory: '/workspace/project',
        provider: 'opencode',
      })

      const cost = vi.fn(() => 0.125)
      const seen = new Set<string>()
      const parser = createSqliteSessionParser(sessions[0]!, seen, config, undefined, pricing(cost))
      const calls = await Effect.runPromise(Stream.runCollect(parser.parseStream!()))
      expect(Array.from(calls)).toEqual([
        expect.objectContaining({
          provider: 'opencode',
          inputTokens: 7,
          outputTokens: 4,
          reasoningTokens: 2,
          costUSD: 0.125,
          tools: generation === '1x' ? ['Bash'] : [],
          bashCommands: generation === '1x' ? ['git'] : [],
          userMessage: generation === '1x' ? 'hello' : '',
          model: generation === '1x' ? 'test-model' : 'openai/test-model',
          timestamp: new Date(1_750_000_001_000).toISOString(),
          deduplicationKey: `opencode:${generation === '1x' ? 'session-1:assistant-1' : 'session-2:assistant-2'}`,
          projectPath: '/workspace/project',
          workingDirectory: '/workspace/project',
        }),
      ])
      expect(Array.from(calls)[0]?.assistantText).toBe(generation === '1x' ? 'git status' : undefined)
      expect(cost).toHaveBeenCalledTimes(1)
      expect(seen).toEqual(
        new Set([`opencode:${generation === '1x' ? 'session-1:assistant-1' : 'session-2:assistant-2'}`]),
      )
    },
  )

  it('captures pricing once and evaluates it per pull, closing after early stream termination', async () => {
    const { config, source } = fixture('1x')
    const fixtureDb = new DatabaseSync(join(config.dbDir, 'opencode.db'))
    fixtureDb
      .prepare('INSERT INTO message VALUES (?, ?, ?, ?)')
      .run(
        'session-1',
        'assistant-later',
        1_750_000_002,
        JSON.stringify({ role: 'assistant', modelID: 'later-model', tokens: { input: 9, output: 6 } }),
      )
    fixtureDb.close()
    const originalOpen = sqlite.openDatabase
    const close = vi.fn()
    vi.spyOn(sqlite, 'openDatabase').mockImplementation(path => {
      const db = originalOpen(path)
      return {
        query: db.query.bind(db),
        close: () => {
          close()
          db.close()
        },
      }
    })
    const calculateCost = vi.fn((model: string) => {
      if (model === 'later-model') throw new Error('later pricing must not run')
      return 0.25
    })
    const captured = pricing(calculateCost)
    const seen = new Set<string>()
    const parser = createSqliteSessionParser(
      { path: source, project: 'fixture', provider: 'opencode' },
      seen,
      config,
      undefined,
      undefined,
      { pricing: captured },
    )
    const stream = parser.parseStream!()
    expect(calculateCost).not.toHaveBeenCalled()
    const first = await Effect.runPromise(Stream.runHead(stream))
    expect(first._tag).toBe('Some')
    expect(calculateCost).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(new Set(['opencode:session-1:assistant-1']))
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('preserves native close-error identity when the legacy iterator stops early', async () => {
    const { config, source } = fixture('1x')
    const originalOpen = sqlite.openDatabase
    const closeError = new Error('early close failed')
    const close = vi.fn()
    vi.spyOn(sqlite, 'openDatabase').mockImplementation(path => {
      const db = originalOpen(path)
      return {
        query: db.query.bind(db),
        close: () => {
          close()
          db.close()
          throw closeError
        },
      }
    })
    const createParser = () =>
      createSqliteSessionParser(
        { path: source, project: 'fixture', provider: 'opencode' },
        new Set(),
        config,
        undefined,
        pricing(),
      )
    const iterator = createParser().parse()
    expect((await iterator.next()).done).toBe(false)
    await expect(iterator.return(undefined)).rejects.toBe(closeError)
    expect(close).toHaveBeenCalledTimes(1)

    // A scope finalizer cannot declare a typed failure. Early native stop
    // reports that cleanup defect; the compatibility adapter unwraps it.
    const exit = await Effect.runPromise(Effect.exit(Stream.runHead(createParser().parseStream!())))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true)
      expect(Cause.squash(exit.cause)).toMatchObject({ operation: 'close', cause: closeError })
    }
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('keeps close failures in the typed stream error channel at normal completion', async () => {
    const { config, source } = fixture('1x')
    const originalOpen = sqlite.openDatabase
    const closeError = new Error('close failed')
    vi.spyOn(sqlite, 'openDatabase').mockImplementation(path => {
      const db = originalOpen(path)
      return {
        query: db.query.bind(db),
        close: () => {
          db.close()
          throw closeError
        },
      }
    })
    const parser = createSqliteSessionParser(
      { path: source, project: 'fixture', provider: 'opencode' },
      new Set(),
      config,
      undefined,
      pricing(),
    )

    const result = await Effect.runPromise(Effect.result(Stream.runDrain(parser.parseStream!())))
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') expect(result.failure).toMatchObject({ operation: 'close', message: 'close failed' })

    const iteratorParser = createSqliteSessionParser(
      { path: source, project: 'fixture', provider: 'opencode' },
      new Set(),
      config,
      undefined,
      pricing(),
    )
    const iterator = iteratorParser.parse()
    try {
      await iterator.next()
      await expect(iterator.next()).rejects.toBe(closeError)
    } finally {
      await iterator.return(undefined)
    }
  })

  it('keeps an open failure on the legacy empty-source path', async () => {
    const { config, source } = fixture('1x')
    vi.spyOn(sqlite, 'openDatabase').mockImplementation(() => {
      throw new Error('open failed')
    })
    const parser = createSqliteSessionParser(
      { path: source, project: 'fixture', provider: 'opencode' },
      new Set(),
      config,
      undefined,
      pricing(),
    )
    const calls = await Effect.runPromise(Stream.runCollect(parser.parseStream!()))
    expect(Array.from(calls)).toEqual([])
  })

  it('preserves legacy close-over-read precedence and keeps read failures typed when close succeeds', async () => {
    const { config, source } = fixture('1x')
    const originalOpen = sqlite.openDatabase
    const readError = new Error('read failed')
    const closeError = new Error('close replaced read')
    let closeFails = true
    vi.spyOn(sqlite, 'openDatabase').mockImplementation(path => {
      const db = originalOpen(path)
      return {
        query: (sql, params) => {
          if (sql.includes('WITH RECURSIVE session_tree') && sql.includes('FROM message')) throw readError
          return db.query(sql, params)
        },
        close: () => {
          db.close()
          if (closeFails) throw closeError
        },
      }
    })
    const parser = createSqliteSessionParser(
      { path: source, project: 'fixture', provider: 'opencode' },
      new Set(),
      config,
      undefined,
      pricing(),
    )
    const result = await Effect.runPromise(Effect.result(Stream.runDrain(parser.parseStream!())))
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure')
      expect(result.failure).toMatchObject({ operation: 'close', message: closeError.message })

    closeFails = false
    const readParser = createSqliteSessionParser(
      { path: source, project: 'fixture', provider: 'opencode' },
      new Set(),
      config,
      undefined,
      pricing(),
    )
    const readResult = await Effect.runPromise(Effect.result(Stream.runDrain(readParser.parseStream!())))
    expect(readResult._tag).toBe('Failure')
    if (readResult._tag === 'Failure')
      expect(readResult.failure).toMatchObject({ operation: 'read', message: readError.message })
  })
})
