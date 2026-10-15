import { Cause, Effect, Exit, Option, Stream } from 'effect'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Env } from '../src/main/env.js'
import { createOpenDesignProvider } from '../src/main/pipeline/providers/open-design.js'
import type {
  ParsedProviderCall,
  Provider,
  SessionParser,
  SessionSource,
} from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'watchtower-open-design-effect-'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

function source(path: string, project = 'fixture-project'): SessionSource {
  return { path, project, provider: 'open-design' }
}

function event(overrides: object = {}): string {
  return JSON.stringify({
    id: 'usage-id',
    event: 'agent',
    data: {
      type: 'usage',
      usage: { input_tokens: 10, output_tokens: 6, cached_read_tokens: 2, thought_tokens: 2 },
    },
    timestamp: '2026-01-01T00:00:00Z',
    ...overrides,
  })
}

function parserStream(parser: SessionParser): NonNullable<SessionParser['parseStream']> {
  if (!parser.parseStream) throw new Error('Open Design parser did not expose its native Stream')
  return parser.parseStream
}

async function collect(parser: SessionParser): Promise<ParsedProviderCall[]> {
  return [...(await Effect.runPromise(Stream.runCollect(parserStream(parser)())))]
}

function nativeDiscovery(provider: Provider, signal?: AbortSignal) {
  if (!provider.discoverSessionsEffect) throw new Error('Open Design provider did not expose native discovery')
  return provider.discoverSessionsEffect(signal ? { signal } : undefined).pipe(Effect.provide(Env.layer))
}

describe('Open Design native discovery', () => {
  it('keeps discovery order and namespace projects for a namespaces root', async () => {
    const namespacesDir = join(root, 'namespaces')
    const runNames = ['first', 'second']
    for (const namespace of runNames) {
      const runDir = join(namespacesDir, namespace, 'data', 'runs', 'run-one')
      await mkdir(runDir, { recursive: true })
      await writeFile(join(runDir, 'events.jsonl'), '')
    }

    const provider = createOpenDesignProvider(namespacesDir)
    const discovered = await Effect.runPromise(nativeDiscovery(provider))
    const namespaceOrder = await import('fs/promises').then(({ readdir }) => readdir(namespacesDir))

    expect(discovered).toEqual(
      namespaceOrder.map(namespace => ({
        path: join(namespacesDir, namespace, 'data', 'runs', 'run-one', 'events.jsonl'),
        project: namespace,
        provider: 'open-design',
      })),
    )
  })

  it('supports direct runs and data overrides while skipping missing and non-file events', async () => {
    const runsDir = join(root, 'namespace', 'data', 'runs')
    await mkdir(join(runsDir, 'with-events'), { recursive: true })
    await mkdir(join(runsDir, 'directory-events'), { recursive: true })
    await writeFile(join(runsDir, 'with-events', 'events.jsonl'), '')
    await mkdir(join(runsDir, 'directory-events', 'events.jsonl'))

    const expected = [
      { path: join(runsDir, 'with-events', 'events.jsonl'), project: 'namespace', provider: 'open-design' },
    ]
    await expect(Effect.runPromise(nativeDiscovery(createOpenDesignProvider(runsDir)))).resolves.toEqual(expected)
    await expect(Effect.runPromise(nativeDiscovery(createOpenDesignProvider(dirname(runsDir))))).resolves.toEqual(
      expected,
    )
  })

  it('uses the environment root when nonempty and keeps the factory empty-string override', async () => {
    const rootOverride = join(root, 'environment-root')
    const runDir = join(rootOverride, 'runs', 'run-one')
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, 'events.jsonl'), '')
    vi.stubEnv('WATCHTOWER_OPEN_DESIGN_DIR', rootOverride)

    await expect(Effect.runPromise(nativeDiscovery(createOpenDesignProvider()))).resolves.toEqual([
      { path: join(runDir, 'events.jsonl'), project: 'environment-root', provider: 'open-design' },
    ])
    await expect(Effect.runPromise(nativeDiscovery(createOpenDesignProvider('')))).resolves.toEqual([])
  })

  it('preserves the caller abort reason before filesystem IO', async () => {
    const aborted = new ScanAbortedError({ message: 'stop Open Design discovery' })
    const controller = new AbortController()
    controller.abort(aborted)

    await expect(Effect.runPromise(nativeDiscovery(createOpenDesignProvider(root), controller.signal))).rejects.toBe(
      aborted,
    )
  })
})

describe('Open Design native parser stream', () => {
  it('tracks model state, ignores malformed records, and defaults malformed usage fields independently', async () => {
    const path = join(root, 'namespace', 'run-one', 'events.jsonl')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      [
        '',
        '{bad json',
        '[]',
        JSON.stringify({ event: 'start', data: { model: 'model-first', unrelated: 42, malformed: [] } }),
        event({
          id: 4,
          timestamp: null,
          data: {
            type: 'usage',
            usage: { input_tokens: -2, output_tokens: 6, cached_read_tokens: 9, thought_tokens: 'two', ignored: [] },
            sibling: false,
          },
        }),
        JSON.stringify({ event: 'agent', data: { type: 'status', model: 'model-second', usage: null } }),
        event({ id: null, data: { type: 'usage', usage: null } }),
        event({
          id: null,
          timestamp: 1_735_689_600_000,
          data: { type: 'usage', usage: { input_tokens: 8, output_tokens: 3 } },
        }),
        event({ id: 'no-usage-record', data: { type: 'usage', usage: null } }),
      ].join('\n'),
    )

    const seen = new Set<string>()
    const calculateCost = vi.fn(() => 5)
    const pricing: ScanPricing = { calculateCost, calculateLocalModelSavings: () => null }
    const calls = await collect(
      createOpenDesignProvider(root).createSessionParser(source(path), seen, undefined, { pricing }),
    )

    expect(calls).toMatchObject([
      {
        model: 'model-first',
        inputTokens: 0,
        outputTokens: 6,
        cacheReadInputTokens: 9,
        cachedInputTokens: 9,
        reasoningTokens: 0,
        timestamp: '',
        deduplicationKey: 'open-design:run-one:line-0',
      },
      {
        model: 'model-second',
        inputTokens: 8,
        outputTokens: 3,
        cacheReadInputTokens: 0,
        timestamp: new Date(1_735_689_600_000).toISOString(),
        deduplicationKey: 'open-design:run-one:line-1',
      },
    ])
    expect(seen).toEqual(new Set(['open-design:run-one:line-0', 'open-design:run-one:line-1']))
    expect(calculateCost).toHaveBeenNthCalledWith(1, 'model-first', 0, 6, 0, 9, 0)
    expect(calculateCost).toHaveBeenNthCalledWith(2, 'model-second', 8, 3, 0, 0, 0)
  })

  it('admits and prices only consumed calls and preserves id dedupe', async () => {
    const path = join(root, 'namespace', 'run-one', 'events.jsonl')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      [
        JSON.stringify({ event: 'start', data: { model: 'captured-model' } }),
        event({ id: 'first' }),
        event({ id: 'first' }),
        event({ id: 'second' }),
      ].join('\n'),
    )

    const seen = new Set<string>()
    const pricedModels: string[] = []
    const capturedPricing: ScanPricing = {
      calculateCost(model: string) {
        pricedModels.push(model)
        return pricedModels.length
      },
      calculateLocalModelSavings: () => null,
    }
    const parser = createOpenDesignProvider(root).createSessionParser(source(path), seen, undefined, {
      pricing: capturedPricing,
    })
    const stream = parserStream(parser)()

    expect(seen).toEqual(new Set())
    const first = await Effect.runPromise(Stream.runHead(stream))

    expect(Option.getOrThrow(first)).toMatchObject({
      deduplicationKey: 'open-design:run-one:first',
      costUSD: 1,
    })
    expect(seen).toEqual(new Set(['open-design:run-one:first']))
    expect(pricedModels).toEqual(['captured-model'])
  })

  it('retains captured pricing from scan context and the Promise parser adapter', async () => {
    const path = join(root, 'namespace', 'run-one', 'events.jsonl')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, [JSON.stringify({ event: 'start', data: { model: 'context-model' } }), event()].join('\n'))
    const pricing: ScanPricing = { calculateCost: () => 41, calculateLocalModelSavings: () => null }
    const parser = createOpenDesignProvider(root).createSessionParser(source(path), new Set(), undefined, { pricing })

    await expect(parser.parse().next()).resolves.toMatchObject({
      done: false,
      value: { model: 'context-model', costUSD: 41 },
    })
  })

  it('preserves the exact abort reason when parsing has already started', async () => {
    const path = join(root, 'namespace', 'run-one', 'events.jsonl')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      [
        JSON.stringify({ event: 'start', data: { model: 'model' } }),
        event({ id: 'first' }),
        event({ id: 'second' }),
      ].join('\n'),
    )
    const aborted = new ScanAbortedError({ message: 'stop Open Design parse' })
    const controller = new AbortController()
    const parser = createOpenDesignProvider(root).createSessionParser(source(path), new Set(), undefined, {
      signal: controller.signal,
      pricing: {
        calculateCost() {
          controller.abort(aborted)
          return 1
        },
        calculateLocalModelSavings: () => null,
      },
    })
    const exit = await Effect.runPromiseExit(Stream.runCollect(parserStream(parser)()))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBe(aborted)
  })
})
