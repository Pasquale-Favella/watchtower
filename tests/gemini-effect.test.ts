import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Fiber, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Env } from '../src/main/env.js'

const nativeIo = vi.hoisted(() => ({
  onReadStarted: undefined as (() => void) | undefined,
  releaseRead: undefined as ((value: string) => void) | undefined,
  onSessionReaderClose: undefined as (() => void) | undefined,
}))

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args)
      stream.once('close', () => nativeIo.onSessionReaderClose?.())
      return stream
    },
  }
})

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (!nativeIo.releaseRead) return actual.readFile(...args)
      nativeIo.onReadStarted?.()
      return new Promise<string>(resolve => {
        nativeIo.releaseRead = resolve
      })
    },
  }
})

import { createGeminiProvider } from '../src/main/pipeline/providers/gemini.js'
import type { Provider, SessionParser, SessionSource } from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-gemini-effect-'))
  nativeIo.onReadStarted = undefined
  nativeIo.releaseRead = undefined
  nativeIo.onSessionReaderClose = undefined
})

afterEach(() => {
  nativeIo.onReadStarted = undefined
  nativeIo.releaseRead = undefined
  nativeIo.onSessionReaderClose = undefined
  rmSync(root, { recursive: true, force: true })
})

function source(path: string): SessionSource {
  return { path, project: 'fixture-project', provider: 'gemini' }
}

function stream(parser: SessionParser): NonNullable<SessionParser['parseStream']> {
  if (!parser.parseStream) throw new Error('Gemini parser did not expose its native stream')
  return parser.parseStream
}

function nativeDiscovery(provider: Provider): NonNullable<Provider['discoverSessionsEffect']> {
  if (!provider.discoverSessionsEffect) throw new Error('Gemini provider did not expose native discovery')
  return provider.discoverSessionsEffect
}

describe('Gemini Effect provider', () => {
  it.each([undefined, 2])('accepts legacy whole JSON in a .jsonl file with indentation %s', async indentation => {
    const path = join(root, 'legacy-session.jsonl')
    await writeFile(
      path,
      JSON.stringify(
        {
          sessionId: 'legacy',
          messages: [
            {
              id: 'one',
              type: 'gemini',
              timestamp: '2026-02-01T00:00:00.000Z',
              model: 'fixture-model',
              tokens: { input: 1 },
            },
          ],
        },
        null,
        indentation,
      ),
    )
    const parser = createGeminiProvider().createSessionParser(source(path), new Set())
    const calls = await Effect.runPromise(Stream.runCollect(stream(parser)()))
    expect(calls.map(call => call.deduplicationKey)).toEqual(['gemini:legacy:one'])
  })

  it('parses the legacy whole-session JSON format through the native Stream', async () => {
    const path = join(root, 'session.json')
    await writeFile(
      path,
      JSON.stringify({
        sessionId: 'whole-session',
        startTime: '2026-01-01T00:00:00.000Z',
        messages: [
          { type: 'user', content: [{ text: 'first question' }] },
          {
            id: 'call-1',
            type: 'gemini',
            timestamp: '2026-01-01T00:00:01.000Z',
            model: 'fixture-model',
            tokens: { input: 100, cached: 10, output: 20, thoughts: 5 },
            toolCalls: [
              { name: 'run_command', displayName: 'Shell', args: { command: 'git status' } },
              { name: 'run_command', displayName: 'Shell', args: { command: 'git status' } },
            ],
          },
        ],
      }),
    )
    const parser = createGeminiProvider().createSessionParser(source(path), new Set())

    const calls = await Effect.runPromise(Stream.runCollect(stream(parser)()))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      provider: 'gemini',
      model: 'fixture-model',
      inputTokens: 90,
      outputTokens: 20,
      cacheReadInputTokens: 10,
      cachedInputTokens: 10,
      reasoningTokens: 5,
      tools: ['Bash'],
      bashCommands: ['git'],
      turnId: 'whole-session:turn-0',
      userMessage: 'first question',
      timestamp: '2026-01-01T00:00:01.000Z',
    })
    const adapterParser = createGeminiProvider().createSessionParser(source(path), new Set())
    const compatibleCalls: unknown[] = []
    for await (const call of adapterParser.parse()) compatibleCalls.push(call)
    expect(compatibleCalls).toEqual(calls)
  })

  it('keeps valid whole-JSON calls without startTime or malformed unused metadata', async () => {
    const path = join(root, 'session-without-start-time.json')
    await writeFile(
      path,
      JSON.stringify({
        sessionId: 'session-without-start-time',
        projectHash: 17,
        lastUpdated: { invalid: true },
        kind: ['unused'],
        messages: [
          {
            id: 'timestamped-call',
            type: 'gemini',
            timestamp: '2026-03-01T00:00:01.000Z',
            model: 'fixture-model',
            tokens: { input: 2, output: 1, tool: 'unused', total: {} },
            thoughts: 'unused',
          },
        ],
      }),
    )
    const parser = createGeminiProvider().createSessionParser(source(path), new Set())

    const calls = await Effect.runPromise(Stream.runCollect(stream(parser)()))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionId: 'session-without-start-time',
      timestamp: '2026-03-01T00:00:01.000Z',
      inputTokens: 2,
      outputTokens: 1,
    })
  })

  it('decodes JSONL while skipping $set records and only the malformed message', async () => {
    const path = join(root, 'session.jsonl')
    await writeFile(
      path,
      [
        JSON.stringify({ sessionId: 'jsonl-session', startTime: '2026-02-01T00:00:00.000Z' }),
        JSON.stringify({ $set: { sessionId: 'ignored' } }),
        '{malformed json',
        JSON.stringify({ id: 'bad-call', type: 'gemini', model: 'bad', tokens: { input: 'many' } }),
        '{"id":"overflow","type":"gemini","model":"bad","tokens":{"input":1e309,"output":1}}',
        JSON.stringify({ type: 'user', content: 'kept question' }),
        JSON.stringify({
          id: 'good-call',
          type: 'gemini',
          model: 'fixture-model',
          tokens: { input: 12, output: 3, cached: null },
        }),
      ].join('\n'),
    )
    const parser = createGeminiProvider().createSessionParser(source(path), new Set())

    const calls = await Effect.runPromise(Stream.runCollect(stream(parser)()))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      deduplicationKey: 'gemini:jsonl-session:good-call',
      inputTokens: 12,
      outputTokens: 3,
      timestamp: '2026-02-01T00:00:00.000Z',
      turnId: 'jsonl-session:turn-0',
      userMessage: 'kept question',
    })
  })

  it('requires a nonempty JSONL header before yielding its messages', async () => {
    const path = join(root, 'session-without-jsonl-header.jsonl')
    await writeFile(
      path,
      [
        JSON.stringify({ sessionId: 'jsonl-session', startTime: '' }),
        JSON.stringify({
          id: 'orphan-call',
          type: 'gemini',
          timestamp: '2026-02-01T00:00:00.000Z',
          model: 'fixture-model',
          tokens: { input: 2 },
        }),
      ].join('\n'),
    )
    const parser = createGeminiProvider().createSessionParser(source(path), new Set())

    await expect(Effect.runPromise(Stream.runCollect(stream(parser)()))).resolves.toHaveLength(0)
  })

  it('does not admit later JSONL dedup keys and closes the owned reader after early termination', async () => {
    const path = join(root, 'incremental-session.jsonl')
    await writeFile(
      path,
      [
        JSON.stringify({ sessionId: 'incremental-session', startTime: '2026-02-01T00:00:00.000Z' }),
        ...['first', 'second', 'third'].map(id =>
          JSON.stringify({ id, type: 'gemini', model: 'fixture-model', tokens: { input: 1 } }),
        ),
      ].join('\n'),
    )
    let markClosed!: () => void
    const readerClosed = new Promise<void>(resolve => {
      markClosed = resolve
    })
    nativeIo.onSessionReaderClose = markClosed
    const seenKeys = new Set<string>()
    const parser = createGeminiProvider().createSessionParser(source(path), seenKeys)

    const calls = await Effect.runPromise(Stream.runCollect(stream(parser)().pipe(Stream.take(1))))
    await readerClosed

    expect(calls).toHaveLength(1)
    expect(calls[0]?.deduplicationKey).toBe('gemini:incremental-session:first')
    expect(seenKeys).toEqual(new Set(['gemini:incremental-session:first']))
  })

  it('closes the JSONL reader and preserves the typed signal reason after an emitted call', async () => {
    const path = join(root, 'signal-session.jsonl')
    await writeFile(
      path,
      [
        JSON.stringify({ sessionId: 'signal-session', startTime: '2026-02-01T00:00:00.000Z' }),
        ...['first', 'second'].map(id =>
          JSON.stringify({ id, type: 'gemini', model: 'fixture-model', tokens: { input: 1 } }),
        ),
      ].join('\n'),
    )
    let markClosed!: () => void
    const readerClosed = new Promise<void>(resolve => {
      markClosed = resolve
    })
    nativeIo.onSessionReaderClose = markClosed
    const reason = new ScanAbortedError({ message: 'stop Gemini JSONL scan' })
    const controller = new AbortController()
    const parser = createGeminiProvider().createSessionParser(source(path), new Set(), undefined, {
      signal: controller.signal,
    })
    const calls = stream(parser)().pipe(Stream.tap(() => Effect.sync(() => controller.abort(reason))))

    await expect(Effect.runPromise(Stream.runCollect(calls))).rejects.toBe(reason)
    await readerClosed
  })

  it('discovers only matching session files in Gemini project chat directories', async () => {
    const chats = join(root, 'project-a', 'chats')
    await mkdir(chats, { recursive: true })
    await mkdir(join(chats, 'session-directory.json'))
    await writeFile(join(chats, 'session-one.json'), '{}')
    await writeFile(join(chats, 'session-two.jsonl'), '{}')
    await writeFile(join(chats, 'other.json'), '{}')

    const sources = await Effect.runPromise(
      nativeDiscovery(createGeminiProvider(root))().pipe(Effect.provide(Env.layer)),
    )

    expect(sources).toEqual([
      { path: join(chats, 'session-one.json'), project: 'project-a', provider: 'gemini' },
      { path: join(chats, 'session-two.jsonl'), project: 'project-a', provider: 'gemini' },
    ])
  })

  it('preserves the exact typed abort reason before starting discovery IO', async () => {
    const reason = new ScanAbortedError({ message: 'cancel Gemini scan' })
    const controller = new AbortController()
    controller.abort(reason)

    await expect(
      Effect.runPromise(
        nativeDiscovery(createGeminiProvider(root))({ signal: controller.signal }).pipe(Effect.provide(Env.layer)),
      ),
    ).rejects.toBe(reason)
  })

  it('waits for the uncancellable file read leaf to settle when its stream is interrupted', async () => {
    const path = join(root, 'session.json')
    await writeFile(path, '{}')
    let markStarted!: () => void
    const started = new Promise<void>(resolve => {
      markStarted = resolve
    })
    nativeIo.onReadStarted = markStarted
    nativeIo.releaseRead = () => undefined
    const parser = createGeminiProvider().createSessionParser(source(path), new Set())
    const fiber = Effect.runFork(Stream.runCollect(stream(parser)()))
    await started

    let interruptionSettled = false
    const interruption = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      interruptionSettled = true
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(interruptionSettled).toBe(false)

    const releaseRead = nativeIo.releaseRead
    if (!releaseRead) throw new Error('The fixture read has no release callback')
    releaseRead('{}')
    await interruption
    expect(interruptionSettled).toBe(true)
  })
})
