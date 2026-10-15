import { Effect, Fiber, Stream } from 'effect'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const readerHooks = vi.hoisted(() => ({
  onClose: undefined as (() => void) | undefined,
  readdirPath: undefined as string | undefined,
  onReaddirStarted: undefined as (() => void) | undefined,
  releaseReaddir: undefined as (() => void) | undefined,
}))

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args)
      stream.once('close', () => readerHooks.onClose?.())
      return stream
    },
  }
})

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (args[0] === readerHooks.readdirPath && readerHooks.releaseReaddir) {
        readerHooks.onReaddirStarted?.()
        await new Promise<void>(resolve => {
          readerHooks.releaseReaddir = resolve
        })
      }
      return actual.readdir(...args)
    },
  }
})

import { Env } from '../src/main/env.js'
import { calculateCost } from '../src/main/pipeline/models.js'
import { createQwenProvider } from '../src/main/pipeline/providers/qwen.js'
import type { Provider, SessionParser, SessionSource } from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'watchtower-qwen-effect-'))
  readerHooks.onClose = undefined
  readerHooks.readdirPath = undefined
  readerHooks.onReaddirStarted = undefined
  readerHooks.releaseReaddir = undefined
})

afterEach(async () => {
  readerHooks.onClose = undefined
  readerHooks.readdirPath = undefined
  readerHooks.onReaddirStarted = undefined
  readerHooks.releaseReaddir = undefined
  await rm(root, { recursive: true, force: true })
})

function nativeDiscovery(provider: Provider): NonNullable<Provider['discoverSessionsEffect']> {
  if (!provider.discoverSessionsEffect) throw new Error('Qwen provider did not expose native discovery')
  return provider.discoverSessionsEffect
}

function parserStream(parser: SessionParser): NonNullable<SessionParser['parseStream']> {
  if (!parser.parseStream) throw new Error('Qwen parser did not expose its native stream')
  return parser.parseStream
}

function source(path: string): SessionSource {
  return { path, project: 'fixture-project', provider: 'qwen' }
}

function record(overrides: object = {}) {
  return JSON.stringify({
    type: 'assistant',
    uuid: 'call-1',
    sessionId: 'session-1',
    timestamp: '2026-10-01T00:00:00.000Z',
    model: 'qwen-fixture',
    message: { role: 'assistant', parts: [] },
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 5,
      totalTokenCount: 155,
      cachedContentTokenCount: 20,
    },
    ...overrides,
  })
}

describe('Qwen Effect provider', () => {
  it('discovers chat JSONL files in filesystem order and retains the project-name rule', async () => {
    const projects = join(root, 'projects')
    const firstChats = join(projects, '-workspace-my-repo', 'chats')
    const secondChats = join(projects, 'plain', 'chats')
    await mkdir(firstChats, { recursive: true })
    await mkdir(secondChats, { recursive: true })
    await writeFile(join(firstChats, 'first.jsonl'), '{}')
    await writeFile(join(firstChats, 'ignored.json'), '{}')
    await mkdir(join(firstChats, 'directory.jsonl'))
    await writeFile(join(secondChats, 'second.jsonl'), '{}')

    const provider = createQwenProvider(projects)
    const effectSources = await Effect.runPromise(nativeDiscovery(provider)().pipe(Effect.provide(Env.layer)))
    expect(effectSources).toEqual([
      { path: join(firstChats, 'first.jsonl'), project: 'repo', provider: 'qwen' },
      { path: join(secondChats, 'second.jsonl'), project: 'plain', provider: 'qwen' },
    ])
    await expect(provider.discoverSessions()).resolves.toEqual(effectSources)
    await expect(
      Effect.runPromise(nativeDiscovery(createQwenProvider(join(root, 'missing')))().pipe(Effect.provide(Env.layer))),
    ).resolves.toEqual([])
  })

  it('decodes each line with Schema, retains valid content siblings, and preserves Qwen billing semantics', async () => {
    const path = join(root, 'session.jsonl')
    await writeFile(
      path,
      [
        '{malformed json',
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            parts: [
              { text: 'first', functionCall: { name: 42 } },
              null,
              { text: 'ignored thought', thought: true },
              { text: 'question' },
            ],
          },
        }),
        record({
          subtype: { invalid: true },
          cwd: 42,
          message: {
            role: { invalid: true },
            parts: [
              null,
              { text: 42, functionCall: { name: 'read_file', args: { path: '/tmp/a' } } },
              { functionCall: { name: 'execute_command', args: { command: 'git status && npm test' } } },
              { functionCall: { name: 'execute_command', args: { command: 42 } } },
              { functionCall: { name: 'read_file' } },
            ],
          },
        }),
        record({ uuid: 'bad-token-count', usageMetadata: { promptTokenCount: 'many', candidatesTokenCount: 50 } }),
        record({ uuid: 'null-required-total', usageMetadata: { promptTokenCount: null, candidatesTokenCount: 4 } }),
        record({ uuid: 'missing-required-total', usageMetadata: { candidatesTokenCount: 4 } }),
        record({
          uuid: 'nullable-defaults',
          model: null,
          timestamp: null,
          usageMetadata: {
            promptTokenCount: 0,
            candidatesTokenCount: 2,
            thoughtsTokenCount: null,
            cachedContentTokenCount: null,
          },
        }),
        record({ uuid: 'non-finite', usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 3 } }).replace(
          '"promptTokenCount":0',
          '"promptTokenCount":1e309',
        ),
        record({ uuid: 'zero', usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0 } }),
        record({ uuid: undefined, message: 'malformed message is unused for assistant usage' }),
        record({ uuid: '', sessionId: '', message: { role: 42, parts: null } }),
      ].join('\n'),
    )
    const provider = createQwenProvider(root)
    const calls = await Effect.runPromise(
      Stream.runCollect(parserStream(provider.createSessionParser(source(path), new Set()))()),
    )

    expect(calls).toHaveLength(4)
    expect(calls[0]).toMatchObject({
      provider: 'qwen',
      model: 'qwen-fixture',
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 20,
      cachedInputTokens: 20,
      reasoningTokens: 5,
      tools: ['Read', 'Bash'],
      bashCommands: ['git', 'npm'],
      deduplicationKey: 'qwen:session-1:call-1',
      userMessage: 'first question',
      timestamp: '2026-10-01T00:00:00.000Z',
    })
    expect(calls[0]?.costUSD).toBeCloseTo(calculateCost('qwen-fixture', 100, 55, 0, 20, 0))
    expect(calls[1]).toMatchObject({
      model: 'qwen-auto',
      inputTokens: 0,
      outputTokens: 2,
      reasoningTokens: 0,
      cacheReadInputTokens: 0,
      deduplicationKey: 'qwen:session-1:nullable-defaults',
      userMessage: '',
      timestamp: '',
    })
    expect(calls[2]).toMatchObject({
      deduplicationKey: 'qwen:session-1:undefined',
      sessionId: 'session-1',
      tools: [],
      userMessage: '',
    })
    expect(calls[3]).toMatchObject({
      deduplicationKey: 'qwen::',
      sessionId: '',
      tools: [],
    })
  })

  it('keeps only consumed dedup keys and closes the owned reader after early termination', async () => {
    const path = join(root, 'incremental.jsonl')
    await writeFile(path, [record({ uuid: 'first' }), record({ uuid: 'second' }), record({ uuid: 'third' })].join('\n'))
    let markClosed!: () => void
    const closed = new Promise<void>(resolve => {
      markClosed = resolve
    })
    readerHooks.onClose = markClosed
    const seenKeys = new Set<string>()
    const parser = createQwenProvider().createSessionParser(source(path), seenKeys)

    const calls = await Effect.runPromise(Stream.runCollect(parserStream(parser)().pipe(Stream.take(1))))
    await closed

    expect(calls.map(call => call.deduplicationKey)).toEqual(['qwen:session-1:first'])
    expect(seenKeys).toEqual(new Set(['qwen:session-1:first']))
  })

  it('preserves the typed scan-abort reason and closes the reader', async () => {
    const path = join(root, 'cancel.jsonl')
    await writeFile(path, [record({ uuid: 'first' }), record({ uuid: 'second' })].join('\n'))
    let markClosed!: () => void
    const closed = new Promise<void>(resolve => {
      markClosed = resolve
    })
    readerHooks.onClose = markClosed
    const reason = new ScanAbortedError({ message: 'stop Qwen scan' })
    const controller = new AbortController()
    const parser = createQwenProvider().createSessionParser(source(path), new Set(), undefined, {
      signal: controller.signal,
    })
    const calls = parserStream(parser)().pipe(Stream.tap(() => Effect.sync(() => controller.abort(reason))))

    await expect(Effect.runPromise(Stream.runCollect(calls))).rejects.toBe(reason)
    await closed
  })

  it('preserves the typed scan-abort reason before discovery IO', async () => {
    const reason = new ScanAbortedError({ message: 'stop Qwen discovery' })
    const controller = new AbortController()
    controller.abort(reason)

    await expect(
      Effect.runPromise(
        nativeDiscovery(createQwenProvider(root))({ signal: controller.signal }).pipe(Effect.provide(Env.layer)),
      ),
    ).rejects.toBe(reason)
  })

  it('waits for a pending directory read to settle before interrupted discovery exits', async () => {
    const projects = join(root, 'projects')
    await mkdir(projects)
    readerHooks.readdirPath = projects
    let markStarted!: () => void
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    readerHooks.onReaddirStarted = markStarted
    readerHooks.releaseReaddir = () => undefined
    const fiber = Effect.runFork(nativeDiscovery(createQwenProvider(projects))().pipe(Effect.provide(Env.layer)))
    await started

    let settled = false
    const interruption = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      settled = true
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    readerHooks.releaseReaddir?.()
    await interruption
    expect(settled).toBe(true)
  })
})
