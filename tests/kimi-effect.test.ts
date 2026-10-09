import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Cause, Effect, Exit, Option, Stream } from 'effect'
import { mkdir, writeFile } from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nativeIo = vi.hoisted(() => ({
  readerEvents: [] as string[],
  onReaderCreated: undefined as (() => void) | undefined,
  onReaderOpen: undefined as (() => void) | undefined,
  pauseReaddirPath: undefined as string | undefined,
  readdirStarted: undefined as (() => void) | undefined,
  releaseReaddir: undefined as (() => void) | undefined,
}))

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args)
      const path = String(args[0])
      stream.once('open', () => {
        nativeIo.readerEvents.push(`open:${path}`)
        nativeIo.onReaderOpen?.()
      })
      nativeIo.onReaderCreated?.()
      stream.once('close', () => nativeIo.readerEvents.push(`close:${path}`))
      return stream
    },
  }
})

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (args[0] === nativeIo.pauseReaddirPath && nativeIo.releaseReaddir) {
        nativeIo.readdirStarted?.()
        await new Promise<void>(resolve => {
          nativeIo.releaseReaddir = resolve
        })
      }
      return actual.readdir(...args)
    },
  }
})

import { Env } from '../src/main/env.js'
import { createKimiProvider } from '../src/main/pipeline/providers/kimi.js'
import type { Provider, SessionParser, SessionSource } from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'

let root = ''
const priorKimiModelName = process.env['KIMI_MODEL_NAME']

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-kimi-effect-'))
  delete process.env['KIMI_MODEL_NAME']
  nativeIo.readerEvents.length = 0
  nativeIo.onReaderCreated = undefined
  nativeIo.pauseReaddirPath = undefined
  nativeIo.readdirStarted = undefined
  nativeIo.releaseReaddir = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  if (priorKimiModelName === undefined) delete process.env['KIMI_MODEL_NAME']
  else process.env['KIMI_MODEL_NAME'] = priorKimiModelName
  nativeIo.onReaderCreated = undefined
  nativeIo.onReaderOpen = undefined
  rmSync(root, { recursive: true, force: true })
})

async function writeLines(path: string, lines: readonly (string | unknown)[]): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n'))
}

function source(path: string): SessionSource {
  return { path, project: 'fixture', provider: 'kimi' }
}

function parser(
  path: string,
  seenKeys = new Set<string>(),
  signal?: AbortSignal,
  pricing?: ScanPricing,
): SessionParser {
  const context = signal || pricing ? { ...(signal ? { signal } : {}), ...(pricing ? { pricing } : {}) } : undefined
  return createKimiProvider(root).createSessionParser(source(path), seenKeys, undefined, context)
}

function parserStream(value: SessionParser): ReturnType<NonNullable<SessionParser['parseStream']>> {
  if (!value.parseStream) throw new Error('Kimi parser did not expose its native Stream')
  return value.parseStream()
}

function discovery(provider: Provider, signal?: AbortSignal) {
  if (!provider.discoverSessionsEffect) throw new Error('Kimi provider did not expose native discovery')
  return provider.discoverSessionsEffect(signal ? { signal } : undefined).pipe(Effect.provide(Env.layer))
}

function status(payload: unknown, timestamp: unknown = '2026-10-01T00:00:00.000Z', nested = true): unknown {
  const value = { type: 'StatusUpdate', payload }
  return nested ? { message: value, timestamp } : { ...value, timestamp }
}

const pricing = (calculateCost: ScanPricing['calculateCost']): ScanPricing => ({
  calculateCost,
  calculateLocalModelSavings: () => null,
})

describe('Kimi Effect provider', () => {
  it('discovers wire files in directory order, applies work-dir aliases, and includes subagents', async () => {
    const workPath = '/work/acme/repo/'
    const hash = createHash('md5').update(workPath, 'utf-8').digest('hex')
    const workDirKey = `remote_${hash}`
    await writeFile(join(root, 'kimi.json'), JSON.stringify({ work_dirs: [{ path: workPath, kaos: 'remote' }] }))
    const sessionPath = join(root, 'sessions', workDirKey, 'session-a')
    await writeLines(join(sessionPath, 'wire.jsonl'), [])
    await writeLines(join(sessionPath, 'subagents', 'agent-a', 'wire.jsonl'), [])
    await writeLines(join(root, 'sessions', 'raw-work-dir', 'session-b', 'wire.jsonl'), [])
    const result = await Effect.runPromise(discovery(createKimiProvider(root)))
    expect(result).toHaveLength(3)
    expect(result).toEqual(
      expect.arrayContaining([
        { path: join(sessionPath, 'wire.jsonl'), project: 'repo', provider: 'kimi' },
        { path: join(sessionPath, 'subagents', 'agent-a', 'wire.jsonl'), project: 'repo', provider: 'kimi' },
        {
          path: join(root, 'sessions', 'raw-work-dir', 'session-b', 'wire.jsonl'),
          project: 'raw-work-dir',
          provider: 'kimi',
        },
      ]),
    )
    expect(result.findIndex(item => item.path === join(sessionPath, 'wire.jsonl'))).toBeLessThan(
      result.findIndex(item => item.path === join(sessionPath, 'subagents', 'agent-a', 'wire.jsonl')),
    )
  })

  it('continues discovery with raw directory names when kimi.json is malformed', async () => {
    await writeFile(join(root, 'kimi.json'), '{ malformed config')
    const wirePath = join(root, 'sessions', 'unmapped-work-dir', 'session-a', 'wire.jsonl')
    await writeLines(wirePath, [])

    const result = await Effect.runPromise(discovery(createKimiProvider(root)))
    expect(result).toEqual([{ path: wirePath, project: 'unmapped-work-dir', provider: 'kimi' }])
  })

  it('parses legacy nested and flat wire records with hardcoded usage, tool, message, model, and timestamp output', async () => {
    const path = join(root, 'sessions', 'session-wire', 'wire.jsonl')
    await writeFile(
      join(root, 'config.toml'),
      '[models."kimi-key"]\nmodel = "kimi-configured"\n\n[other]\nvalue = 1\n\ndefault_model = "kimi-key"\n',
    )
    await writeLines(path, [
      { type: 'TurnBegin', payload: { user_input: 'first prompt' }, timestamp: 1_700_000_000 },
      { type: 'ToolCall', payload: { function: { name: 'Shell', arguments: '{"command":"git status && npm test"}' } } },
      { type: 'ToolCall', payload: { function: { name: 'Shell', arguments: '{"command":"git status && npm test"}' } } },
      status(
        {
          message_id: 'message-1',
          token_usage: {
            input_other: '12.9',
            input_cache_read: '3.8',
            input_cache_creation: 2,
            output: '8.6',
            ignored_broken_sibling: { deeply: ['invalid but unconsumed'] },
          },
        },
        1_700_000_001,
      ),
      { type: 'TurnEnd', payload: {} },
      status(
        { message_id: 'message-2', model_name: 'kimi-explicit', usage: { input: 20, output_tokens: 5 } },
        'seen-as-is',
        false,
      ),
    ])

    const calls = await Effect.runPromise(
      Stream.runCollect(
        parserStream(
          parser(
            path,
            new Set(),
            undefined,
            pricing(() => 123.45),
          ),
        ),
      ),
    )
    expect([...calls]).toEqual([
      {
        provider: 'kimi',
        model: 'kimi-configured',
        inputTokens: 12,
        outputTokens: 8,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 3,
        cachedInputTokens: 3,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD: 123.45,
        tools: ['Bash'],
        bashCommands: ['git', 'npm'],
        timestamp: '2023-11-14T22:13:21.000Z',
        speed: 'standard',
        deduplicationKey: 'kimi:session-wire:message-1',
        userMessage: 'first prompt',
        sessionId: 'session-wire',
      },
      {
        provider: 'kimi',
        model: 'kimi-explicit',
        inputTokens: 20,
        outputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD: 123.45,
        tools: [],
        bashCommands: [],
        timestamp: 'seen-as-is',
        speed: 'standard',
        deduplicationKey: 'kimi:session-wire:message-2',
        userMessage: '',
        sessionId: 'session-wire',
      },
    ])
  })

  it('keeps the first valid numeric alias, truncates numeric strings, subtracts cache fallback, and skips empty usage', async () => {
    const path = join(root, 'sessions', 'session-usage', 'wire.jsonl')
    await writeLines(path, [
      status({
        message_id: 'usage-1',
        token_usage: {
          input_cache_read: { malformed: true },
          cache_read_input_tokens: '4.9',
          cached_input_tokens: 19,
          input_cache_creation: '2.8',
          input_other: '0',
          input_tokens: '7.6',
          input: 100,
          output: -2,
          output_tokens: '3.2',
          malformed_unconsumed_sibling: null,
        },
      }),
      status({
        message_id: 'usage-2',
        usage: { input: '12.9', input_cache_read: '2.1', input_cache_creation: '3', output: '5.9' },
      }),
      status({ message_id: 'empty', token_usage: { output: 0, input: 0 } }),
    ])
    const calls = await Effect.runPromise(Stream.runCollect(parserStream(parser(path))))
    expect(
      [...calls].map(call => ({
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        cacheReadInputTokens: call.cacheReadInputTokens,
        cacheCreationInputTokens: call.cacheCreationInputTokens,
        deduplicationKey: call.deduplicationKey,
      })),
    ).toEqual([
      {
        inputTokens: 7,
        outputTokens: 3,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 2,
        deduplicationKey: 'kimi:session-usage:usage-1',
      },
      {
        inputTokens: 7,
        outputTokens: 5,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 3,
        deduplicationKey: 'kimi:session-usage:usage-2',
      },
    ])
  })

  it('keeps a nested object authoritative even when its envelope is malformed', async () => {
    const path = join(root, 'sessions', 'session-envelope', 'wire.jsonl')
    const flat = {
      type: 'StatusUpdate',
      payload: { message_id: 'flat', usage: { input_other: 1, output: 1 } },
    }
    await writeLines(path, [
      { ...flat, message: { type: 42, payload: flat.payload } },
      { ...flat, message: {} },
      { ...flat, message: [] },
    ])
    const calls = await Effect.runPromise(Stream.runCollect(parserStream(parser(path))))
    expect([...calls].map(call => call.deduplicationKey)).toEqual(['kimi:session-envelope:flat'])
  })

  it('captures explicit scan pricing and prices only a pulled, nonduplicate call', async () => {
    const path = join(root, 'sessions', 'session-price', 'wire.jsonl')
    await writeLines(path, [
      status({ message_id: 'price-1', model: 'Kimi-Model', usage: { input_other: 10, output: 3 } }),
      status({ message_id: 'price-2', usage: { input_other: 20, output: 4 } }),
    ])
    const priced: unknown[][] = []
    const captured = pricing((...args) => {
      priced.push(args)
      return priced.length * 11
    })
    const seen = new Set(['kimi:session-price:price-2'])
    const head = await Effect.runPromise(Stream.runHead(parserStream(parser(path, seen, undefined, captured))))
    expect(Option.isSome(head) ? head.value : undefined).toMatchObject({
      model: 'Kimi-Model',
      costUSD: 11,
      deduplicationKey: 'kimi:session-price:price-1',
    })
    expect(priced).toEqual([['Kimi-Model', 10, 3, 0, 0, 0]])
    expect(seen).toEqual(new Set(['kimi:session-price:price-1', 'kimi:session-price:price-2']))
    expect(nativeIo.readerEvents).toContain(`close:${path}`)
  })

  it('retains a dedup key before a pricing failure and does not price the duplicate on a later parse', async () => {
    const path = join(root, 'sessions', 'session-price-failure', 'wire.jsonl')
    await writeLines(path, [status({ message_id: 'same', usage: { input_other: 1, output: 1 } })])
    const seen = new Set<string>()
    const failing = parser(
      path,
      seen,
      undefined,
      pricing(() => {
        throw new Error('pricing failed')
      }),
    )
    const result = await Effect.runPromiseExit(Stream.runCollect(parserStream(failing)))
    expect(Exit.isFailure(result)).toBe(true)
    expect(seen).toEqual(new Set(['kimi:session-price-failure:same']))
    const calls: number[] = []
    const retryParser = parser(
      path,
      seen,
      undefined,
      pricing(() => {
        calls.push(1)
        return 0
      }),
    )
    expect([...(await Effect.runPromise(Stream.runCollect(parserStream(retryParser))))]).toEqual([])
    expect(calls).toEqual([])
  })

  it('clears tools after each call and retains the prompt until TurnEnd, without synthesizing at EOF', async () => {
    const path = join(root, 'sessions', 'session-state', 'wire.jsonl')
    await writeLines(path, [
      {
        type: 'TurnBegin',
        payload: { user_input: [{ text: 'part one' }, { text: null }, { text: 'part two' }, { wrong: true }] },
      },
      { type: 'ToolCallRequest', payload: { name: 'ReadFile', arguments: '{broken json' } },
      { type: 'TurnEnd', payload: {} },
      { type: 'SteerInput', payload: { user_input: 'second prompt' } },
      { type: 'ToolCall', payload: { name: 'FetchURL' } },
      status({ message_id: 'state-call-1', usage: { input_other: 1, output: 1 } }),
      status({ message_id: 'state-call-2', usage: { input_other: 2, output: 2 } }),
      { type: 'ToolCall', payload: { name: 'Glob' } },
    ])
    const calls = await Effect.runPromise(Stream.runCollect(parserStream(parser(path))))
    expect([...calls]).toMatchObject([
      { tools: ['WebFetch'], userMessage: 'second prompt', deduplicationKey: 'kimi:session-state:state-call-1' },
      { tools: [], userMessage: 'second prompt', deduplicationKey: 'kimi:session-state:state-call-2' },
    ])
  })

  it('waits for pending native discovery IO and then fails with the exact abort reason', async () => {
    const sessionsRoot = join(root, 'sessions')
    await mkdir(sessionsRoot, { recursive: true })
    const reason = new ScanAbortedError({ message: 'stop discovery now' })
    const controller = new AbortController()
    nativeIo.pauseReaddirPath = sessionsRoot
    let markStarted!: () => void
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    nativeIo.readdirStarted = markStarted
    nativeIo.releaseReaddir = () => undefined
    const exit = Effect.runPromiseExit(discovery(createKimiProvider(root), controller.signal))
    let settled = false
    void exit.then(() => {
      settled = true
    })
    await started
    controller.abort(reason)
    await Promise.resolve()
    expect(settled).toBe(false)
    nativeIo.releaseReaddir?.()
    const result = await exit
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const failure = Cause.findErrorOption(result.cause)
      expect(Option.isSome(failure) ? failure.value : undefined).toBe(reason)
    }
    expect(settled).toBe(true)
  })

  it('closes the native reader before returning the exact scan abort reason', async () => {
    const path = join(root, 'sessions', 'session-abort', 'wire.jsonl')
    await writeLines(
      path,
      Array.from({ length: 100 }, (_, index) =>
        status({ message_id: `call-${index}`, usage: { input_other: 1, output: 1 } }),
      ),
    )
    const reason = new ScanAbortedError({ message: 'stop parser now' })
    const controller = new AbortController()
    let markOpened!: () => void
    const opened = new Promise<void>(resolve => {
      markOpened = resolve
    })
    nativeIo.onReaderOpen = markOpened
    const parse = Effect.runPromiseExit(Stream.runCollect(parserStream(parser(path, new Set(), controller.signal))))
    await opened
    controller.abort(reason)
    const result = await parse
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const failure = Cause.findErrorOption(result.cause)
      expect(Option.isSome(failure) ? failure.value : undefined).toBe(reason)
    }
    expect(nativeIo.readerEvents).toContain(`close:${path}`)
  })
})
