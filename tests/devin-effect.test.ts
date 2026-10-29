import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Cause, Effect, Exit, Option, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nativeIo = vi.hoisted(() => ({
  home: '',
  reads: [] as string[],
  stats: [] as string[],
  readdirs: [] as string[],
  opened: [] as string[],
  closed: 0,
  closeError: undefined as Error | undefined,
  capPath: undefined as string | undefined,
  pendingPath: undefined as string | undefined,
  readStarted: undefined as (() => void) | undefined,
  releaseRead: undefined as ((value: string) => void) | undefined,
}))

vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => nativeIo.home || actual.homedir() }
})

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    readdir: (...args: Parameters<typeof actual.readdir>) => {
      nativeIo.readdirs.push(String(args[0]))
      return actual.readdir(...args)
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const path = String(args[0])
      nativeIo.stats.push(path)
      const result = await actual.stat(...args)
      if (path === nativeIo.capPath) return { ...result, size: 128 * 1024 * 1024 + 1 } as typeof result
      return result
    },
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      const path = String(args[0])
      nativeIo.reads.push(path)
      if (path !== nativeIo.pendingPath) return actual.readFile(...args)
      nativeIo.readStarted?.()
      return new Promise<string>(resolve => {
        nativeIo.releaseRead = resolve
      }) as ReturnType<typeof actual.readFile>
    },
  }
})

vi.mock('../src/infrastructure/ingestion/sqlite.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/infrastructure/ingestion/sqlite.js')>()
  return {
    ...actual,
    openDatabase(path: string) {
      nativeIo.opened.push(path)
      const db = actual.openDatabase(path)
      return {
        query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
          return db.query<T>(sql, params)
        },
        close() {
          nativeIo.closed++
          db.close()
          if (nativeIo.closeError) throw nativeIo.closeError
        },
      }
    },
  }
})

import { Env } from '../src/infrastructure/config/environment.js'
import { MAX_SESSION_FILE_BYTES } from '../src/infrastructure/ingestion/fs-utils.js'
import { createDevinProvider } from '../src/infrastructure/provider-adapters/devin.js'
import type {
  ParsedProviderCall,
  Provider,
  SessionParser,
  SessionSource,
} from '../src/infrastructure/provider-adapters/types.js'
import { ScanAbortedError } from '../src/core/ingestion/reconciliation/scan-control.js'

let root = ''
let cliDir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-devin-effect-'))
  cliDir = join(root, 'devin', 'cli')
  mkdirSync(join(cliDir, 'transcripts'), { recursive: true })
  nativeIo.home = join(root, 'home')
  nativeIo.reads.length = 0
  nativeIo.stats.length = 0
  nativeIo.readdirs.length = 0
  nativeIo.opened.length = 0
  nativeIo.closed = 0
  nativeIo.closeError = undefined
  nativeIo.capPath = undefined
  nativeIo.pendingPath = undefined
  nativeIo.readStarted = undefined
  nativeIo.releaseRead = undefined
})

afterEach(() => {
  nativeIo.pendingPath = undefined
  nativeIo.readStarted = undefined
  nativeIo.releaseRead = undefined
  rmSync(root, { recursive: true, force: true })
})

function writeConfig(value: unknown = { devin: { acuUsdRate: 0.05 } }): string {
  const path = join(nativeIo.home, '.config', 'watchtower', 'config.json')
  mkdirSync(join(nativeIo.home, '.config', 'watchtower'), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
  return path
}

type DbRow = {
  id: string
  workingDirectory?: string
  model?: string
  title?: string | null
  createdAt?: number
  lastActivityAt?: number
  hidden?: number | string
}

function writeDatabase(rows: DbRow[] = []): string {
  const path = join(cliDir, 'sessions.db')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE sessions(
    id TEXT, working_directory TEXT, model TEXT, title TEXT,
    created_at REAL, last_activity_at REAL, hidden INTEGER
  )`)
  const insert = db.prepare(
    'INSERT INTO sessions(id, working_directory, model, title, created_at, last_activity_at, hidden) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  for (const row of rows) {
    insert.run(
      row.id,
      row.workingDirectory ?? '',
      row.model ?? '',
      row.title ?? null,
      row.createdAt ?? 1_750_000_000,
      row.lastActivityAt ?? 1_750_000_100,
      row.hidden ?? 0,
    )
  }
  db.close()
  return path
}

function writeTranscript(name: string, value: unknown): string {
  const path = join(cliDir, 'transcripts', name)
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
  return path
}

function source(path: string): SessionSource {
  return { path, project: 'fallback-project', provider: 'devin' }
}

function discovery(provider: Provider, signal?: AbortSignal) {
  if (!provider.discoverSessionsEffect) throw new Error('Devin provider did not expose native discovery')
  return provider.discoverSessionsEffect(signal ? { signal } : undefined).pipe(Effect.provide(Env.layer))
}

function parser(value: SessionParser): NonNullable<SessionParser['parseStream']> {
  if (!value.parseStream) throw new Error('Devin parser did not expose its native stream')
  return value.parseStream
}

async function collect(value: SessionParser): Promise<ParsedProviderCall[]> {
  return [...(await Effect.runPromise(Stream.runCollect(parser(value)())))]
}

function fixtureTranscript(): Record<string, unknown> {
  return {
    schema_version: 'ATIF-v1.7',
    session_id: 'session-one',
    agent: { name: 'Devin', version: '1', model_name: 'gpt-4.1' },
    ignored_sibling: { preservedByTolerance: true },
    steps: [
      { step_id: 1, message: 'First question', metadata: { is_user_input: true } },
      {
        step_id: 2,
        model_name: 'MODEL_FALLBACK',
        message: [
          { type: 'text', text: 'Answer' },
          { type: 'image', source: { path: '/tmp/image.png' } },
        ],
        tool_calls: [{ function_name: 'search' }],
        metadata: {
          created_at: '2025-05-01T12:00:00.000Z',
          committed_acu_cost: 3,
          generation_model: 'gpt-5-3-high',
          metrics: { input_tokens: 99 },
        },
        extra: { committed_acu_cost: 4 },
        metrics: {
          prompt_tokens: 10,
          completion_tokens: 7,
          cached_tokens: 2,
          extra: { cache_creation_input_tokens: 1 },
        },
      },
    ],
  }
}

describe('Devin native Effect provider', () => {
  it('keeps the rate-first discovery gate, filters hidden sessions, and captures directory entries in order', async () => {
    const config = writeConfig({ devin: { acuUsdRate: 0 } })
    const provider = createDevinProvider(cliDir)
    await expect(Effect.runPromise(discovery(provider))).resolves.toEqual([])
    expect(nativeIo.readdirs).toEqual([])
    expect(nativeIo.opened).toEqual([])

    writeConfig({ devin: { acuUsdRate: 0.05 }, unrelated: { ignored: true } })
    writeDatabase([
      { id: 'visible', workingDirectory: '/work/visible' },
      { id: 'hidden', workingDirectory: '/work/hidden', hidden: 1 },
    ])
    const visiblePath = writeTranscript('visible.json', fixtureTranscript())
    writeTranscript('hidden.json', fixtureTranscript())
    writeTranscript('ignored.txt', fixtureTranscript())

    const sources = await Effect.runPromise(discovery(provider))
    expect(sources).toEqual([{ path: visiblePath, project: 'visible', provider: 'devin' }])
    expect(nativeIo.readdirs).toContain(join(cliDir, 'transcripts'))
    expect(nativeIo.stats).toContain(visiblePath)
    expect(nativeIo.reads).toContain(config)
    expect(nativeIo.opened).toEqual([join(cliDir, 'sessions.db')])
    expect(nativeIo.closed).toBe(1)
  })

  it('parses validated steps with existing token, ACU, prompt, model, and timestamp precedence', async () => {
    writeConfig()
    writeDatabase([{ id: 'session-one', workingDirectory: '/work/project', model: 'db-model' }])
    const path = writeTranscript('session-one.json', fixtureTranscript())
    const provider = createDevinProvider(cliDir)
    const calls = await collect(provider.createSessionParser(source(path), new Set()))

    expect(calls).toMatchObject([
      {
        provider: 'devin',
        model: 'GPT-5.3 (high)',
        inputTokens: 10,
        outputTokens: 7,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
        tools: ['search'],
        timestamp: '2025-05-01T12:00:00.000Z',
        deduplicationKey: 'devin:session-one:2',
        userMessage: 'First question',
        sessionId: 'session-one',
        project: 'project',
        projectPath: '/work/project',
      },
    ])
    expect(calls[0]?.costUSD).toBeCloseTo(0.15)
    expect(nativeIo.reads.filter(read => read === path)).toHaveLength(1)
  })

  it('applies the readSessionFile size cap before materializing an oversized transcript', async () => {
    writeConfig()
    writeDatabase([{ id: 'session-one' }])
    const path = writeTranscript('session-one.json', fixtureTranscript())
    nativeIo.capPath = path
    const calls = await collect(createDevinProvider(cliDir).createSessionParser(source(path), new Set()))
    expect(calls).toEqual([])
    expect(nativeIo.stats).toContain(path)
    expect(nativeIo.reads).not.toContain(path)
    expect(MAX_SESSION_FILE_BYTES).toBe(128 * 1024 * 1024)
  })

  it('keeps rows accumulated before an out-of-range metadata timestamp and reports DB close errors', async () => {
    writeConfig()
    writeDatabase([
      { id: 'kept', workingDirectory: '/work/kept' },
      { id: 'bad-time', createdAt: 1e100 },
    ])
    const visiblePath = writeTranscript('kept.json', { ...fixtureTranscript(), session_id: 'kept' })
    const provider = createDevinProvider(cliDir)
    await expect(Effect.runPromise(discovery(provider))).resolves.toEqual([
      { path: visiblePath, project: 'kept', provider: 'devin' },
    ])

    nativeIo.closeError = new Error('close failed')
    const closeExit = await Effect.runPromiseExit(discovery(createDevinProvider(cliDir)))
    expect(Exit.isFailure(closeExit)).toBe(true)
    if (Exit.isFailure(closeExit)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(closeExit.cause))?.message).toBe('close failed')
    }
  })

  it('waits for a pending config read to settle before returning typed cancellation', async () => {
    const configPath = writeConfig()
    const controller = new AbortController()
    nativeIo.pendingPath = configPath
    const started = new Promise<void>(resolve => {
      nativeIo.readStarted = resolve
    })
    const exit = Effect.runPromiseExit(discovery(createDevinProvider(cliDir), controller.signal))
    await started
    controller.abort()
    await Promise.resolve()
    expect(nativeIo.releaseRead).toBeDefined()
    nativeIo.releaseRead?.(JSON.stringify({ devin: { acuUsdRate: 0.05 } }))
    const result = await exit
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(Option.getOrUndefined(Cause.findErrorOption(result.cause))).toBeInstanceOf(ScanAbortedError)
    }
  })

  it('skips malformed transcripts and tallies malformed billable steps without unsafe coercion', async () => {
    writeConfig()
    writeDatabase([{ id: 'session-one' }])
    const badJson = writeTranscript('invalid.json', '{not-json')
    const path = writeTranscript('session-one.json', {
      session_id: 'session-one',
      steps: [
        { step_id: 'bad-id', metadata: { committed_acu_cost: 1 }, tool_calls: [{ function_name: 7 }] },
        { step_id: 2, metadata: { committed_acu_cost: 1 }, message: 'valid' },
      ],
    })
    const provider = createDevinProvider(cliDir)
    const seen = new Set<string>()
    let unparsed = 0
    const invalidCalls = await collect(provider.createSessionParser(source(badJson), seen))
    const parserValue = provider.createSessionParser(source(path), seen)
    const calls = await Effect.runPromise(
      Stream.runCollect(
        parser(parserValue)(
          Effect.sync(() => {
            unparsed++
          }),
        ),
      ),
    )
    expect(invalidCalls).toEqual([])
    expect(calls).toHaveLength(1)
    expect(unparsed).toBe(1)
    expect(calls[0]?.timestamp).toBe(new Date(1_750_000_100 * 1000).toISOString())
  })

  it('retains string and missing step IDs and truthy user flags in accepted calls', async () => {
    writeConfig()
    writeDatabase([{ id: 'session-one' }])
    const path = writeTranscript('session-one.json', {
      session_id: 'session-one',
      steps: [
        { message: 'Retained prompt', metadata: { is_user_input: 1 } },
        {
          step_id: 'text-id',
          metadata: { committed_acu_cost: 1 },
          tool_calls: [{ function_name: '' }, { function_name: 'Read' }],
        },
        { metadata: { committed_acu_cost: 1 } },
      ],
    })
    const calls = await collect(createDevinProvider(cliDir).createSessionParser(source(path), new Set()))

    expect(calls).toMatchObject([
      { deduplicationKey: 'devin:session-one:text-id', userMessage: 'Retained prompt', tools: ['', 'Read'] },
      { deduplicationKey: 'devin:session-one:undefined', userMessage: 'Retained prompt', tools: [] },
    ])
  })

  it('keeps truthy SQLite hidden flags and null numeric timestamps', async () => {
    writeConfig()
    const dbPath = writeDatabase([{ id: 'hidden', hidden: 'yes' }, { id: 'visible' }])
    const db = new DatabaseSync(dbPath)
    db.prepare('UPDATE sessions SET created_at = NULL, last_activity_at = NULL WHERE id = ?').run('visible')
    db.close()
    writeTranscript('hidden.json', {
      session_id: 'hidden',
      steps: [{ step_id: 1, metadata: { committed_acu_cost: 1 } }],
    })
    const path = writeTranscript('visible.json', {
      session_id: 'visible',
      steps: [{ step_id: 1, metadata: { committed_acu_cost: 1 } }],
    })
    const provider = createDevinProvider(cliDir)

    expect(await Effect.runPromise(discovery(provider))).toEqual([{ path, project: 'devin', provider: 'devin' }])
    expect(await collect(provider.createSessionParser(source(path), new Set()))).toMatchObject([
      { timestamp: '1970-01-01T00:00:00.000Z' },
    ])
    expect(nativeIo.opened).toEqual([dbPath])
    expect(nativeIo.closed).toBe(1)
  })

  it('preserves canonical rejection of a null stored project path', async () => {
    writeConfig()
    const dbPath = writeDatabase([{ id: 'session-one', title: 'Stored title' }])
    const db = new DatabaseSync(dbPath)
    db.prepare('UPDATE sessions SET working_directory = NULL WHERE id = ?').run('session-one')
    db.close()
    const path = writeTranscript('session-one.json', {
      session_id: 'session-one',
      steps: [{ step_id: 1, metadata: { committed_acu_cost: 1 } }],
    })
    const provider = createDevinProvider(cliDir)
    expect(await Effect.runPromise(discovery(provider))).toEqual([{ path, project: 'Stored title', provider: 'devin' }])
    let unparsed = 0
    const calls = await Effect.runPromise(
      Stream.runCollect(
        parser(provider.createSessionParser(source(path), new Set()))(
          Effect.sync(() => {
            unparsed++
          }),
        ),
      ),
    )
    expect(calls).toEqual([])
    expect(unparsed).toBe(1)
  })
})
