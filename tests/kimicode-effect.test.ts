import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Option, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nativeIo = vi.hoisted(() => ({
  reads: [] as string[],
  stats: [] as string[],
  pendingPath: undefined as string | undefined,
  onPendingRead: undefined as (() => void) | undefined,
  releasePendingRead: undefined as ((value: string) => void) | undefined,
  onReadSettled: undefined as (() => void) | undefined,
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: (...args: Parameters<typeof actual.stat>) => {
      nativeIo.stats.push(String(args[0]))
      return actual.stat(...args)
    },
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      const path = String(args[0])
      nativeIo.reads.push(path)
      if (path !== nativeIo.pendingPath) return actual.readFile(...args)
      nativeIo.onPendingRead?.()
      return new Promise<string>(resolve => {
        nativeIo.releasePendingRead = value => {
          resolve(value)
          nativeIo.onReadSettled?.()
        }
      })
    },
  }
})

import { Env } from '../src/main/env.js'
import { captureScanPricing } from '../src/main/pipeline/models.js'
import { createKimicodeProvider } from '../src/main/pipeline/providers/kimicode.js'
import type { Provider, SessionParser, SessionSource } from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-kimicode-effect-'))
  nativeIo.reads.length = 0
  nativeIo.stats.length = 0
  nativeIo.pendingPath = undefined
  nativeIo.onPendingRead = undefined
  nativeIo.releasePendingRead = undefined
  nativeIo.onReadSettled = undefined
})

afterEach(() => {
  nativeIo.pendingPath = undefined
  nativeIo.onPendingRead = undefined
  nativeIo.releasePendingRead = undefined
  nativeIo.onReadSettled = undefined
  rmSync(root, { recursive: true, force: true })
})

function wirePaths(name = 'session_one') {
  const sessionDir = join(root, 'sessions', 'wd_project_123456789abc', name)
  const agentDir = join(sessionDir, 'agents', 'agent-one')
  return { sessionDir, agentDir, wirePath: join(agentDir, 'wire.jsonl'), statePath: join(sessionDir, 'state.json') }
}

async function writeFixture(
  wire: string,
  state: Record<string, unknown> = { workDir: 'C:/work/demo', updatedAt: '2026-01-01T00:00:00Z' },
) {
  const paths = wirePaths()
  await mkdir(paths.agentDir, { recursive: true })
  await writeFile(paths.wirePath, wire)
  await writeFile(paths.statePath, JSON.stringify(state))
  return paths
}

function source(path: string): SessionSource {
  return { path, project: 'fixture-project', provider: 'kimicode', sourceId: 'agent-one', sourcePath: 'fallback/path' }
}

function parserStream(parser: SessionParser): NonNullable<SessionParser['parseStream']> {
  if (!parser.parseStream) throw new Error('Kimicode parser did not expose its native stream')
  return parser.parseStream
}

function nativeDiscovery(provider: Provider): NonNullable<Provider['discoverSessionsEffect']> {
  if (!provider.discoverSessionsEffect) throw new Error('Kimicode provider did not expose native discovery')
  return provider.discoverSessionsEffect
}

const request = {
  type: 'llm.request',
  model: 'k3',
  modelAlias: 'agent-model',
  turnStep: 'turn-7.2',
  time: '2026-01-01T00:00:01Z',
}

const usage = {
  type: 'usage.record',
  model: 'agent-model',
  time: '2026-01-01T00:00:02Z',
  usage: { inputOther: '100.9', output: 25, inputCacheRead: '10', inputCacheCreation: 5 },
}

describe('Kimicode native Effect provider', () => {
  it('discovers source identity, project state, and sorted wire paths', async () => {
    const first = wirePaths()
    const second = wirePaths('conv-embedded')
    await mkdir(first.agentDir, { recursive: true })
    await mkdir(second.agentDir, { recursive: true })
    await writeFile(first.wirePath, '')
    await writeFile(second.wirePath, '')
    await writeFile(first.statePath, JSON.stringify({ workDir: 'C:/work/alpha' }))
    await writeFile(second.statePath, JSON.stringify({ workDir: 'C:/work/beta' }))

    const provider = createKimicodeProvider(root)
    const found = await Effect.runPromise(nativeDiscovery(provider)().pipe(Effect.provide(Env.layer)))
    expect(found).toEqual([
      {
        path: second.wirePath,
        project: 'beta',
        provider: 'kimicode',
        sourceId: 'agent-one',
        sourceLabel: 'agent-one',
        sourcePath: 'C:/work/beta',
      },
      {
        path: first.wirePath,
        project: 'alpha',
        provider: 'kimicode',
        sourceId: 'agent-one',
        sourceLabel: 'agent-one',
        sourcePath: 'C:/work/alpha',
      },
    ])
    await expect(provider.discoverSessions()).resolves.toEqual(found)
    if (!provider.probeRoots) throw new Error('Kimicode root probe is unavailable')
    await expect(provider.probeRoots()).resolves.toEqual([{ path: root, label: 'Kimi Code home' }])
  })

  it('preserves the legacy call payload and reads wire before its state sidecar', async () => {
    const prompt = {
      type: 'turn.prompt',
      input: [
        { type: 'text', text: ' first ' },
        { type: 'text', text: 'question' },
      ],
    }
    const tool = {
      type: 'context.append_loop_event',
      event: { type: 'tool.call', name: 'Shell', args: '{"command":"git status && npm test"}' },
    }
    const paths = await writeFixture([prompt, request, tool, usage].map(row => JSON.stringify(row)).join('\n'))
    const pricing = { ...captureScanPricing(), calculateCost: vi.fn(() => 7) }
    const parser = createKimicodeProvider().createSessionParser(source(paths.wirePath), new Set(), undefined, {
      pricing,
    })

    const calls = await Effect.runPromise(Stream.runCollect(parserStream(parser)()))
    expect(nativeIo.reads).toEqual([paths.wirePath, paths.statePath])
    expect(nativeIo.stats).toEqual([])
    expect(calls).toEqual([
      {
        provider: 'kimicode',
        model: 'k3',
        inputTokens: 100,
        outputTokens: 25,
        cacheCreationInputTokens: 5,
        cacheReadInputTokens: 10,
        cachedInputTokens: 10,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD: 7,
        costIsEstimated: true,
        tools: ['Bash'],
        bashCommands: ['git', 'npm'],
        timestamp: '2026-01-01T00:00:02.000Z',
        speed: 'standard',
        deduplicationKey: 'kimicode:one:agent-one:4:0',
        turnId: 'turn-7',
        userMessage: 'first\nquestion',
        sessionId: 'one',
        project: 'fixture-project',
        projectPath: 'C:/work/demo',
      },
    ])
    expect(pricing.calculateCost).toHaveBeenCalledOnce()
  })

  it('counts blank physical lines and consumes the usage ordinal before deduplication', async () => {
    const paths = await writeFixture(
      [
        JSON.stringify({ type: 'turn.prompt', input: 'question' }),
        '',
        JSON.stringify(request),
        JSON.stringify(usage),
        JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Read' } }),
        JSON.stringify(usage),
      ].join('\n'),
    )
    const seen = new Set(['kimicode:one:agent-one:4:0'])
    const pricing = { ...captureScanPricing(), calculateCost: vi.fn(() => 1) }
    const calls = await Effect.runPromise(
      Stream.runCollect(
        parserStream(
          createKimicodeProvider().createSessionParser(source(paths.wirePath), seen, undefined, {
            pricing,
          }),
        )(),
      ),
    )

    expect(calls.map(call => call.deduplicationKey)).toEqual(['kimicode:one:agent-one:6:1'])
    expect(calls[0]).toMatchObject({ tools: ['Read'], userMessage: 'question', inputTokens: 100 })
    expect(pricing.calculateCost).toHaveBeenCalledOnce()
  })

  it('uses the request and state timestamp fallbacks and source path when state has no workDir', async () => {
    const paths = await writeFixture(
      [
        JSON.stringify({ type: 'turn.prompt', input: 'current prompt' }),
        JSON.stringify({ type: 'usage.record', usage: { inputOther: 3 } }),
        JSON.stringify(request),
        JSON.stringify({ ...usage, model: 'unmapped-alias', time: 'bad timestamp' }),
      ].join('\n'),
      { createdAt: '2026-02-03T04:05:06Z' },
    )
    const parser = createKimicodeProvider().createSessionParser(source(paths.wirePath), new Set(), undefined, {
      pricing: { ...captureScanPricing(), calculateCost: vi.fn(() => 0) },
    })

    const calls = await Effect.runPromise(Stream.runCollect(parserStream(parser)()))
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      model: 'kimicode-unknown',
      timestamp: '2026-02-03T04:05:06.000Z',
      userMessage: 'current prompt',
      projectPath: 'fallback/path',
      deduplicationKey: 'kimicode:one:agent-one:2:0',
    })
    expect(calls[1]).toMatchObject({
      model: 'k3',
      timestamp: '2026-01-01T00:00:01.000Z',
      turnId: 'turn-7',
      userMessage: 'current prompt',
      projectPath: 'fallback/path',
      deduplicationKey: 'kimicode:one:agent-one:4:1',
    })
  })

  it('prices only the first emitted call when the consumer pulls one item', async () => {
    const paths = await writeFixture([JSON.stringify(request), JSON.stringify(usage), JSON.stringify(usage)].join('\n'))
    const pricing = { ...captureScanPricing(), calculateCost: vi.fn(() => 1) }
    const parser = createKimicodeProvider().createSessionParser(source(paths.wirePath), new Set(), undefined, {
      pricing,
    })

    const first = await Effect.runPromise(Stream.runHead(parserStream(parser)()))
    expect(Option.isSome(first) && first.value.deduplicationKey).toBe('kimicode:one:agent-one:2:0')
    expect(pricing.calculateCost).toHaveBeenCalledOnce()
  })

  it('skips state access after a source read failure', async () => {
    const paths = wirePaths()
    const parser = createKimicodeProvider().createSessionParser(source(paths.wirePath), new Set())

    await expect(Effect.runPromise(Stream.runCollect(parserStream(parser)()))).resolves.toEqual([])
    expect(nativeIo.reads).toEqual([paths.wirePath])
  })

  it('drains the pending source read before returning the exact abort reason', async () => {
    const paths = await writeFixture(JSON.stringify(usage))
    nativeIo.pendingPath = paths.wirePath
    let markReadStarted!: () => void
    const readStarted = new Promise<void>(resolve => (markReadStarted = resolve))
    const settled = vi.fn()
    nativeIo.onPendingRead = markReadStarted
    nativeIo.onReadSettled = settled
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'stop this scan' })
    const parser = createKimicodeProvider().createSessionParser(source(paths.wirePath), new Set(), undefined, {
      signal: controller.signal,
    })
    const running = Effect.runPromise(Stream.runCollect(parserStream(parser)()))
    const rejection = expect(running).rejects.toBe(abort)

    await readStarted
    controller.abort(abort)
    expect(settled).not.toHaveBeenCalled()
    nativeIo.releasePendingRead?.(JSON.stringify(usage))
    await rejection
    expect(settled).toHaveBeenCalledOnce()
    expect(nativeIo.reads).toEqual([paths.wirePath])
  })

  it('keeps the async-generator compatibility adapter output', async () => {
    const paths = await writeFixture([JSON.stringify(request), JSON.stringify(usage)].join('\n'))
    const parser = createKimicodeProvider().createSessionParser(source(paths.wirePath), new Set())
    const calls = []
    for await (const call of parser.parse()) calls.push(call)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      model: 'k3',
      deduplicationKey: 'kimicode:one:agent-one:2:0',
      sessionId: 'one',
      projectPath: 'C:/work/demo',
    })
  })
})
