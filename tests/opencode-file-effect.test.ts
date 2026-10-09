import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Effect, Option, Result, Schema, Stream } from 'effect'
import { mkdir, readdir, writeFile } from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nativeIo = vi.hoisted(() => ({
  reads: [] as string[],
  directories: [] as string[],
  stats: [] as string[],
  pendingPath: undefined as string | undefined,
  onPendingRead: undefined as (() => void) | undefined,
  releasePendingRead: undefined as ((value: string) => void) | undefined,
  onReadSettled: undefined as (() => void) | undefined,
}))

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
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
    readdir: (...args: Parameters<typeof actual.readdir>) => {
      nativeIo.directories.push(String(args[0]))
      return actual.readdir(...args)
    },
    stat: (...args: Parameters<typeof actual.stat>) => {
      nativeIo.stats.push(String(args[0]))
      return actual.stat(...args)
    },
  }
})

import {
  createOpenCodeFileSessionParser,
  discoverOpenCodeFileSessions,
  discoverOpenCodeFileSessionsEffect,
} from '../src/main/pipeline/providers/opencode-file-parser.js'
import type { SessionParser, SessionSource } from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'
import { parsedProviderCallSchema } from '../src/shared/schemas/providers.js'

let dataDir = ''

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'watchtower-opencode-file-effect-'))
  nativeIo.reads.length = 0
  nativeIo.directories.length = 0
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
  rmSync(dataDir, { recursive: true, force: true })
})

function metaPath(project = 'project', session = 'session-one'): string {
  return join(dataDir, 'storage', 'session', project, `${session}.json`)
}

function messagePath(sessionId: string, file: string): string {
  return join(dataDir, 'storage', 'message', sessionId, file)
}

function partPath(messageId: string, file: string): string {
  return join(dataDir, 'storage', 'part', messageId, file)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

function sessionSource(path: string, sessionId = 'session-one'): SessionSource {
  return { path, project: 'work-project', provider: 'opencode', sourceId: sessionId }
}

function parser(
  source: SessionSource,
  seenKeys = new Set<string>(),
  pricing?: ScanPricing,
  context?: { readonly signal?: AbortSignal; readonly pricing?: ScanPricing },
): SessionParser {
  return createOpenCodeFileSessionParser(source, seenKeys, dataDir, 'opencode', pricing, context)
}

function nativeStream(sessionParser: SessionParser): NonNullable<SessionParser['parseStream']> {
  if (!sessionParser.parseStream) throw new Error('OpenCode file parser did not expose parseStream')
  return sessionParser.parseStream
}

describe('OpenCode file helper native Effect path', () => {
  it('preserves discovery metadata and native readdir order through the Promise adapter', async () => {
    const projectDir = join(dataDir, 'storage', 'session', 'project')
    await mkdir(projectDir, { recursive: true })
    await writeJson(join(projectDir, 'z-session.json'), {
      id: 'session-z',
      directory: '/work/z',
      title: 'ignored title',
      foreignSibling: { future: true },
    })
    await writeJson(join(projectDir, 'broken.json'), { id: '' })
    await writeJson(join(projectDir, 'a-session.json'), { id: 'session-a', title: 'a title' })
    await writeFile(join(projectDir, 'ignored.txt'), '{}')

    const nativeOrder = (await readdir(projectDir)).filter(file => file.endsWith('.json'))
    nativeIo.reads.length = 0
    const native = await Effect.runPromise(
      discoverOpenCodeFileSessionsEffect(dataDir, 'opencode', { signal: new AbortController().signal }),
    )
    const legacy = await discoverOpenCodeFileSessions(dataDir, 'opencode')

    expect(native).toEqual(legacy)
    expect(native.map(source => source.path)).toEqual(
      nativeOrder.filter(file => file !== 'broken.json').map(file => join(projectDir, file)),
    )
    expect(native).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ project: 'work-z', workingDirectory: '/work/z', provider: 'opencode' }),
        expect.objectContaining({ project: 'a title', provider: 'opencode' }),
      ]),
    )
    expect(nativeIo.stats).toEqual([])
  })

  it('matches legacy assistant calls and preserves sorted user parts, prompt retention, and pricing', async () => {
    const session = metaPath()
    await writeJson(session, {
      id: 'session-one',
      directory: '/work/project',
      time: { created: 1_750_000_000_000 },
      unrelated: { opaque: ['kept out of the contract'] },
    })
    const messages = join(dataDir, 'storage', 'message', 'session-one')
    await writeJson(join(messages, 'assistant-later.json'), {
      id: 'assistant-later',
      role: 'assistant',
      modelID: 'fixture-model',
      tokens: { input: 1, output: 1 },
      time: { created: 1_750_000_000_200 },
    })
    await writeJson(join(messages, 'assistant-first.json'), {
      id: 'assistant-first',
      role: 'assistant',
      modelID: 'fixture-model',
      cost: 0.03,
      tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 4, write: 5 } },
      time: { created: 1_750_000_000_100 },
      foreignSibling: 'ignored',
    })
    await writeJson(join(messages, 'user-empty.json'), {
      id: 'user-empty',
      role: 'user',
      time: { created: 1_750_000_000_050 },
    })
    await writeJson(join(messages, 'user-first.json'), {
      id: 'user-first',
      role: 'user',
      time: { created: 1_750_000_000_000 },
    })
    await writeJson(partPath('user-first', 'z-part.json'), { type: 'text', text: 'from z' })
    await writeJson(partPath('user-first', 'a-part.json'), { type: 'text', text: 'please run tests' })
    await writeJson(partPath('user-empty', 'part.json'), { type: 'reasoning', text: 'no user text' })
    await writeJson(partPath('assistant-first', 'z-tool.json'), {
      type: 'tool',
      tool: 'bash',
      state: { input: { command: 'npm test' }, foreign: 'ignored' },
    })
    await writeJson(partPath('assistant-first', 'a-text.json'), { type: 'text', text: 'working' })

    const calculateCost = vi.fn(() => 0)
    const pricing: ScanPricing = { calculateCost, calculateLocalModelSavings: () => null }
    const sessionParser = parser(sessionSource(session), new Set(), pricing)
    const calls = await Effect.runPromise(Stream.runCollect(nativeStream(sessionParser)()))

    expect(calls).toEqual([
      {
        provider: 'opencode',
        model: 'fixture-model',
        inputTokens: 2,
        outputTokens: 3,
        cacheCreationInputTokens: 5,
        cacheReadInputTokens: 4,
        cachedInputTokens: 4,
        reasoningTokens: 1,
        webSearchRequests: 0,
        costUSD: 0.03,
        tools: ['Bash'],
        bashCommands: ['npm'],
        skills: [],
        subagentTypes: [],
        timestamp: new Date(1_750_000_000_100).toISOString(),
        speed: 'standard',
        deduplicationKey: 'opencode:session-one:assistant-first',
        userMessage: 'please run tests from z',
        assistantText: 'working\nnpm test',
        sessionId: 'session-one',
        projectPath: '/work/project',
        workingDirectory: '/work/project',
      },
      {
        provider: 'opencode',
        model: 'fixture-model',
        inputTokens: 1,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
        tools: [],
        bashCommands: [],
        skills: [],
        subagentTypes: [],
        timestamp: new Date(1_750_000_000_200).toISOString(),
        speed: 'standard',
        deduplicationKey: 'opencode:session-one:assistant-later',
        userMessage: 'please run tests from z',
        sessionId: 'session-one',
        projectPath: '/work/project',
        workingDirectory: '/work/project',
      },
    ])
    expect(calculateCost).toHaveBeenCalledTimes(2)
    expect(calculateCost).toHaveBeenNthCalledWith(1, 'fixture-model', 2, 4, 5, 4, 0)
    expect(nativeIo.stats).toEqual([])
    expect(nativeIo.reads[0]).toBe(session)
    expect(nativeIo.reads.filter(path => path === session)).toHaveLength(1)
    const messageReads = nativeIo.reads.filter(path => path.startsWith(join(dataDir, 'storage', 'message')))
    expect(messageReads).toHaveLength(4)
    expect(nativeIo.reads.indexOf(partPath('user-first', 'a-part.json'))).toBeLessThan(
      nativeIo.reads.indexOf(partPath('user-first', 'z-part.json')),
    )
  })

  it('keeps the nullish message-id fallback and does not claim a key for null builder output', async () => {
    const session = metaPath()
    await writeJson(session, { id: 'session-one' })
    const messages = join(dataDir, 'storage', 'message', 'session-one')
    await writeJson(join(messages, 'null-id.json'), {
      id: null,
      role: 'assistant',
      modelID: 'fixture-model',
      tokens: { input: 1, output: 0 },
      time: { created: 1 },
    })
    await writeJson(join(messages, 'empty-id.json'), {
      id: '',
      role: 'assistant',
      modelID: 'fixture-model',
      tokens: { input: 1, output: 0 },
      time: { created: 2 },
    })
    await writeJson(join(messages, 'first-null.json'), {
      id: 'shared',
      role: 'assistant',
      modelID: 'fixture-model',
      tokens: { input: 0, output: 0 },
      time: { created: 3 },
    })
    await writeJson(join(messages, 'second-same-id.json'), {
      id: 'shared',
      role: 'assistant',
      modelID: 'fixture-model',
      tokens: { input: 2, output: 0 },
      time: { created: 4 },
    })

    const seen = new Set(['opencode:session-one:pre-seen'])
    await writeJson(join(messages, 'pre-seen.json'), {
      id: 'pre-seen',
      role: 'assistant',
      modelID: 'fixture-model',
      tokens: { input: 1, output: 0 },
      time: { created: 5 },
    })
    const calls = await Effect.runPromise(Stream.runCollect(nativeStream(parser(sessionSource(session), seen))()))

    expect(calls.map(call => call.deduplicationKey)).toEqual([
      'opencode:session-one:null-id',
      'opencode:session-one:',
      'opencode:session-one:shared',
    ])
    expect(seen.has('opencode:session-one:shared')).toBe(true)
    expect(nativeIo.directories).not.toContain(join(dataDir, 'storage', 'part', 'pre-seen'))
    expect(nativeIo.stats).toEqual([])
  })

  it('sorts equal-time messages by their resolved message id', async () => {
    const session = metaPath()
    await writeJson(session, { id: 'session-one' })
    await writeJson(messagePath('session-one', 'z.json'), {
      id: 'z-message',
      role: 'assistant',
      modelID: 'fixture-model',
      tokens: { input: 1 },
      time: { created: 1_750_000_000_000 },
    })
    await writeJson(messagePath('session-one', 'a.json'), {
      id: 'a-message',
      role: 'assistant',
      modelID: 'fixture-model',
      tokens: { input: 1 },
      time: { created: 1_750_000_000_000 },
    })

    const calls = await Effect.runPromise(Stream.runCollect(nativeStream(parser(sessionSource(session)))()))
    expect(calls.map(call => call.deduplicationKey)).toEqual([
      'opencode:session-one:a-message',
      'opencode:session-one:z-message',
    ])
  })

  it('reads parts and prices per pull, stopping before later assistant parts', async () => {
    const session = metaPath()
    await writeJson(session, { id: 'session-one' })
    const messages = join(dataDir, 'storage', 'message', 'session-one')
    await writeJson(join(messages, 'later.json'), {
      id: 'later',
      role: 'assistant',
      modelID: 'fixture-model',
      tokens: { input: 1 },
      time: { created: 3 },
    })
    await writeJson(join(messages, 'first.json'), {
      id: 'first',
      role: 'assistant',
      modelID: 'fixture-model',
      tokens: { input: 1 },
      time: { created: 1 },
    })
    await writeJson(partPath('first', 'part.json'), { type: 'text', text: 'first' })
    await writeJson(partPath('later', 'part.json'), { type: 'text', text: 'later' })
    const calculateCost = vi.fn(() => 2)
    const pricing: ScanPricing = { calculateCost, calculateLocalModelSavings: () => null }

    const first = await Effect.runPromise(
      Stream.runHead(nativeStream(parser(sessionSource(session), new Set(), pricing))()),
    )

    expect(Option.isSome(first) && first.value.deduplicationKey).toBe('opencode:session-one:first')
    expect(calculateCost).toHaveBeenCalledOnce()
    expect(nativeIo.reads).toContain(partPath('first', 'part.json'))
    expect(nativeIo.reads).not.toContain(partPath('later', 'part.json'))
  })

  it('preserves malformed counter values for the extraction schema to reject', async () => {
    const session = metaPath()
    await writeJson(session, { id: 'session-one', foreign: { malformed: true } })
    await writeJson(messagePath('session-one', 'assistant.json'), {
      id: 'assistant',
      role: 'assistant',
      modelID: 'fixture-model',
      tokens: { input: 'bad-counter', output: 2 },
      time: { created: 1 },
      foreignSibling: [null, false],
    })
    const calls = await Effect.runPromise(Stream.runCollect(nativeStream(parser(sessionSource(session)))()))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.inputTokens).toBe('bad-counter')
    expect(Result.isFailure(Schema.decodeUnknownResult(parsedProviderCallSchema)(calls[0]))).toBe(true)
  })

  it('keeps builder timestamp failures in the typed Effect error channel', async () => {
    const session = metaPath()
    await writeJson(session, { id: 'session-one' })
    await writeJson(messagePath('session-one', 'assistant.json'), {
      id: 'assistant',
      role: 'assistant',
      modelID: 'fixture-model',
      tokens: { input: 1 },
      time: { created: 'invalid-time' },
    })

    await expect(
      Effect.runPromise(Stream.runCollect(nativeStream(parser(sessionSource(session)))())),
    ).rejects.toBeInstanceOf(RangeError)
  })

  it('drains a pending metadata read before returning the exact abort and starts no later leaf', async () => {
    const session = metaPath()
    await writeJson(session, { id: 'session-one' })
    nativeIo.reads.length = 0
    nativeIo.pendingPath = session
    let markStarted!: () => void
    const started = new Promise<void>(resolve => (markStarted = resolve))
    const settled = vi.fn()
    nativeIo.onPendingRead = markStarted
    nativeIo.onReadSettled = settled
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'stop now' })
    const running = Effect.runPromise(
      Stream.runCollect(
        nativeStream(parser(sessionSource(session), new Set(), undefined, { signal: controller.signal }))(),
      ),
    )
    const rejection = expect(running).rejects.toBe(abort)

    await started
    controller.abort(abort)
    expect(settled).not.toHaveBeenCalled()
    nativeIo.releasePendingRead?.(JSON.stringify({ id: 'session-one' }))
    await rejection
    expect(settled).toHaveBeenCalledOnce()
    expect(nativeIo.reads).toEqual([session])
    expect(nativeIo.directories).not.toContain(join(dataDir, 'storage', 'message', 'session-one'))
  })

  it('drains the active part read on abort without reading later parts or pricing', async () => {
    const session = metaPath()
    await writeJson(session, { id: 'session-one' })
    await writeJson(messagePath('session-one', 'assistant.json'), {
      id: 'assistant',
      role: 'assistant',
      modelID: 'fixture-model',
      tokens: { input: 1 },
      time: { created: 1 },
    })
    const firstPart = partPath('assistant', 'a-part.json')
    const laterPart = partPath('assistant', 'b-part.json')
    await writeJson(firstPart, { type: 'text', text: 'first' })
    await writeJson(laterPart, { type: 'text', text: 'later' })
    nativeIo.reads.length = 0
    nativeIo.pendingPath = firstPart
    let markStarted!: () => void
    const started = new Promise<void>(resolve => (markStarted = resolve))
    const settled = vi.fn()
    nativeIo.onPendingRead = markStarted
    nativeIo.onReadSettled = settled
    const calculateCost = vi.fn(() => 2)
    const pricing: ScanPricing = { calculateCost, calculateLocalModelSavings: () => null }
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'stop during parts' })
    const running = Effect.runPromise(
      Stream.runCollect(
        nativeStream(parser(sessionSource(session), new Set(), pricing, { signal: controller.signal }))(),
      ),
    )
    const rejection = expect(running).rejects.toBe(abort)

    await started
    controller.abort(abort)
    expect(settled).not.toHaveBeenCalled()
    nativeIo.releasePendingRead?.(JSON.stringify({ type: 'text', text: 'first' }))
    await rejection
    expect(settled).toHaveBeenCalledOnce()
    expect(nativeIo.reads).toContain(firstPart)
    expect(nativeIo.reads).not.toContain(laterPart)
    expect(calculateCost).not.toHaveBeenCalled()
  })
})
