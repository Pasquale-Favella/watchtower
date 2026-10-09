import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Fiber, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nativeIo = vi.hoisted(() => ({
  onIndexReadStarted: undefined as (() => void) | undefined,
  releaseIndexRead: undefined as ((value: string) => void) | undefined,
  onSessionReaderOpen: undefined as (() => void) | undefined,
  onSessionReaderClose: undefined as (() => void) | undefined,
}))

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args)
      nativeIo.onSessionReaderOpen?.()
      stream.once('close', () => nativeIo.onSessionReaderClose?.())
      return stream
    },
  }
})

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (!String(args[0]).endsWith('sessions.json') || !nativeIo.releaseIndexRead) return actual.readFile(...args)
      nativeIo.onIndexReadStarted?.()
      return new Promise<string>(resolve => {
        nativeIo.releaseIndexRead = resolve
      })
    },
  }
})

import { Env } from '../src/main/env.js'
import { captureScanPricing, setPriceOverrides } from '../src/main/pipeline/models.js'
import { createOpenClawProvider } from '../src/main/pipeline/providers/openclaw.js'
import type { Provider, SessionParser, SessionSource } from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-openclaw-effect-'))
  nativeIo.onIndexReadStarted = undefined
  nativeIo.releaseIndexRead = undefined
  nativeIo.onSessionReaderOpen = undefined
  nativeIo.onSessionReaderClose = undefined
})

afterEach(() => {
  setPriceOverrides({})
  nativeIo.onIndexReadStarted = undefined
  nativeIo.releaseIndexRead = undefined
  nativeIo.onSessionReaderOpen = undefined
  nativeIo.onSessionReaderClose = undefined
  rmSync(root, { recursive: true, force: true })
})

async function writeLines(path: string, values: readonly unknown[]): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, values.map(value => (typeof value === 'string' ? value : JSON.stringify(value))).join('\n'))
}

function source(path: string): SessionSource {
  return { path, project: 'fixture', provider: 'openclaw' }
}

function parser(path: string, seen = new Set<string>(), signal?: AbortSignal, pricing?: ScanPricing): SessionParser {
  const context = signal || pricing ? { ...(signal ? { signal } : {}), ...(pricing ? { pricing } : {}) } : undefined
  return createOpenClawProvider(root).createSessionParser(source(path), seen, undefined, context)
}

function parseStream(value: SessionParser): NonNullable<SessionParser['parseStream']> {
  if (!value.parseStream) throw new Error('OpenClaw parser did not expose its native Stream')
  return value.parseStream
}

function discover(provider: Provider, signal?: AbortSignal) {
  if (!provider.discoverSessionsEffect) throw new Error('OpenClaw provider did not expose native discovery')
  return provider.discoverSessionsEffect(signal ? { signal } : undefined).pipe(Effect.provide(Env.layer))
}

const usage = { input: 100, output: 40, cacheRead: 12, cacheWrite: 8 }

describe('OpenClaw Effect provider', () => {
  it('discovers indexed sources first, falls back to IDs, then appends unindexed JSONL files', async () => {
    const sessionsDir = join(root, 'agent-a', 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    const indexedPath = join(sessionsDir, 'indexed.jsonl')
    const idPath = join(sessionsDir, 'from-id.jsonl')
    const extraPath = join(sessionsDir, 'extra.jsonl')
    await writeFile(indexedPath, '')
    await writeFile(idPath, '')
    await writeFile(extraPath, '')
    await writeFile(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        indexed: { sessionFile: indexedPath },
        byId: { sessionId: 'from-id' },
        malformedSibling: 42,
      }),
    )

    const provider = createOpenClawProvider(root)
    const sources = await Effect.runPromise(discover(provider))

    expect(sources.slice(0, 2)).toEqual([
      { path: indexedPath, project: 'agent-a', provider: 'openclaw' },
      { path: idPath, project: 'agent-a', provider: 'openclaw' },
    ])
    expect(sources.slice(2)).toEqual([{ path: extraPath, project: 'agent-a', provider: 'openclaw' }])
    await expect(provider.discoverSessions()).resolves.toEqual(sources)
  })

  it('decodes valid siblings and preserves model, billing, tool, identity, timestamp, and user-message mapping', async () => {
    const path = join(root, 'parity.jsonl')
    await writeLines(path, [
      '{malformed line',
      { type: 'session', id: 'session-final', timestamp: '2026-10-01T10:00:00.000Z', modelId: 42 },
      { type: 'model_change', modelId: 'change-model' },
      { type: 'custom', customType: 'model-snapshot', data: { modelId: 'snapshot-model' } },
      {
        type: 'message',
        message: {
          role: 'user',
          usage: 'unused malformed sibling',
          content: [null, { type: 42 }, { type: 'text', text: 'question', name: 42, arguments: 'unused' }],
        },
      },
      {
        type: 'message',
        id: 'first-call',
        timestamp: '2026-10-01T10:01:00.000Z',
        message: {
          role: 'assistant',
          model: null,
          content: [
            null,
            { type: 'tool_use', name: 'exec', arguments: { command: 'git status\necho hi' }, text: 42 },
            { type: 'toolCall', name: 'read', arguments: 'malformed irrelevant args' },
          ],
          usage: { ...usage, cost: { total: 2.5 }, totalTokens: 'unused malformed sibling' },
        },
      },
      { type: 'message', id: 'invalid-usage', message: { role: 'assistant', model: 'bad', usage: { input: 'many' } } },
      {
        type: 'message',
        id: 'second-call',
        message: { role: 'assistant', content: [], usage },
      },
    ])
    const calculateCost = vi.fn(() => 99)
    const pricing: ScanPricing = { calculateCost, calculateLocalModelSavings: () => null }

    const calls = await Effect.runPromise(Stream.runCollect(parseStream(parser(path, new Set(), undefined, pricing))()))

    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      provider: 'openclaw',
      model: 'snapshot-model',
      inputTokens: 100,
      outputTokens: 40,
      cacheCreationInputTokens: 8,
      cacheReadInputTokens: 12,
      cachedInputTokens: 12,
      costUSD: 2.5,
      tools: ['Bash', 'Read'],
      bashCommands: ['git'],
      timestamp: '2026-10-01T10:01:00.000Z',
      deduplicationKey: 'openclaw:session-final:first-call',
      userMessage: 'question',
      sessionId: 'session-final',
    })
    expect(calls[1]).toMatchObject({
      model: 'snapshot-model',
      costUSD: 99,
      deduplicationKey: 'openclaw:session-final:second-call',
      timestamp: '2026-10-01T10:00:00.000Z',
      userMessage: '',
    })
    expect(calculateCost).toHaveBeenCalledOnce()
    expect(calculateCost).toHaveBeenCalledWith('snapshot-model', 100, 40, 8, 12, 0)
  })

  it('uses the parser captured pricing snapshot across awaited file IO', async () => {
    const path = join(root, 'captured.jsonl')
    const model = 'openclaw-captured-pricing-fixture'
    await writeLines(path, [
      { type: 'session', id: 'captured', timestamp: '2026-10-01T10:00:00.000Z' },
      { type: 'message', id: 'call', message: { role: 'assistant', model, usage } },
    ])
    setPriceOverrides({ [model]: { input: 1, output: 2 } })
    const capturedCost = captureScanPricing().calculateCost(
      model,
      usage.input,
      usage.output,
      usage.cacheWrite,
      usage.cacheRead,
      0,
    )
    const parserValue = parser(path)
    setPriceOverrides({ [model]: { input: 3, output: 4 } })

    await expect(Effect.runPromise(Stream.runCollect(parseStream(parserValue)()))).resolves.toMatchObject([
      { costUSD: capturedCost },
    ])
    const fresh = await Effect.runPromise(Stream.runCollect(parseStream(parser(path))()))
    expect(fresh[0]?.costUSD).toBe(
      captureScanPricing().calculateCost(model, usage.input, usage.output, usage.cacheWrite, usage.cacheRead, 0),
    )
  })

  it('keeps legacy id-less dedup indices across malformed assistant usage candidates', async () => {
    const path = join(root, 'malformed-usage-index.jsonl')
    await writeLines(path, [
      { type: 'session', id: 'dedup-index', timestamp: '2026-10-01T10:00:00.000Z' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'consumed by malformed turn' }] } },
      { type: 'message', message: { role: 'assistant', usage: { input: 'bad' } } },
      { type: 'message', message: { role: 'assistant', usage } },
      { type: 'message', message: { role: 'assistant', usage: 5 } },
      { type: 'message', message: { role: 'assistant', usage } },
    ])
    const calls = await Effect.runPromise(Stream.runCollect(parseStream(parser(path))()))

    expect(calls.map(call => call.deduplicationKey)).toEqual(['openclaw:dedup-index:1', 'openclaw:dedup-index:3'])
    expect(calls.map(call => call.userMessage)).toEqual(['', ''])
  })

  it('admits dedup keys and pricing only for consumed outputs, and closes the reader on take', async () => {
    const path = join(root, 'partial.jsonl')
    await writeLines(path, [
      { type: 'session', id: 'partial', timestamp: '2026-10-01T10:00:00.000Z' },
      { type: 'message', id: 'first', message: { role: 'assistant', usage } },
      { type: 'message', id: 'second', message: { role: 'assistant', usage } },
      { type: 'message', id: 'third', message: { role: 'assistant', usage } },
    ])
    const calculateCost = vi.fn(() => 1)
    const pricing: ScanPricing = { calculateCost, calculateLocalModelSavings: () => null }
    const seen = new Set<string>()
    let markClosed!: () => void
    const readerClosed = new Promise<void>(resolve => {
      markClosed = resolve
    })
    nativeIo.onSessionReaderClose = markClosed

    const calls = await Effect.runPromise(
      Stream.runCollect(parseStream(parser(path, seen, undefined, pricing))().pipe(Stream.take(1))),
    )
    await readerClosed

    expect(calls).toHaveLength(1)
    expect(calls[0]?.model).toBe('openclaw-auto')
    expect(seen).toEqual(new Set(['openclaw:partial:first']))
    expect(calculateCost).toHaveBeenCalledOnce()
  })

  it('preserves caller abort after a yielded call and does not admit later keys', async () => {
    const path = join(root, 'abort.jsonl')
    await writeLines(path, [
      { type: 'session', id: 'abort-session', timestamp: '2026-10-01T10:00:00.000Z' },
      { type: 'message', id: 'first', message: { role: 'assistant', usage } },
      { type: 'message', id: 'second', message: { role: 'assistant', usage } },
      { type: 'message', id: 'third', message: { role: 'assistant', usage } },
    ])
    const controller = new AbortController()
    const reason = new ScanAbortedError({ message: 'stop OpenClaw scan' })
    const seen = new Set<string>()
    let markClosed!: () => void
    const readerClosed = new Promise<void>(resolve => {
      markClosed = resolve
    })
    nativeIo.onSessionReaderClose = markClosed
    const values = parseStream(parser(path, seen, controller.signal))().pipe(
      Stream.tap(() => Effect.sync(() => controller.abort(reason))),
    )

    await expect(Effect.runPromise(Stream.runCollect(values))).rejects.toBe(reason)
    await readerClosed
    expect(seen).toEqual(new Set(['openclaw:abort-session:first']))
  })

  it('drains pending index IO when an interrupted discovery fiber is stopped', async () => {
    const sessionsDir = join(root, 'agent', 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    await writeFile(join(sessionsDir, 'sessions.json'), '{}')
    let markStarted!: () => void
    const readStarted = new Promise<void>(resolve => {
      markStarted = resolve
    })
    nativeIo.onIndexReadStarted = markStarted
    nativeIo.releaseIndexRead = () => undefined
    const fiber = Effect.runFork(discover(createOpenClawProvider(root)))
    await readStarted

    let settled = false
    const interruption = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      settled = true
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)

    const release = nativeIo.releaseIndexRead
    if (!release) throw new Error('The fixture index read has no release callback')
    release('{}')
    await interruption
    expect(settled).toBe(true)
  })

  it('preserves an already aborted caller reason at discovery and parsing boundaries', async () => {
    const reason = new ScanAbortedError({ message: 'cancel OpenClaw scan' })
    const controller = new AbortController()
    controller.abort(reason)
    const provider = createOpenClawProvider(root)

    await expect(Effect.runPromise(discover(provider, controller.signal))).rejects.toBe(reason)
    await expect(
      Effect.runPromise(
        Stream.runCollect(parseStream(parser(join(root, 'aborted.jsonl'), new Set(), controller.signal))()),
      ),
    ).rejects.toBe(reason)
  })

  it('closes the session reader when its parser fiber is interrupted during file IO', async () => {
    const path = join(root, 'interrupted.jsonl')
    await writeLines(path, [
      { type: 'session', id: 'interrupted', timestamp: '2026-10-01T10:00:00.000Z' },
      ...Array.from({ length: 2000 }, (_, index) => ({ type: 'ignored', id: String(index) })),
    ])
    let markOpened!: () => void
    let markClosed!: () => void
    const readerOpened = new Promise<void>(resolve => {
      markOpened = resolve
    })
    const readerClosed = new Promise<void>(resolve => {
      markClosed = resolve
    })
    nativeIo.onSessionReaderOpen = markOpened
    nativeIo.onSessionReaderClose = markClosed
    const fiber = Effect.runFork(Stream.runCollect(parseStream(parser(path))()))
    await readerOpened

    await Effect.runPromise(Fiber.interrupt(fiber))
    await readerClosed
  })
})
