import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Cause, Effect, Exit, Option, Stream } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Env } from '../src/main/env.js'
import { createClineProvider } from '../src/main/pipeline/providers/cline.js'
import { createIBMBobProvider } from '../src/main/pipeline/providers/ibm-bob.js'
import { createKiloCodeProvider } from '../src/main/pipeline/providers/kilo-code.js'
import { createRooCodeProvider } from '../src/main/pipeline/providers/roo-code.js'
import type { Provider, SessionSource } from '../src/main/pipeline/providers/types.js'
import { createClineParser } from '../src/main/pipeline/providers/vscode-cline-parser.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'watchtower-vscode-cline-effect-'))
  tempDirs.push(dir)
  return dir
}

function makeTask(baseDir: string, taskId: string, messages: unknown[], history: unknown[] = []): string {
  const taskDir = join(baseDir, 'tasks', taskId)
  mkdirSync(taskDir, { recursive: true })
  writeFileSync(join(taskDir, 'ui_messages.json'), JSON.stringify(messages))
  writeFileSync(join(taskDir, 'api_conversation_history.json'), JSON.stringify(history))
  return taskDir
}

function nativeDiscovery(provider: Provider, signal?: AbortSignal): Promise<SessionSource[]> {
  if (!provider.discoverSessionsEffect) throw new Error(`${provider.name} has no native discovery`)
  return Effect.runPromise(
    provider.discoverSessionsEffect(signal ? { signal } : undefined).pipe(Effect.provide(Env.layer)),
  )
}

describe('VS Code Cline family Effect provider', () => {
  it('rejects malformed consumed counters and costs while retaining nullish and negative cost semantics', async () => {
    const taskDir = makeTask(tempDir(), 'fixture', [])
    const source: SessionSource = { path: taskDir, project: 'Cline', provider: 'cline' }
    const seen = new Set<string>()
    const calculateCost = vi.fn(() => 11)
    const onUnparsedCall = vi.fn()
    const pricing: ScanPricing = { calculateCost, calculateLocalModelSavings: () => null }
    const parser = createClineParser(source, seen, 'cline', 'cline-auto', pricing)
    const api = (fields: Record<string, unknown>, ts?: unknown) => ({
      type: 'say',
      say: 'api_req_started',
      ...(ts === undefined ? {} : { ts }),
      text: JSON.stringify(fields),
    })
    writeFileSync(
      join(taskDir, 'ui_messages.json'),
      JSON.stringify([
        { type: 'say', say: 'text', text: 'first user request' },
        api({ tokensIn: 4, tokensOut: 2, cacheReads: 3, cacheWrites: 1, cost: null }, 1_700_000_000_000),
        api({ tokensIn: 0, tokensOut: 0, cost: 'malformed' }, 1_700_000_001_000),
        api({ tokensIn: 'bad-token-field', tokensOut: 3 }),
        api({ tokensIn: 2, tokensOut: 0, cost: 'bad-cost' }),
        api({ tokensIn: 0, tokensOut: 3, cost: 0 }, '2024-03-04T05:06:07.000Z'),
        api({ tokensIn: -1, tokensOut: 0, cost: -2 }, 0),
        { type: 'say', say: 'api_req_started', text: '[]' },
      ]),
    )
    writeFileSync(
      join(taskDir, 'api_conversation_history.json'),
      JSON.stringify([
        null,
        { role: 'user', content: ['bad sibling', { text: '<model>vendor/model-x</model>' }] },
        { role: 'user', content: [{ text: 'Current Workspace Directory (/workspace/project)' }] },
      ]),
    )

    if (!parser.parseStream) throw new Error('Cline parser has no native Stream')
    const stream = parser.parseStream(Effect.sync(onUnparsedCall))
    expect(calculateCost).not.toHaveBeenCalled()
    expect(seen).toEqual(new Set())
    const calls = await Effect.runPromise(Stream.runCollect(stream).pipe(Effect.provide(Env.layer))).then(result =>
      Array.from(result),
    )

    expect(calls).toEqual([
      {
        provider: 'cline',
        model: 'model-x',
        inputTokens: 4,
        outputTokens: 2,
        cacheCreationInputTokens: 1,
        cacheReadInputTokens: 3,
        cachedInputTokens: 3,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD: 11,
        tools: [],
        bashCommands: [],
        timestamp: '2023-11-14T22:13:20.000Z',
        speed: 'standard',
        deduplicationKey: 'cline:fixture:0',
        userMessage: 'first user request',
        sessionId: 'fixture',
        project: 'project',
        projectPath: '/workspace/project',
      },
      expect.objectContaining({
        inputTokens: 0,
        outputTokens: 3,
        costUSD: 0,
        timestamp: '2024-03-04T05:06:07.000Z',
        deduplicationKey: 'cline:fixture:4',
        userMessage: '',
      }),
      expect.objectContaining({
        inputTokens: -1,
        outputTokens: 0,
        costUSD: -2,
        timestamp: '',
        deduplicationKey: 'cline:fixture:5',
      }),
    ])
    expect(calculateCost).toHaveBeenCalledTimes(1)
    expect(calculateCost).toHaveBeenCalledWith('model-x', 4, 2, 1, 3, 0)
    expect(onUnparsedCall).toHaveBeenCalledTimes(2)
    expect(seen).toEqual(
      new Set([
        'cline:fixture:0',
        'cline:fixture:1',
        'cline:fixture:2',
        'cline:fixture:3',
        'cline:fixture:4',
        'cline:fixture:5',
        'cline:fixture:6',
      ]),
    )
  })

  it('fails on a late invalid truthy timestamp after the earlier pull and pricing', async () => {
    const taskDir = makeTask(tempDir(), 'timestamps', [
      {
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({ tokensIn: 1, tokensOut: 0 }),
        ts: 1_700_000_000_000,
      },
      {
        type: 'say',
        say: 'api_req_started',
        text: JSON.stringify({ tokensIn: 'bad-token-field', tokensOut: 0, cost: 'bad-cost' }),
        ts: 'invalid-date',
      },
    ])
    const seen = new Set<string>()
    const calculateCost = vi.fn(() => 5)
    const onUnparsedCall = vi.fn()
    const parser = createClineParser(
      { path: taskDir, project: 'Cline', provider: 'cline' },
      seen,
      'cline',
      'cline-auto',
      { calculateCost, calculateLocalModelSavings: () => null },
    )
    if (!parser.parseStream) throw new Error('Cline parser has no native Stream')

    const exit = await Effect.runPromiseExit(
      Stream.runCollect(parser.parseStream(Effect.sync(onUnparsedCall))).pipe(Effect.provide(Env.layer)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Option.getOrThrow(Cause.findErrorOption(exit.cause))
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toContain('Invalid time value')
    }
    expect(calculateCost).toHaveBeenCalledTimes(1)
    expect(onUnparsedCall).not.toHaveBeenCalled()
    expect(seen).toEqual(new Set(['cline:timestamps:0', 'cline:timestamps:1']))
  })

  it('keeps pricing callback throws in the typed error channel', async () => {
    const taskDir = makeTask(tempDir(), 'pricing-error', [
      { type: 'say', say: 'api_req_started', text: JSON.stringify({ tokensIn: 1, tokensOut: 0 }) },
    ])
    const pricingError = new Error('pricing callback failed')
    const calculateCost = vi.fn(() => {
      throw pricingError
    })
    const parser = createClineParser(
      { path: taskDir, project: 'Cline', provider: 'cline' },
      new Set(),
      'cline',
      'cline-auto',
      { calculateCost, calculateLocalModelSavings: () => null },
    )
    if (!parser.parseStream) throw new Error('Cline parser has no native Stream')

    const exit = await Effect.runPromiseExit(Stream.runCollect(parser.parseStream()).pipe(Effect.provide(Env.layer)))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBe(pricingError)
  })

  it('uses captured candidate stats for Cline newest-first task-ID dedupe', async () => {
    const older = tempDir()
    const newer = tempDir()
    const olderTask = makeTask(older, 'same-id', [])
    const newerTask = makeTask(newer, 'same-id', [])
    const oldTime = new Date('2024-01-01T00:00:00Z')
    const newTime = new Date('2025-01-01T00:00:00Z')
    utimesSync(join(olderTask, 'ui_messages.json'), oldTime, oldTime)
    utimesSync(join(newerTask, 'ui_messages.json'), newTime, newTime)
    const provider = createClineProvider([older, newer])

    await expect(nativeDiscovery(provider)).resolves.toEqual([{ path: newerTask, project: 'Cline', provider: 'cline' }])
  })

  it('exposes native discovery only for fully migrated Cline, Roo, and IBM Bob chains', async () => {
    const base = tempDir()
    const task = makeTask(base, 'task-1', [])
    const cline = createClineProvider(base)
    const roo = createRooCodeProvider(base)
    const bob = createIBMBobProvider(base)
    const kilo = createKiloCodeProvider(base)

    await expect(nativeDiscovery(cline)).resolves.toEqual([{ path: task, project: 'Cline', provider: 'cline' }])
    await expect(nativeDiscovery(roo)).resolves.toEqual([{ path: task, project: 'Roo Code', provider: 'roo-code' }])
    await expect(nativeDiscovery(bob)).resolves.toEqual([{ path: task, project: 'IBM Bob', provider: 'ibm-bob' }])
    expect(kilo.discoverSessionsEffect).toBeUndefined()
  })

  it('preserves cancellation reasons at parser and discovery boundaries', async () => {
    const base = tempDir()
    const taskDir = makeTask(base, 'task-1', [
      { type: 'say', say: 'api_req_started', text: JSON.stringify({ tokensIn: 1, tokensOut: 0 }) },
    ])
    const abortReason = new ScanAbortedError({ message: 'stop Cline parse' })
    const controller = new AbortController()
    const pricing: ScanPricing = {
      calculateCost: () => {
        controller.abort(abortReason)
        return 5
      },
      calculateLocalModelSavings: () => null,
    }
    const parser = createClineParser(
      { path: taskDir, project: 'Cline', provider: 'cline' },
      new Set(),
      'cline',
      'cline-auto',
      pricing,
      { signal: controller.signal },
    )
    if (!parser.parseStream) throw new Error('Cline parser has no native Stream')

    const exit = await Effect.runPromiseExit(Stream.runCollect(parser.parseStream()).pipe(Effect.provide(Env.layer)))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBe(abortReason)

    const alreadyAborted = new AbortController()
    alreadyAborted.abort(abortReason)
    await expect(nativeDiscovery(createRooCodeProvider(base), alreadyAborted.signal)).rejects.toBe(abortReason)
  })
})
