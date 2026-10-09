import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { Cause, Effect, Exit, Option, Stream } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Env } from '../src/main/env.js'
import { createLingTaiTuiProvider } from '../src/main/pipeline/providers/lingtai-tui.js'
import type {
  ParsedProviderCall,
  Provider,
  SessionParser,
  SessionSource,
} from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'

const tempDirs: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'watchtower-lingtai-effect-'))
  tempDirs.push(dir)
  return dir
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

function makeAgent(home: string, folder: string, manifest: unknown, lines: string[] = []): string {
  const agentDir = join(home, folder)
  const logsDir = join(agentDir, 'logs')
  mkdirSync(logsDir, { recursive: true })
  writeJson(join(agentDir, '.agent.json'), manifest)
  const ledgerPath = join(logsDir, 'token_ledger.jsonl')
  writeFileSync(ledgerPath, lines.join('\n'))
  return ledgerPath
}

function nativeDiscovery(provider: Provider, signal?: AbortSignal): Promise<SessionSource[]> {
  if (!provider.discoverSessionsEffect) throw new Error('LingTai native discovery is unavailable')
  return Effect.runPromise(
    provider.discoverSessionsEffect(signal ? { signal } : undefined).pipe(Effect.provide(Env.layer)),
  )
}

function nativeCalls(parser: SessionParser): Promise<ParsedProviderCall[]> {
  if (!parser.parseStream) throw new Error('LingTai parser has no native Stream')
  return Effect.runPromise(Stream.runCollect(parser.parseStream()).pipe(Effect.map(calls => Array.from(calls))))
}

function source(path: string, project = 'Project'): SessionSource {
  return { path, project, provider: 'lingtai-tui' }
}

describe('LingTai TUI Effect provider', () => {
  it('keeps registry, brief, cwd traversal order and exact-home deduplication', async () => {
    const root = tempDir()
    const globalDir = join(root, 'global')
    const defaultHome = join(root, 'default-home')
    const projectRoot = join(root, 'registered-project')
    const briefRoot = join(root, 'brief-project')
    const cwd = join(root, 'workspace', 'nested')
    const defaultLedger = makeAgent(defaultHome, 'default-agent', { agent_id: 'default-agent' })
    const registeredLedger = makeAgent(join(projectRoot, '.lingtai'), 'registered-agent', {
      nickname: 'registered',
    })
    const briefLedger = makeAgent(join(briefRoot, '.lingtai'), 'brief-agent', { nickname: 'brief' })
    const cwdLedger = makeAgent(join(root, 'workspace', '.lingtai'), 'cwd-agent', { nickname: 'cwd' })
    mkdirSync(globalDir, { recursive: true })
    writeFileSync(
      join(globalDir, 'registry.jsonl'),
      [
        JSON.stringify({ path: projectRoot, ignored: { future: true } }),
        '{ malformed registry row',
        JSON.stringify({ path: projectRoot }),
      ].join('\n'),
    )
    writeJson(join(globalDir, 'brief', 'projects', 'brief-one', 'meta.json'), {
      project_path: briefRoot,
      unrelated: ['ignored'],
    })

    const provider = createLingTaiTuiProvider({
      defaultHomeOverride: defaultHome,
      globalDirOverride: globalDir,
      cwdOverride: cwd,
    })
    const sources = await nativeDiscovery(provider)
    expect(sources.map(item => item.path)).toEqual([defaultLedger, registeredLedger, briefLedger, cwdLedger])
    expect(sources.map(item => item.project)).toEqual([
      'default-agent',
      'registered-project-registered',
      'brief-project-brief',
      'workspace-cwd',
    ])
  })

  it('lets explicit and environment roots replace fallback discovery with the documented precedence', async () => {
    const root = tempDir()
    const explicitHome = join(root, 'explicit')
    const optionHome = join(root, 'option')
    const envHome = join(root, 'env')
    const fallbackHome = join(root, 'fallback')
    const explicitLedger = makeAgent(explicitHome, 'explicit-agent', {})
    const optionLedger = makeAgent(optionHome, 'option-agent', {})
    makeAgent(envHome, 'env-agent', {})
    makeAgent(fallbackHome, 'fallback-agent', {})
    vi.stubEnv('LINGTAI_HOME', envHome)
    vi.stubEnv('LINGTAI_TUI_HOME', fallbackHome)

    const explicitProvider = createLingTaiTuiProvider({
      lingtaiHomeOverride: [explicitHome, explicitHome].join(delimiter),
      defaultHomeOverride: fallbackHome,
    })
    await expect(nativeDiscovery(explicitProvider)).resolves.toEqual([
      { path: explicitLedger, project: 'explicit-agent', provider: 'lingtai-tui' },
    ])

    const optionProvider = createLingTaiTuiProvider({
      lingtaiHomeOverride: optionHome,
      defaultHomeOverride: fallbackHome,
    })
    await expect(nativeDiscovery(optionProvider)).resolves.toEqual([
      { path: optionLedger, project: 'option-agent', provider: 'lingtai-tui' },
    ])

    const envProvider = createLingTaiTuiProvider({ defaultHomeOverride: fallbackHome })
    await expect(nativeDiscovery(envProvider)).resolves.toEqual([
      { path: join(envHome, 'env-agent', 'logs', 'token_ledger.jsonl'), project: 'env-agent', provider: 'lingtai-tui' },
    ])

    vi.stubEnv('LINGTAI_HOME', '')
    const legacyEnvProvider = createLingTaiTuiProvider({ defaultHomeOverride: fallbackHome })
    await expect(nativeDiscovery(legacyEnvProvider)).resolves.toEqual([
      {
        path: join(fallbackHome, 'fallback-agent', 'logs', 'token_ledger.jsonl'),
        project: 'fallback-agent',
        provider: 'lingtai-tui',
      },
    ])
  })

  it('normalizes manifest fields independently and ignores invalid sibling values', async () => {
    const home = join(tempDir(), 'home')
    const ledger = makeAgent(
      home,
      'agent-one',
      {
        agent_id: { invalid: true },
        agent_name: 'Useful Agent',
        nickname: ['invalid'],
        address: 'unused-address',
        llm: { model: 42, base_url: 'https://endpoint.example', extra: false },
        unrelated: { malformed: 'ignored' },
      },
      [JSON.stringify({ output: 1 })],
    )
    const provider = createLingTaiTuiProvider({ lingtaiHomeOverride: home })
    const [call] = await nativeCalls(
      provider.createSessionParser(source(ledger), new Set(), undefined, {
        pricing: { calculateCost: () => 7, calculateLocalModelSavings: () => null },
      }),
    )

    expect(call).toMatchObject({
      project: 'Project',
      projectPath: join(home, 'agent-one'),
      sessionId: 'agent-one:main',
      model: 'unknown',
    })
  })

  it('preserves yielded-line numbering, token normalization, timestamp aliases and activity mapping', async () => {
    const agentDir = join(tempDir(), 'agent-one')
    const logsDir = join(agentDir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    writeJson(join(agentDir, '.agent.json'), {
      agent_id: 'agent-id',
      nickname: 'manifest-name',
      llm: { model: 'fallback-model', base_url: 'fallback-endpoint' },
    })
    const path = join(logsDir, 'token_ledger.jsonl')
    const entries = [
      JSON.stringify({
        source: 'tc_wake',
        run_id: 'run-one',
        ts: 1_700_000_000,
        input: '10.9',
        output: '6.8',
        thinking: 2.7,
        cached: '2.2',
        unexpected: { invalid: true },
      }),
      '',
      '{ malformed nonblank record',
      JSON.stringify({ source: 'daemon', ts: '2025-01-01T00:00:00Z', input: {}, output: 3, ignored: null }),
      JSON.stringify({ source: 'main', ts: 'invalid timestamp', input: 0, output: 0, thinking: 0, cached: 0 }),
    ]
    // The shared line reader discards blank lines; malformed nonblank lines
    // still consume a yielded-line index used by turn IDs and deduplication.
    writeFileSync(path, entries.join('\n'))
    const calculateCost = vi.fn(() => 41)
    const parser = createLingTaiTuiProvider().createSessionParser(
      source(path, 'source-project'),
      new Set(),
      undefined,
      {
        pricing: { calculateCost, calculateLocalModelSavings: () => null },
      },
    )
    const calls = await nativeCalls(parser)

    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      provider: 'lingtai-tui',
      model: 'fallback-model',
      inputTokens: 8,
      outputTokens: 6,
      cacheReadInputTokens: 2,
      cachedInputTokens: 2,
      reasoningTokens: 2,
      timestamp: '2023-11-14T22:13:20.000Z',
      deduplicationKey: `lingtai-tui:${path}:1:2023-11-14T22:13:20.000Z:fallback-model:fallback-endpoint:tc_wake::run-one:10:6:2:2`,
      turnId: 'run-one:line:1',
      sessionId: 'run-one',
      project: 'source-project',
      projectPath: agentDir,
      tools: ['Agent'],
      subagentTypes: ['lingtai-task-coordinator'],
      userMessage: 'LingTai task coordinator wake',
    })
    expect(calls[1]).toMatchObject({
      inputTokens: 0,
      outputTokens: 3,
      timestamp: '2025-01-01T00:00:00.000Z',
      deduplicationKey: `lingtai-tui:${path}:3:2025-01-01T00:00:00.000Z:fallback-model:fallback-endpoint:daemon:::0:3:0:0`,
      turnId: 'agent-id:daemon:line:3',
      sessionId: 'agent-id:daemon',
      tools: ['Agent'],
      subagentTypes: ['lingtai-daemon'],
    })
    expect(calculateCost.mock.calls).toEqual([
      ['fallback-model', 8, 8, 0, 2, 0],
      ['fallback-model', 0, 3, 0, 0, 0],
    ])
  })

  it('captures scan pricing at parser creation and prices each consumed line on pull', async () => {
    const path = makeAgent(join(tempDir(), 'home'), 'agent', {}, [
      JSON.stringify({ input: 2, output: 1 }),
      JSON.stringify({ input: 3, output: 1 }),
    ])
    const captured = vi.fn(() => 10)
    const later = vi.fn(() => 20)
    const pricing: ScanPricing = { calculateCost: captured, calculateLocalModelSavings: () => null }
    const provider = createLingTaiTuiProvider()
    const parser = provider.createSessionParser(source(path), new Set(), undefined, { pricing })
    const parseStream = parser.parseStream
    if (!parseStream) throw new Error('LingTai parser has no native Stream')
    expect(captured).not.toHaveBeenCalled()

    const first = await Effect.runPromise(Stream.runHead(parseStream()))
    expect(Option.isSome(first)).toBe(true)
    expect(Option.getOrThrow(first).costUSD).toBe(10)
    expect(captured).toHaveBeenCalledTimes(1)
    expect(later).not.toHaveBeenCalled()

    const nextProvider = createLingTaiTuiProvider()
    const nextParser = nextProvider.createSessionParser(source(path), new Set(), undefined, {
      pricing: { calculateCost: later, calculateLocalModelSavings: () => null },
    })
    const next = await nativeCalls(nextParser)
    expect(next.map(call => call.costUSD)).toEqual([20, 20])
    expect(later).toHaveBeenCalledTimes(2)
  })

  it('stops reading and drains the owned stream after an early take', async () => {
    const path = makeAgent(join(tempDir(), 'home'), 'agent', {}, [
      JSON.stringify({ input: 2, output: 1 }),
      JSON.stringify({ input: 3, output: 1 }),
    ])
    const calculateCost = vi.fn(() => 5)
    const parser = createLingTaiTuiProvider().createSessionParser(source(path), new Set(), undefined, {
      pricing: { calculateCost, calculateLocalModelSavings: () => null },
    })
    if (!parser.parseStream) throw new Error('LingTai parser has no native Stream')
    const calls = await Effect.runPromise(Stream.runCollect(parser.parseStream().pipe(Stream.take(1))))

    expect(calls).toHaveLength(1)
    expect(calculateCost).toHaveBeenCalledTimes(1)
    rmSync(path)
  })

  it('retains the caller abort reason after pricing and on discovery', async () => {
    const path = makeAgent(join(tempDir(), 'home'), 'agent', {}, [JSON.stringify({ input: 2, output: 1 })])
    const controller = new AbortController()
    const abortReason = new ScanAbortedError({ message: 'stop LingTai scan' })
    const parser = createLingTaiTuiProvider().createSessionParser(source(path), new Set(), undefined, {
      signal: controller.signal,
      pricing: {
        calculateCost: () => {
          controller.abort(abortReason)
          return 5
        },
        calculateLocalModelSavings: () => null,
      },
    })
    if (!parser.parseStream) throw new Error('LingTai parser has no native Stream')
    const parseExit = await Effect.runPromiseExit(Stream.runCollect(parser.parseStream()))
    expect(Exit.isFailure(parseExit)).toBe(true)
    if (Exit.isFailure(parseExit)) expect(Option.getOrThrow(Cause.findErrorOption(parseExit.cause))).toBe(abortReason)

    const alreadyAborted = new AbortController()
    alreadyAborted.abort(abortReason)
    const provider = createLingTaiTuiProvider({ lingtaiHomeOverride: join(tempDir(), 'missing') })
    if (!provider.discoverSessionsEffect) throw new Error('LingTai native discovery is unavailable')
    const discoveryExit = await Effect.runPromiseExit(
      provider.discoverSessionsEffect({ signal: alreadyAborted.signal }).pipe(Effect.provide(Env.layer)),
    )
    expect(Exit.isFailure(discoveryExit)).toBe(true)
    if (Exit.isFailure(discoveryExit)) {
      expect(Option.getOrThrow(Cause.findErrorOption(discoveryExit.cause))).toBe(abortReason)
    }
  })

  it('keeps pricing callback failures in the stream error channel', async () => {
    const path = makeAgent(join(tempDir(), 'home'), 'agent', {}, [JSON.stringify({ input: 2, output: 1 })])
    const pricingError = new Error('LingTai pricing failed')
    const parser = createLingTaiTuiProvider().createSessionParser(source(path), new Set(), undefined, {
      pricing: {
        calculateCost: () => {
          throw pricingError
        },
        calculateLocalModelSavings: () => null,
      },
    })
    if (!parser.parseStream) throw new Error('LingTai parser has no native Stream')
    const exit = await Effect.runPromiseExit(Stream.runCollect(parser.parseStream()))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBe(pricingError)
  })
})
