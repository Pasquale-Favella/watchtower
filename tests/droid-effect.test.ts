import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Stream } from 'effect'
import { mkdir, writeFile } from 'fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({ readerEvents: [] as string[], settingsReads: [] as string[] }))

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args)
      const path = String(args[0])
      hooks.readerEvents.push(`open:${path}`)
      stream.once('close', () => hooks.readerEvents.push(`close:${path}`))
      return stream
    },
  }
})

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const path = String(args[0])
      if (path.endsWith('.settings.json')) hooks.settingsReads.push(path)
      return actual.readFile(...args)
    },
  }
})

import { Env } from '../src/main/env.js'
import { createDroidProvider } from '../src/main/pipeline/providers/droid.js'
import type { Provider, SessionParser, SessionSource } from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-droid-effect-'))
  hooks.readerEvents.length = 0
  hooks.settingsReads.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

async function writeSession(path: string, lines: Array<string | unknown>, settings?: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n'))
  if (settings !== undefined) {
    await writeFile(path.replace(/\.jsonl$/, '.settings.json'), JSON.stringify(settings))
  }
}

function nativeDiscovery(provider: Provider, signal?: AbortSignal) {
  if (!provider.discoverSessionsEffect) throw new Error('Droid Effect discovery is unavailable')
  return provider.discoverSessionsEffect(signal ? { signal } : undefined).pipe(Effect.provide(Env.layer))
}

function parser(path: string, seen = new Set<string>(), signal?: AbortSignal, pricing?: ScanPricing): SessionParser {
  const context = signal || pricing ? { ...(signal ? { signal } : {}), ...(pricing ? { pricing } : {}) } : undefined
  return createDroidProvider(root).createSessionParser(
    { path, project: 'session', provider: 'droid' } satisfies SessionSource,
    seen,
    undefined,
    context,
  )
}

async function collect(parserValue: SessionParser) {
  if (!parserValue.parseStream) throw new Error('Droid parser has no native Stream')
  return [...(await Effect.runPromise(Stream.runCollect(parserValue.parseStream())))]
}

describe('Droid Effect provider', () => {
  it('discovers session files from their first nonempty physical line and filters internal sessions', async () => {
    const sessionsDir = join(root, 'sessions')
    const projectDir = join(sessionsDir, 'encoded-project')
    const validPath = join(projectDir, 'valid.jsonl')
    const blankPath = join(projectDir, 'blank-first.jsonl')
    const wrongFirstPath = join(projectDir, 'wrong-first.jsonl')
    const internalPath = join(projectDir, 'internal.jsonl')
    const malformedPath = join(projectDir, 'malformed.jsonl')
    await writeSession(validPath, [{ type: 'session_start', id: 'valid', cwd: '/home/me/projects/acme/repo' }])
    await writeSession(blankPath, ['', { type: 'session_start', id: 'blank', cwd: '/work/blank' }])
    await writeSession(wrongFirstPath, [
      { type: 'message', message: { role: 'assistant' } },
      { type: 'session_start', id: 'later', cwd: '/work/later' },
    ])
    await writeSession(internalPath, [{ type: 'session_start', id: 'internal', cwd: root }])
    await writeSession(malformedPath, ['{malformed json'])

    const provider = createDroidProvider(root)
    const nativeSources = await Effect.runPromise(nativeDiscovery(provider))
    expect(nativeSources).toEqual(
      expect.arrayContaining([
        { path: validPath, project: 'acme/repo', provider: 'droid' },
        { path: blankPath, project: 'work/blank', provider: 'droid' },
      ]),
    )
    expect(nativeSources).toHaveLength(2)
    expect(await provider.discoverSessions()).toEqual(nativeSources)
  })

  it('allocates session totals before dedupe, keeps call order and applies Droid tool parsing', async () => {
    const path = join(root, 'calls.jsonl')
    await writeSession(
      path,
      [
        { type: 'session_start', id: 'droid-session', timestamp: 42, message: 'unused header field' },
        { type: 'message', message: { role: 'user', content: 'initial request' } },
        {
          type: 'message',
          id: 'first',
          timestamp: 'first-time',
          message: {
            role: 'assistant',
            content: [
              null,
              42,
              { type: 'tool_use', name: 'Execute', input: { command: 'git status\npython -c "x"' } },
              { type: 'text', text: 'answer' },
              { type: 42, name: 'malformed sibling' },
            ],
          },
        },
        { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'latest request' }] } },
        { type: 'message', id: 'second', message: { role: 'assistant', content: 'second answer' } },
        { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'fallback answer' }] } },
        '{bad record',
      ],
      {
        model: 'custom:gpt-5-[Proxy]-0',
        tokenUsage: {
          inputTokens: 11,
          outputTokens: 5,
          cacheCreationTokens: 2,
          cacheReadTokens: 4,
          thinkingTokens: 3,
        },
      },
    )
    const seen = new Set(['droid:droid-session:second'])
    const calls = await collect(parser(path, seen))

    expect(calls).toHaveLength(2)
    expect(calls).toMatchObject([
      {
        provider: 'droid',
        sessionId: 'droid-session',
        model: 'gpt-5',
        timestamp: 'first-time',
        inputTokens: 3,
        outputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 1,
        reasoningTokens: 1,
        tools: ['Bash'],
        bashCommands: ['git'],
        userMessage: 'latest request',
        deduplicationKey: 'droid:droid-session:first',
      },
      {
        model: 'gpt-5',
        timestamp: '',
        inputTokens: 5,
        outputTokens: 3,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 2,
        reasoningTokens: 1,
        userMessage: '',
        deduplicationKey: 'droid:droid-session:msg-2',
      },
    ])
    expect(seen).toEqual(
      new Set(['droid:droid-session:second', 'droid:droid-session:first', 'droid:droid-session:msg-2']),
    )
  })

  it('does not record later keys when the output stream is only partially consumed', async () => {
    const path = join(root, 'partial.jsonl')
    await writeSession(
      path,
      [
        { type: 'session_start', id: 'partial' },
        { type: 'message', id: 'first', message: { role: 'assistant', content: 'first' } },
        { type: 'message', id: 'second', message: { role: 'assistant', content: 'second' } },
      ],
      { tokenUsage: { inputTokens: 2, outputTokens: 2 } },
    )
    const seen = new Set<string>()
    const parserValue = parser(path, seen)
    if (!parserValue.parseStream) throw new Error('Droid parser has no native Stream')

    const calls = await Effect.runPromise(Stream.runCollect(parserValue.parseStream().pipe(Stream.take(1))))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.inputTokens).toBe(1)
    expect(seen).toEqual(new Set(['droid:partial:first']))
    expect(hooks.readerEvents).toEqual([`open:${path}`, `close:${path}`])
  })

  it('prices only emitted calls after skipping cached calls', async () => {
    const path = join(root, 'lazy-pricing.jsonl')
    await writeSession(
      path,
      [
        { type: 'session_start', id: 'pricing-session' },
        { type: 'message', id: 'cached', message: { role: 'assistant', content: 'cached' } },
        { type: 'message', id: 'emitted', message: { role: 'assistant', content: 'emitted' } },
        { type: 'message', id: 'unconsumed', message: { role: 'assistant', content: 'unconsumed' } },
      ],
      { tokenUsage: { inputTokens: 30, outputTokens: 15 } },
    )
    const calculateCost = vi.fn(() => 0)
    const pricing: ScanPricing = { calculateCost, calculateLocalModelSavings: () => null }
    const seen = new Set(['droid:pricing-session:cached'])
    const parserValue = parser(path, seen, undefined, pricing)
    if (!parserValue.parseStream) throw new Error('Droid parser has no native Stream')
    const calls = await Effect.runPromise(Stream.runCollect(parserValue.parseStream().pipe(Stream.take(1))))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.deduplicationKey).toBe('droid:pricing-session:emitted')
    expect(calculateCost).toHaveBeenCalledOnce()
    expect(seen).toEqual(new Set(['droid:pricing-session:cached', 'droid:pricing-session:emitted']))
  })

  it('falls back for missing or malformed settings and skips sessions without token usage', async () => {
    const missingPath = join(root, 'missing.jsonl')
    const malformedPath = join(root, 'malformed-settings.jsonl')
    const noUsagePath = join(root, 'no-usage.jsonl')
    await writeSession(missingPath, [
      { type: 'session_start', id: 'missing' },
      { type: 'message', message: { role: 'assistant', content: 'text' } },
    ])
    await writeSession(malformedPath, [
      { type: 'session_start', id: 'malformed' },
      { type: 'message', message: { role: 'assistant', content: 'text' } },
    ])
    await writeFile(malformedPath.replace(/\.jsonl$/, '.settings.json'), '{bad json')
    await writeSession(
      noUsagePath,
      [
        { type: 'session_start', id: 'no-usage' },
        { type: 'message', message: { role: 'assistant', content: 'text' } },
      ],
      { model: 'custom:sonnet-9' },
    )

    expect(await collect(parser(missingPath))).toEqual([])
    expect(await collect(parser(malformedPath))).toEqual([])
    expect(await collect(parser(noUsagePath))).toEqual([])
  })

  it('avoids settings IO for missing transcripts and transcripts without assistant calls', async () => {
    const emptyPath = join(root, 'user-only.jsonl')
    await writeSession(emptyPath, [{ type: 'message', message: { role: 'user', content: 'request' } }])
    expect(await collect(parser(join(root, 'missing-transcript.jsonl')))).toEqual([])
    expect(await collect(parser(emptyPath))).toEqual([])
    expect(hooks.settingsReads).toEqual([])
  })

  it('preserves caller abort between emitted calls without admitting another key', async () => {
    const path = join(root, 'stop-after-first.jsonl')
    await writeSession(
      path,
      [
        { type: 'session_start', id: 'partial' },
        { type: 'message', id: 'first', message: { role: 'assistant', content: 'first' } },
        { type: 'message', id: 'second', message: { role: 'assistant', content: 'second' } },
      ],
      { tokenUsage: { inputTokens: 2, outputTokens: 2 } },
    )
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'stop after first call' })
    const seen = new Set<string>()
    const value = parser(path, seen, controller.signal)
    if (!value.parseStream) throw new Error('Droid parser has no native Stream')
    const stream = value.parseStream().pipe(Stream.tap(() => Effect.sync(() => controller.abort(abort))))
    await expect(Effect.runPromise(Stream.runCollect(stream))).rejects.toBe(abort)
    expect(seen).toEqual(new Set(['droid:partial:first']))
    expect(hooks.readerEvents).toEqual([`open:${path}`, `close:${path}`])
  })

  it('preserves typed caller aborts at discovery and parsing boundaries', async () => {
    const controller = new AbortController()
    const failure = new ScanAbortedError({ message: 'caller stopped Droid scan' })
    controller.abort(failure)
    const provider = createDroidProvider(root)
    const parserValue = parser(join(root, 'aborted.jsonl'), new Set(), controller.signal)
    if (!parserValue.parseStream) throw new Error('Droid parser has no native Stream')

    const discoveryExit = await Effect.runPromiseExit(nativeDiscovery(provider, controller.signal))
    const parserExit = await Effect.runPromiseExit(Stream.runCollect(parserValue.parseStream()))
    expect(discoveryExit._tag).toBe('Failure')
    expect(parserExit._tag).toBe('Failure')
    if (discoveryExit._tag === 'Failure') expect(discoveryExit.cause.reasons[0]).toMatchObject({ error: failure })
    if (parserExit._tag === 'Failure') expect(parserExit.cause.reasons[0]).toMatchObject({ error: failure })
  })
})
