import { Effect, Stream } from 'effect'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ioHooks = vi.hoisted(() => ({
  readPause: undefined as (() => Promise<void>) | undefined,
  onReadStarted: undefined as (() => void) | undefined,
  failedReadPath: undefined as string | undefined,
}))

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]) === ioHooks.failedReadPath) throw new Error('fixture read failure')
      if (ioHooks.readPause) {
        ioHooks.onReadStarted?.()
        await ioHooks.readPause()
      }
      return actual.readFile(...args)
    },
  }
})

import { Env } from '../src/main/env.js'
import type { Provider, SessionParser, SessionSource } from '../src/main/pipeline/providers/types.js'
import { createZerostackProvider } from '../src/main/pipeline/providers/zerostack.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'watchtower-zerostack-effect-'))
})

afterEach(async () => {
  ioHooks.readPause = undefined
  ioHooks.onReadStarted = undefined
  ioHooks.failedReadPath = undefined
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

function discovery(provider: Provider): NonNullable<Provider['discoverSessionsEffect']> {
  if (!provider.discoverSessionsEffect) throw new Error('Zerostack provider did not expose native discovery')
  return provider.discoverSessionsEffect
}

function parserStream(parser: SessionParser): NonNullable<SessionParser['parseStream']> {
  if (!parser.parseStream) throw new Error('Zerostack parser did not expose its native Stream')
  return parser.parseStream
}

function source(path: string): SessionSource {
  return { path, project: 'fixture-project', provider: 'zerostack' }
}

function record(overrides: object = {}) {
  return JSON.stringify({
    id: 'session-id',
    updated_at: '2026-10-01T00:00:02.000Z',
    created_at: '2026-10-01T00:00:01.000Z',
    total_input_tokens: 100,
    total_output_tokens: 50,
    model: 'openrouter/deepseek/deepseek-v4-pro',
    working_dir: '/workspace/project',
    messages: [],
    ...overrides,
  })
}

describe('Zerostack Effect provider', () => {
  it('discovers JSON sessions in directory order, retaining working-directory project names and the data override', async () => {
    const dataDir = join(root, 'data')
    const sessionsDir = join(dataDir, 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(join(sessionsDir, 'second.json'), record({ working_dir: '/workspace/two' }))
    await writeFile(join(sessionsDir, 'first.json'), record({ working_dir: '/workspace/one' }))
    await writeFile(join(sessionsDir, 'invalid.json'), '{bad json')
    await writeFile(join(sessionsDir, 'ignored.jsonl'), record())
    vi.stubEnv('ZS_DATA_DIR', dataDir)

    const discovered = await Effect.runPromise(discovery(createZerostackProvider())().pipe(Effect.provide(Env.layer)))

    const orderedFiles = (await readdir(sessionsDir)).filter(file => file === 'first.json' || file === 'second.json')
    expect(discovered).toEqual(
      orderedFiles.map(file => ({
        path: join(sessionsDir, file),
        project: file === 'first.json' ? 'one' : 'two',
        provider: 'zerostack',
      })),
    )
  })

  it('decodes finite counters and malformed siblings independently while retaining parser mappings', async () => {
    const path = join(root, 'filename-fallback.json')
    await writeFile(
      path,
      record({
        id: null,
        updated_at: null,
        created_at: '2026-10-01T00:00:01.000Z',
        total_input_tokens: 10,
        total_output_tokens: 50,
        messages: [
          null,
          { role: 'user', content: [{ text: 'first' }, null, { text: 42 }, { text: 'question' }] },
          { role: 'user', content: 'later message is ignored' },
          { role: 'assistant', content: 'not a user message' },
        ],
      }),
    )
    const provider = createZerostackProvider(root)
    const parser = provider.createSessionParser(source(path), new Set())
    const calls = await Effect.runPromise(Stream.runCollect(parserStream(parser)()))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      provider: 'zerostack',
      model: 'openrouter/deepseek/deepseek-v4-pro',
      inputTokens: 10,
      outputTokens: 50,
      sessionId: 'filename-fallback',
      timestamp: '2026-10-01T00:00:01.000Z',
      userMessage: 'first question',
      project: 'fixture-project',
      projectPath: '/workspace/project',
      tools: [],
      bashCommands: [],
      deduplicationKey: `zerostack:${path}:2026-10-01T00:00:01.000Z:filename-fallback`,
    })
    expect(provider.modelDisplayName('openrouter/deepseek/deepseek-v4-pro')).toBe('DeepSeek v4 Pro')
    expect(provider.toolDisplayName('task')).toBe('Agent')
    expect(provider.toolDisplayName('custom_tool')).toBe('custom_tool')
  })

  it('discovers from the working-directory projection despite malformed parser-only totals', async () => {
    const sessionsDir = join(root, 'sessions')
    const path = join(sessionsDir, 'bad-total.json')
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(path, record({ total_input_tokens: 'many', working_dir: '/workspace/retained' }))
    const provider = createZerostackProvider(sessionsDir)

    const discovered = await Effect.runPromise(discovery(provider)().pipe(Effect.provide(Env.layer)))
    const calls = await Effect.runPromise(
      Stream.runCollect(parserStream(provider.createSessionParser(source(path), new Set()))()),
    )

    expect(discovered).toEqual([{ path, project: 'retained', provider: 'zerostack' }])
    expect(calls).toHaveLength(0)
  })

  it('keeps the first user string content, null defaults, and updated timestamp precedence', async () => {
    const path = join(root, 'string-message.json')
    await writeFile(
      path,
      record({
        id: 'string-session',
        total_input_tokens: null,
        total_output_tokens: 8,
        working_dir: '',
        messages: [
          { role: 'user', content: 'plain question' },
          { role: 'user', content: 'later' },
        ],
      }),
    )
    const calls = await Effect.runPromise(
      Stream.runCollect(parserStream(createZerostackProvider().createSessionParser(source(path), new Set()))()),
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 8,
      timestamp: '2026-10-01T00:00:02.000Z',
      sessionId: 'string-session',
      userMessage: 'plain question',
      projectPath: '',
    })
  })

  it('admits dedup keys only when the native stream is consumed and preserves the file-name fallback key', async () => {
    const path = join(root, 'fallback.json')
    await writeFile(path, record({ id: null, working_dir: null }))
    const seenKeys = new Set<string>()
    const parser = createZerostackProvider().createSessionParser(source(path), seenKeys)
    const stream = parserStream(parser)()

    expect(seenKeys).toEqual(new Set())
    const calls = await Effect.runPromise(Stream.runCollect(stream.pipe(Stream.take(1))))

    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (!call) throw new Error('Expected one Zerostack session call')
    expect(call.deduplicationKey).toBe(`zerostack:${path}:2026-10-01T00:00:02.000Z:fallback`)
    expect(call.projectPath).toBeUndefined()
    expect(seenKeys).toEqual(new Set([call.deduplicationKey]))
  })

  it('skips declared counter values that are not finite numbers', async () => {
    const path = join(root, 'non-finite.json')
    const raw = record({ total_input_tokens: 1, total_output_tokens: 50 }).replace(
      '"total_input_tokens":1',
      '"total_input_tokens":1e309',
    )
    await writeFile(path, raw)
    const calls = await Effect.runPromise(
      Stream.runCollect(parserStream(createZerostackProvider().createSessionParser(source(path), new Set()))()),
    )
    expect(calls).toHaveLength(0)
  })

  it('returns an empty discovery for missing directories and preserves the typed abort reason before IO', async () => {
    await expect(
      Effect.runPromise(discovery(createZerostackProvider(join(root, 'missing')))().pipe(Effect.provide(Env.layer))),
    ).resolves.toEqual([])

    const reason = new ScanAbortedError({ message: 'stop Zerostack discovery' })
    const controller = new AbortController()
    controller.abort(reason)
    await expect(
      Effect.runPromise(
        discovery(createZerostackProvider(root))({ signal: controller.signal }).pipe(Effect.provide(Env.layer)),
      ),
    ).rejects.toBe(reason)
  })

  it('keeps missing and unreadable file inputs on the empty-file fallback', async () => {
    const missingPath = join(root, 'missing.json')
    const readFailurePath = join(root, 'read-failure.json')
    await writeFile(readFailurePath, record())
    ioHooks.failedReadPath = readFailurePath
    const provider = createZerostackProvider(root)

    const missingCalls = await Effect.runPromise(
      Stream.runCollect(parserStream(provider.createSessionParser(source(missingPath), new Set()))()),
    )
    const unreadableCalls = await Effect.runPromise(
      Stream.runCollect(parserStream(provider.createSessionParser(source(readFailurePath), new Set()))()),
    )

    expect(missingCalls).toHaveLength(0)
    expect(unreadableCalls).toHaveLength(0)
  })

  it('waits for the uncancellable whole-file read then fails with the exact scan-abort reason', async () => {
    const path = join(root, 'pending.json')
    await writeFile(path, record())
    let markStarted!: () => void
    let releaseRead!: () => void
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    const pending = new Promise<void>(resolve => {
      releaseRead = resolve
    })
    ioHooks.onReadStarted = markStarted
    ioHooks.readPause = () => pending
    const reason = new ScanAbortedError({ message: 'stop Zerostack parse' })
    const controller = new AbortController()
    const parser = createZerostackProvider().createSessionParser(source(path), new Set(), undefined, {
      signal: controller.signal,
    })
    const collected = Effect.runPromise(Stream.runCollect(parserStream(parser)()))
    await started
    controller.abort(reason)
    let settled = false
    void collected.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    releaseRead()

    await expect(collected).rejects.toBe(reason)
  })
})
