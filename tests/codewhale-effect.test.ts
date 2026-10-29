import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Effect, Stream } from 'effect'
import { mkdir, writeFile } from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nativeIo = vi.hoisted(() => ({
  opens: [] as string[],
  prefixReads: [] as string[],
  fullReads: [] as string[],
  stats: [] as string[],
  closes: [] as string[],
  failPrefixReadPath: undefined as string | undefined,
  failClosePath: undefined as string | undefined,
  oversizedPath: undefined as string | undefined,
  pendingOpenPath: undefined as string | undefined,
  onPendingOpen: undefined as (() => void) | undefined,
  releasePendingOpen: undefined as (() => void) | undefined,
  pendingReadPath: undefined as string | undefined,
  onPendingRead: undefined as (() => void) | undefined,
  releasePendingRead: undefined as (() => void) | undefined,
}))

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const path = String(args[0])
      nativeIo.opens.push(path)
      if (path === nativeIo.pendingOpenPath) {
        nativeIo.onPendingOpen?.()
        await new Promise<void>(resolve => {
          nativeIo.releasePendingOpen = resolve
        })
      }
      const handle = await actual.open(...args)
      return {
        read: async (...readArgs: Parameters<typeof handle.read>) => {
          nativeIo.prefixReads.push(path)
          if (path === nativeIo.failPrefixReadPath) throw new Error('prefix read failed')
          if (path === nativeIo.pendingReadPath) {
            nativeIo.onPendingRead?.()
            await new Promise<void>(resolve => {
              nativeIo.releasePendingRead = resolve
            })
          }
          return handle.read(...readArgs)
        },
        close: async () => {
          nativeIo.closes.push(path)
          await handle.close()
          if (path === nativeIo.failClosePath) throw new Error('close failed')
        },
      } as Awaited<ReturnType<typeof actual.open>>
    },
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      nativeIo.fullReads.push(String(args[0]))
      return actual.readFile(...args)
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const path = String(args[0])
      nativeIo.stats.push(path)
      const result = await actual.stat(...args)
      if (path !== nativeIo.oversizedPath) return result
      return { ...result, size: 128 * 1024 * 1024 + 1 }
    },
  }
})

import { Env } from '../src/infrastructure/config/environment.js'
import { createCodeWhaleProvider } from '../src/infrastructure/provider-adapters/codewhale.js'
import type {
  Provider,
  ProviderScanContext,
  SessionParser,
  SessionSource,
} from '../src/infrastructure/provider-adapters/types.js'
import { ScanAbortedError } from '../src/core/ingestion/reconciliation/scan-control.js'
import type { ScanPricing } from '../src/core/domain/pricing/scan-pricing.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-codewhale-effect-'))
  nativeIo.opens.length = 0
  nativeIo.prefixReads.length = 0
  nativeIo.fullReads.length = 0
  nativeIo.stats.length = 0
  nativeIo.closes.length = 0
  nativeIo.failPrefixReadPath = undefined
  nativeIo.failClosePath = undefined
  nativeIo.oversizedPath = undefined
  nativeIo.pendingOpenPath = undefined
  nativeIo.onPendingOpen = undefined
  nativeIo.releasePendingOpen = undefined
  nativeIo.pendingReadPath = undefined
  nativeIo.onPendingRead = undefined
  nativeIo.releasePendingRead = undefined
})

afterEach(() => {
  nativeIo.pendingOpenPath = undefined
  nativeIo.onPendingOpen = undefined
  nativeIo.releasePendingOpen = undefined
  nativeIo.pendingReadPath = undefined
  nativeIo.onPendingRead = undefined
  nativeIo.releasePendingRead = undefined
  rmSync(root, { recursive: true, force: true })
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

async function writeSession(path: string, metadata: Record<string, unknown>, messages: unknown[] = []): Promise<void> {
  await writeJson(path, { metadata, messages })
}

function nativeDiscovery(provider: Provider): (context?: ProviderScanContext) => Effect.Effect<SessionSource[], Error> {
  const discover = provider.discoverSessionsEffect
  if (!discover) throw new Error('CodeWhale native discovery is unavailable')
  return context => discover(context).pipe(Effect.provide(Env.layer))
}

function nativeStream(parser: SessionParser): NonNullable<SessionParser['parseStream']> {
  if (!parser.parseStream) throw new Error('CodeWhale parser did not expose parseStream')
  return parser.parseStream
}

function source(path: string): SessionSource {
  return { path, project: 'fixture', provider: 'codewhale' }
}

function parser(path: string, seenKeys = new Set<string>(), context?: ProviderScanContextFixture): SessionParser {
  return createCodeWhaleProvider(root).createSessionParser(source(path), seenKeys, undefined, context)
}

type ProviderScanContextFixture = { readonly signal?: AbortSignal; readonly pricing?: ScanPricing }

describe('CodeWhale native Effect path', () => {
  it('uses the metadata prefix, preserves directory order, and lets the primary root win duplicate ids', async () => {
    const primary = join(root, 'primary')
    const legacy = join(root, 'legacy')
    const primarySession = join(primary, 'z-session.json')
    const legacySession = join(legacy, 'a-session.json')
    await writeSession(primarySession, { id: 'same-id', workspace: '/work/primary' })
    await writeSession(legacySession, { id: 'same-id', workspace: '/work/legacy' })
    await writeSession(join(primary, 'a-session.json'), { id: 'second-id', workspace: '/work/second' })

    const discovered = await Effect.runPromise(nativeDiscovery(createCodeWhaleProvider([primary, legacy]))())

    expect(discovered.map(value => value.path)).toEqual([join(primary, 'a-session.json'), primarySession])
    expect(discovered[1]).toMatchObject({ provider: 'codewhale', project: 'primary' })
    expect(nativeIo.fullReads).toEqual([])
    expect(nativeIo.closes).toEqual(nativeIo.opens)
  })

  it('does not use whole-file fallback after a failed prefix read', async () => {
    const path = join(root, 'broken-prefix.json')
    await writeSession(path, { id: 'prefix-failure', total_tokens: 5 })
    nativeIo.failPrefixReadPath = path

    await expect(Effect.runPromise(nativeDiscovery(createCodeWhaleProvider(root))())).resolves.toEqual([])
    expect(nativeIo.fullReads).not.toContain(path)
    expect(nativeIo.closes).toContain(path)
  })

  it('uses the capped whole-file discovery fallback after a successful prefix with no metadata', async () => {
    const path = join(root, 'late-metadata.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ largeNote: 'x'.repeat(70 * 1024), metadata: { id: 'late-metadata' } }))

    await expect(Effect.runPromise(nativeDiscovery(createCodeWhaleProvider(root))())).resolves.toMatchObject([
      { path, project: 'CodeWhale' },
    ])
    expect(nativeIo.prefixReads).toContain(path)
    expect(nativeIo.fullReads).toContain(path)
  })

  it('suppresses native handle close errors after successfully reading metadata', async () => {
    const path = join(root, 'close-error.json')
    await writeSession(path, { id: 'close-error', total_tokens: 3 })
    nativeIo.failClosePath = path

    await expect(Effect.runPromise(nativeDiscovery(createCodeWhaleProvider(root))())).resolves.toMatchObject([
      { path, project: 'CodeWhale' },
    ])
    expect(nativeIo.closes).toContain(path)
  })

  it('parses complete prefix metadata after a truncated whole-file read and emits only when pulled', async () => {
    const path = join(root, 'truncated.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      '{"metadata":{"id":"truncated","updated_at":"2026-01-01T00:00:00.000Z","total_tokens":12,"workspace":"/work/truncated"},"messages":[',
    )
    const pricing: ScanPricing = { calculateCost: () => 4, calculateLocalModelSavings: () => null }
    const stream = nativeStream(parser(path, new Set(), { pricing }))()

    expect(nativeIo.fullReads).toEqual([])
    expect(nativeIo.opens).toEqual([])
    const calls = await Effect.runPromise(Stream.runCollect(stream))

    expect(calls).toMatchObject([
      {
        deduplicationKey: 'codewhale:truncated',
        inputTokens: 12,
        outputTokens: 0,
        costUSD: 4,
        costIsEstimated: true,
        project: 'truncated',
      },
    ])
    expect(nativeIo.fullReads).toContain(path)
    expect(nativeIo.opens).toContain(path)
  })

  it('keeps the capped parser read and captures supplied pricing when the parser is created', async () => {
    const path = join(root, 'oversized.json')
    await writeSession(path, {
      id: 'oversized',
      updated_at: '2026-01-01T00:00:00.000Z',
      total_tokens: 8,
      model: 'fixture-model',
    })
    nativeIo.oversizedPath = path
    const capturedPricing: ScanPricing = { calculateCost: vi.fn(() => 17), calculateLocalModelSavings: () => null }
    const laterPricing: ScanPricing = { calculateCost: vi.fn(() => 29), calculateLocalModelSavings: () => null }
    const context: { signal?: AbortSignal; pricing?: ScanPricing } = { pricing: capturedPricing }
    const sessionParser = createCodeWhaleProvider(root).createSessionParser(source(path), new Set(), undefined, context)
    context.pricing = laterPricing
    const calls = await Effect.runPromise(Stream.runCollect(nativeStream(sessionParser)()))

    expect(nativeIo.stats).toContain(path)
    expect(nativeIo.fullReads).not.toContain(path)
    expect(calls[0]?.costUSD).toBe(17)
    expect(capturedPricing.calculateCost).toHaveBeenCalledOnce()
    expect(laterPricing.calculateCost).not.toHaveBeenCalled()
  })

  it('preserves extracted tool sequence, prompt, exact zero cost, and deduplication', async () => {
    const path = join(root, 'tools.json')
    await writeSession(
      path,
      {
        id: 'tools',
        updated_at: '2026-01-01T00:00:00.000Z',
        total_tokens: 6,
        cost: { session_cost_usd: 0 },
      },
      [
        { role: 'user', content: [{ type: 'text', text: '  inspect this ' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'exec_shell', input: { command: 'npm test' } },
            { type: 'tool_use', name: 'web_search', input: { query: 'docs' } },
            { type: 'tool_use', name: 'load_skill', input: { name: 'review' } },
            { type: 'tool_use', name: 'agent', input: { type: 'research' } },
          ],
        },
      ],
    )
    const seen = new Set<string>()
    const calls = await Effect.runPromise(Stream.runCollect(nativeStream(parser(path, seen))()))

    expect(calls[0]).toMatchObject({
      costUSD: 0,
      costIsEstimated: false,
      tools: ['Bash', 'WebSearch', 'Skill', 'Agent'],
      bashCommands: ['npm'],
      skills: ['review'],
      subagentTypes: ['research'],
      webSearchRequests: 1,
      userMessage: 'inspect this',
      toolSequence: [
        [{ tool: 'Bash', command: 'npm test' }, { tool: 'WebSearch' }, { tool: 'Skill' }, { tool: 'Agent' }],
      ],
    })
    expect(seen).toEqual(new Set(['codewhale:tools']))
  })

  it('drains a pending prefix open, closes the acquired handle, and propagates the scan abort', async () => {
    const path = join(root, 'pending-open.json')
    await writeSession(path, { id: 'pending-open', total_tokens: 3 })
    nativeIo.pendingOpenPath = path
    let markStarted!: () => void
    const started = new Promise<void>(resolve => (markStarted = resolve))
    nativeIo.onPendingOpen = markStarted
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'stop opening metadata' })
    const running = Effect.runPromise(nativeDiscovery(createCodeWhaleProvider(root))({ signal: controller.signal }))
    const rejection = expect(running).rejects.toBe(abort)

    await started
    controller.abort(abort)
    expect(nativeIo.closes).toEqual([])
    nativeIo.releasePendingOpen?.()
    await rejection
    expect(nativeIo.closes).toEqual([path])
    expect(nativeIo.prefixReads).toEqual([])
  })
})
