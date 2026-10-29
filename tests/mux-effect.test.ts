import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Effect, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nativeIo = vi.hoisted(() => ({
  configPath: undefined as string | undefined,
  configReadCount: 0,
  configReadStarted: undefined as (() => void) | undefined,
  pauseConfigRead: false,
  releaseConfigRead: undefined as (() => void) | undefined,
  pauseReader: false,
  readerOpenCount: 0,
  readerOpen: undefined as (() => void) | undefined,
  readerClose: undefined as (() => void) | undefined,
}))

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]) !== nativeIo.configPath) return actual.readFile(...args)
      nativeIo.configReadCount++
      if (nativeIo.pauseConfigRead) {
        nativeIo.configReadStarted?.()
        await new Promise<void>(resolve => {
          nativeIo.releaseConfigRead = resolve
        })
      }
      return actual.readFile(...args)
    },
  }
})

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args)
      nativeIo.readerOpenCount++
      nativeIo.readerOpen?.()
      if (nativeIo.pauseReader) stream.pause()
      stream.once('close', () => nativeIo.readerClose?.())
      return stream
    },
  }
})

import { type AppPaths, appPaths, Env, type ProviderOverrides } from '../src/infrastructure/config/environment.js'
import { setModelAliases, setPriceOverrides } from '../src/infrastructure/pricing/models.js'
import { createMuxProvider } from '../src/infrastructure/provider-adapters/mux.js'
import type {
  ParsedProviderCall,
  Provider,
  SessionParser,
  SessionSource,
} from '../src/infrastructure/provider-adapters/types.js'
import { ScanAbortedError } from '../src/core/ingestion/reconciliation/scan-control.js'
import type { ScanPricing } from '../src/core/domain/pricing/scan-pricing.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-mux-effect-'))
  nativeIo.configPath = undefined
  nativeIo.configReadCount = 0
  nativeIo.configReadStarted = undefined
  nativeIo.pauseConfigRead = false
  nativeIo.releaseConfigRead = undefined
  nativeIo.pauseReader = false
  nativeIo.readerOpenCount = 0
  nativeIo.readerOpen = undefined
  nativeIo.readerClose = undefined
})

afterEach(() => {
  setModelAliases({})
  setPriceOverrides({})
  nativeIo.configPath = undefined
  nativeIo.configReadStarted = undefined
  nativeIo.pauseConfigRead = false
  nativeIo.releaseConfigRead = undefined
  nativeIo.pauseReader = false
  nativeIo.readerOpenCount = 0
  nativeIo.readerOpen = undefined
  nativeIo.readerClose = undefined
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function pathsWith(overrides: ProviderOverrides): AppPaths {
  return { ...appPaths(), overrides }
}

function source(path: string, project = 'fixture-project'): SessionSource {
  return { path, project, provider: 'mux' }
}

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'assistant-one',
    role: 'assistant',
    parts: [],
    metadata: {
      model: 'provider:model-one',
      timestamp: 1_735_689_600_000,
      usage: { inputTokens: 10, outputTokens: 6 },
    },
    ...overrides,
  }
}

async function writeLines(path: string, values: readonly (unknown | string)[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, values.map(value => (typeof value === 'string' ? value : JSON.stringify(value))).join('\n'))
}

function parser(path: string, seen = new Set<string>(), signal?: AbortSignal, pricing?: ScanPricing): SessionParser {
  const context = signal || pricing ? { ...(signal ? { signal } : {}), ...(pricing ? { pricing } : {}) } : undefined
  return createMuxProvider(root).createSessionParser(source(path), seen, undefined, context)
}

function parseStream(value: SessionParser): NonNullable<SessionParser['parseStream']> {
  if (!value.parseStream) throw new Error('Mux parser did not expose its native Stream')
  return value.parseStream
}

function discovery(provider: Provider, signal?: AbortSignal) {
  if (!provider.discoverSessionsEffect) throw new Error('Mux provider did not expose native discovery')
  return provider.discoverSessionsEffect(signal ? { signal } : undefined).pipe(Effect.provide(Env.layer))
}

async function collect(value: SessionParser): Promise<ParsedProviderCall[]> {
  return [...(await Effect.runPromise(Stream.runCollect(parseStream(value)())))]
}

describe('Mux Effect provider discovery', () => {
  it('keeps workspace and child source order, project aliases, and one config read', async () => {
    const sessions = join(root, 'sessions')
    const first = join(sessions, 'workspace-first')
    const second = join(sessions, 'workspace-second')
    await writeLines(join(first, 'chat.jsonl'), [])
    await writeLines(join(first, 'subagent-transcripts', 'child-first', 'chat.jsonl'), [])
    await writeLines(join(first, 'subagent-transcripts', 'child-second', 'chat.jsonl'), [])
    await writeLines(join(second, 'chat.jsonl'), [])
    await mkdir(join(second, 'subagent-transcripts', 'missing-chat'), { recursive: true })
    const configPath = join(root, 'config.json')
    await writeFile(
      configPath,
      JSON.stringify({ projects: [['/work/first-project', { workspaces: [{ id: 'workspace-first' }] }]] }),
    )
    nativeIo.configPath = configPath

    const found = await Effect.runPromise(discovery(createMuxProvider(root)))
    const workspaceOrder = await import('node:fs/promises').then(({ readdir }) => readdir(sessions))
    const childOrder = await import('node:fs/promises').then(({ readdir }) =>
      readdir(join(first, 'subagent-transcripts')),
    )

    expect(found).toEqual([
      ...workspaceOrder.flatMap(workspaceId => {
        const workspaceDir = join(sessions, workspaceId)
        const project = workspaceId === 'workspace-first' ? 'first-project' : workspaceId
        return [
          ...(workspaceId === 'workspace-first' || workspaceId === 'workspace-second'
            ? [{ path: join(workspaceDir, 'chat.jsonl'), project, provider: 'mux' }]
            : []),
          ...(workspaceId === 'workspace-first'
            ? childOrder
                .filter(childId => childId !== 'missing-chat')
                .map(childId => ({
                  path: join(workspaceDir, 'subagent-transcripts', childId, 'chat.jsonl'),
                  project,
                  provider: 'mux',
                }))
            : []),
        ]
      }),
    ])
    expect(nativeIo.configReadCount).toBe(1)
  })

  it('uses the factory root snapshot and preserves override precedence', async () => {
    const envRoot = join(root, 'env-root')
    const muxRoot = join(root, 'mux-root')
    const factoryRoot = join(root, 'factory-root')
    const envChat = join(envRoot, 'sessions', 'env-workspace', 'chat.jsonl')
    const muxChat = join(muxRoot, 'sessions', 'mux-workspace', 'chat.jsonl')
    const factoryChat = join(factoryRoot, 'sessions', 'factory-workspace', 'chat.jsonl')
    await writeLines(envChat, [])
    await writeLines(muxChat, [])
    await writeLines(factoryChat, [])

    const fromWatchtower = createMuxProvider(undefined, pathsWith({ WATCHTOWER_MUX_DIR: envRoot, MUX_ROOT: muxRoot }))
    const fromMuxRoot = createMuxProvider(undefined, pathsWith({ MUX_ROOT: muxRoot }))
    const fromFactory = createMuxProvider(factoryRoot, pathsWith({ WATCHTOWER_MUX_DIR: envRoot, MUX_ROOT: muxRoot }))

    expect(await Effect.runPromise(discovery(fromWatchtower))).toEqual([
      { path: envChat, project: 'env-workspace', provider: 'mux' },
    ])
    expect(await Effect.runPromise(discovery(fromMuxRoot))).toEqual([
      { path: muxChat, project: 'mux-workspace', provider: 'mux' },
    ])
    expect(await Effect.runPromise(discovery(fromFactory))).toEqual([
      { path: factoryChat, project: 'factory-workspace', provider: 'mux' },
    ])

    const changingOverrides = { WATCHTOWER_MUX_DIR: envRoot, MUX_ROOT: muxRoot }
    const environmentCaptured = createMuxProvider(undefined, pathsWith(changingOverrides))
    changingOverrides.WATCHTOWER_MUX_DIR = muxRoot
    expect(await Effect.runPromise(discovery(environmentCaptured))).toEqual([
      { path: envChat, project: 'env-workspace', provider: 'mux' },
    ])
  })

  it('returns empty for missing roots and malformed project config', async () => {
    await expect(Effect.runPromise(discovery(createMuxProvider(join(root, 'missing'))))).resolves.toEqual([])
    const chat = join(root, 'bad-config', 'sessions', 'workspace', 'chat.jsonl')
    await writeLines(chat, [])
    await writeFile(join(root, 'bad-config', 'config.json'), '{invalid')
    await expect(Effect.runPromise(discovery(createMuxProvider(join(root, 'bad-config'))))).resolves.toEqual([
      { path: chat, project: 'workspace', provider: 'mux' },
    ])
  })

  it('drains a pending config read before failing with the exact abort reason', async () => {
    const sessions = join(root, 'pending', 'sessions')
    await mkdir(sessions, { recursive: true })
    const configPath = join(root, 'pending', 'config.json')
    await writeFile(configPath, '{}')
    nativeIo.configPath = configPath
    let markStarted!: () => void
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    nativeIo.configReadStarted = markStarted
    nativeIo.pauseConfigRead = true
    const reason = new ScanAbortedError({ message: 'stop Mux discovery' })
    const controller = new AbortController()
    const result = Effect.runPromise(discovery(createMuxProvider(join(root, 'pending')), controller.signal))
    await started
    controller.abort(reason)
    let settled = false
    void result.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    nativeIo.releaseConfigRead?.()

    await expect(result).rejects.toBe(reason)
  })
})

describe('Mux Effect parser stream', () => {
  it('keeps yielded-line fallback IDs, excluding blank lines but counting malformed rows', async () => {
    const path = join(root, 'sessions', 'workspace', 'chat.jsonl')
    const calculateCost = vi.fn(() => 3)
    const pricing: ScanPricing = { calculateCost, calculateLocalModelSavings: () => null }
    await writeLines(path, ['', '{bad json', '', message({ id: null }), 'not-json', message({ id: null })])

    const calls = await collect(parser(path, new Set(), undefined, pricing))

    expect(calls.map(call => call.deduplicationKey)).toEqual(['mux:workspace:L2', 'mux:workspace:L4'])
    expect(calls.map(call => call.model)).toEqual(['model-one', 'model-one'])
    expect(calculateCost).toHaveBeenCalledTimes(2)
  })

  it('tolerates malformed siblings and preserves token, timestamp, tool, bash, and prompt fallbacks', async () => {
    const path = join(root, 'sessions', 'workspace', 'chat.jsonl')
    await writeLines(path, [
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'first prompt' },
          null,
          { type: 'text', text: 'second prompt' },
          { ignored: true },
        ],
      },
      message({
        id: 'array-usage',
        metadata: { model: 'ignored', usage: [] },
      }),
      message({
        id: null,
        parts: [
          { type: 'dynamic-tool', toolName: 'bash', input: { script: 'git status && npm test', irrelevant: 42 } },
          { type: 'dynamic-tool', toolName: 'bash', input: [] },
          { type: 'dynamic-tool', toolName: 'file_read', input: null },
          { type: 'dynamic-tool', toolName: 'custom_tool' },
          null,
        ],
        metadata: {
          model: null,
          timestamp: Number.NaN,
          usage: {
            inputTokens: 20,
            cachedInputTokens: 3,
            outputTokens: 9,
            reasoningTokens: 2,
            malformedUnusedSibling: { nested: true },
          },
          providerMetadata: {
            anthropic: { cacheCreationInputTokens: 4, unrelated: 'kept' },
            malformedUnusedSibling: null,
          },
          extra: 'ignored',
        },
        createdAt: 'provider-time',
        extra: 'ignored',
      }),
      message({
        id: 'malformed-counter',
        metadata: {
          model: 'fallback-model',
          usage: { inputTokens: 'many', outputTokens: 5, cachedInputTokens: -2, reasoningTokens: 'two' },
        },
      }),
    ])
    const calculateCost = vi.fn(() => 17)
    const pricing: ScanPricing = { calculateCost, calculateLocalModelSavings: () => null }

    const calls = await collect(parser(path, new Set(), undefined, pricing))

    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      model: 'unknown',
      inputTokens: 13,
      outputTokens: 7,
      cacheCreationInputTokens: 4,
      cacheReadInputTokens: 3,
      cachedInputTokens: 3,
      reasoningTokens: 2,
      timestamp: 'provider-time',
      deduplicationKey: 'mux:workspace:L3',
      userMessage: 'first prompt second prompt',
      tools: ['Bash', 'Bash', 'Read', 'custom_tool'],
      bashCommands: ['git', 'npm'],
    })
    expect(calculateCost).toHaveBeenCalledWith('unknown', 13, 9, 4, 3, 0)
    expect(calls[1]).toMatchObject({
      model: 'fallback-model',
      inputTokens: 0,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      reasoningTokens: 0,
      deduplicationKey: 'mux:workspace:malformed-counter',
      userMessage: '',
    })
    expect(calculateCost).toHaveBeenCalledWith('fallback-model', 0, 5, 0, 0, 0)
  })

  it('captures pricing at parser creation, honors scan pricing, and prices only a pulled nonduplicate', async () => {
    const path = join(root, 'sessions', 'workspace', 'chat.jsonl')
    const alias = 'mux-effect-captured-alias'
    const firstModel = 'mux-effect-captured-first'
    const nextModel = 'mux-effect-captured-next'
    const pricedMessage = (id: string) =>
      message({
        id,
        metadata: { model: alias, timestamp: 1_735_689_600_000, usage: { inputTokens: 10, outputTokens: 6 } },
      })
    await writeLines(path, [pricedMessage('one'), pricedMessage('one'), pricedMessage('two')])
    setModelAliases({ [alias]: firstModel })
    setPriceOverrides({
      [firstModel]: { input: 500_000, output: 500_000 },
      [nextModel]: { input: 1_000_000, output: 1_000_000 },
    })
    const provider = createMuxProvider(root)
    const parserValue = provider.createSessionParser(source(path), new Set())
    setModelAliases({ [alias]: nextModel })
    const seen = new Set<string>()
    const explicitCost = vi.fn(() => 41)
    const explicitPricing: ScanPricing = { calculateCost: explicitCost, calculateLocalModelSavings: () => null }
    const explicitParser = provider.createSessionParser(source(path), seen, undefined, { pricing: explicitPricing })
    const explicitStream = parseStream(explicitParser)()

    expect(seen).toEqual(new Set())
    const explicitCalls = await Effect.runPromise(Stream.runCollect(explicitStream.pipe(Stream.take(1))))
    const capturedCalls = await collect(parserValue)
    const refreshedCalls = await collect(provider.createSessionParser(source(path), new Set()))

    expect(explicitCalls).toHaveLength(1)
    expect(explicitCalls[0]?.costUSD).toBe(41)
    expect(explicitCost).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(new Set(['mux:workspace:one']))
    expect(capturedCalls).toHaveLength(2)
    expect(capturedCalls[0]?.costUSD).toBeGreaterThan(0)
    expect(refreshedCalls[0]?.costUSD).toBe((capturedCalls[0]?.costUSD ?? 0) * 2)
  })

  it('uses the parser-level legacy adapter and maps model/tool display labels', async () => {
    const path = join(root, 'sessions', 'workspace', 'chat.jsonl')
    await writeLines(path, [message()])
    const provider = createMuxProvider(root)
    const calls = await collect(provider.createSessionParser(source(path), new Set()))

    expect(calls).toHaveLength(1)
    expect(provider.modelDisplayName('openai:gpt-5.5')).toBe('GPT-5.5')
    expect(provider.toolDisplayName('file_read')).toBe('Read')
    expect(provider.toolDisplayName('custom_tool')).toBe('custom_tool')
  })

  it('keeps a seen key if pricing fails, matching the legacy admission order', async () => {
    const path = join(root, 'sessions', 'workspace', 'chat.jsonl')
    await writeLines(path, [message({ id: 'price-error' })])
    const seen = new Set<string>()
    const pricing: ScanPricing = {
      calculateCost: () => {
        throw new Error('pricing failed')
      },
      calculateLocalModelSavings: () => null,
    }

    await expect(
      Effect.runPromise(Stream.runCollect(parseStream(parser(path, seen, undefined, pricing))())),
    ).rejects.toThrow('pricing failed')
    expect(seen).toEqual(new Set(['mux:workspace:price-error']))
  })

  it('opens IO only when pulled and closes the reader on early stream completion', async () => {
    const path = join(root, 'sessions', 'workspace', 'chat.jsonl')
    await writeLines(path, [message({ id: 'first' }), message({ id: 'second' })])
    let readerOpened!: () => void
    let readerClosed!: () => void
    const opened = new Promise<void>(resolve => {
      readerOpened = resolve
    })
    const closed = new Promise<void>(resolve => {
      readerClosed = resolve
    })
    nativeIo.readerOpen = readerOpened
    nativeIo.readerClose = readerClosed
    const stream = parseStream(parser(path))()

    expect(nativeIo.readerOpenCount).toBe(0)
    const calls = await Effect.runPromise(Stream.runCollect(stream.pipe(Stream.take(1))))
    await closed

    expect(calls).toHaveLength(1)
    expect(nativeIo.readerOpenCount).toBe(1)
    await opened
  })

  it('closes a pending reader and fails with the exact scan-abort reason', async () => {
    const path = join(root, 'sessions', 'workspace', 'chat.jsonl')
    await writeLines(path, [message({ id: 'one' }), message({ id: 'two' })])
    let readerOpened!: () => void
    let readerClosed!: () => void
    const opened = new Promise<void>(resolve => {
      readerOpened = resolve
    })
    const closed = new Promise<void>(resolve => {
      readerClosed = resolve
    })
    nativeIo.readerOpen = readerOpened
    nativeIo.readerClose = readerClosed
    nativeIo.pauseReader = true
    const reason = new ScanAbortedError({ message: 'stop Mux parse' })
    const controller = new AbortController()
    const result = Effect.runPromise(Stream.runCollect(parseStream(parser(path, new Set(), controller.signal))()))

    await opened
    controller.abort(reason)
    await expect(result).rejects.toBe(reason)
    await closed
  })
})
