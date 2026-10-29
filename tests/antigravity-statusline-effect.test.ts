import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { Effect, type FileSystem, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { withProviderFileSystem } from './fixtures/provider-effects.js'

const hooks = vi.hoisted(() => ({
  streamFactory: undefined as (() => unknown) | undefined,
  lastOptions: undefined as { maxBytes?: number; signal?: AbortSignal } | undefined,
  acquired: 0,
  released: 0,
}))

vi.mock('../src/infrastructure/ingestion/fs-utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/infrastructure/ingestion/fs-utils.js')>()
  return {
    ...actual,
    readSessionLinesStream: (
      path: string,
      skipHead?: (head: string) => boolean,
      options?: { maxBytes?: number; signal?: AbortSignal },
    ) => {
      hooks.lastOptions = options
      if (hooks.streamFactory) return hooks.streamFactory() as ReturnType<typeof actual.readSessionLinesStream>
      return actual.readSessionLinesStream(path, skipHead, options)
    },
  }
})

import { appPaths, initAppPaths } from '../src/infrastructure/config/environment.js'
import { SessionLineReadError } from '../src/infrastructure/ingestion/fs-utils.js'
import {
  createAntigravityProvider,
  getAntigravityStatusLineEventsPath,
} from '../src/infrastructure/provider-adapters/antigravity.js'
import type { ParsedProviderCall, SessionSource } from '../src/infrastructure/provider-adapters/types.js'

let root = ''
let priorCacheDir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-antigravity-statusline-effect-'))
  priorCacheDir = appPaths().cacheDir
  initAppPaths({ cacheDir: root })
  hooks.streamFactory = undefined
  hooks.lastOptions = undefined
  hooks.acquired = 0
  hooks.released = 0
})

afterEach(() => {
  initAppPaths({ cacheDir: priorCacheDir })
  rmSync(root, { recursive: true, force: true })
})

function source(): SessionSource {
  return { path: getAntigravityStatusLineEventsPath(), project: 'antigravity-cli', provider: 'antigravity' }
}

function event(conversationId: string, inputTokens: number, at: string, model = 'test-model') {
  return {
    at,
    conversationId,
    model,
    usage: { inputTokens, outputTokens: inputTokens, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  }
}

function writeEvents(events: unknown[]): void {
  writeFileSync(source().path, `${events.map(value => JSON.stringify(value)).join('\n')}\n`)
}

function createPricing() {
  const calculateCost = vi.fn((_model: string, input: number, output: number) => input + output)
  return {
    calculateCost,
    calculateLocalModelSavings: () => null,
  }
}

async function collect(
  stream: Stream.Stream<ParsedProviderCall, Error, FileSystem.FileSystem>,
): Promise<ParsedProviderCall[]> {
  return await Effect.runPromise(withProviderFileSystem(Stream.runCollect(stream)))
}

function acquiredLineStream(lines: string[], onLine?: (line: string) => void): Stream.Stream<string, Error> {
  return Stream.scoped(
    Stream.unwrap(
      Effect.acquireRelease(
        Effect.sync(() => {
          hooks.acquired++
          return lines
        }),
        () => Effect.sync(() => void hooks.released++),
      ).pipe(
        Effect.map(values =>
          Stream.fromIterable(values).pipe(
            Stream.map(line => {
              onLine?.(line)
              return line
            }),
          ),
        ),
      ),
    ),
  )
}

describe('Antigravity statusline Effect parser', () => {
  it('groups adjacent snapshots and preserves last timestamps, singleton suppression, monotonic deltas, and RPC suppression', async () => {
    writeEvents([
      event('conversation-a', 10, '2026-10-01T00:00:01.000Z'),
      event('conversation-a', 10, '2026-10-01T00:00:02.000Z'),
      event('conversation-a', 20, '2026-10-01T00:00:03.000Z'),
      event('conversation-a', 30, '2026-10-01T00:00:04.000Z'),
      event('conversation-a', 30, '2026-10-01T00:00:05.000Z'),
      event('rpc-conversation', 50, '2026-10-01T00:00:06.000Z'),
      event('rpc-conversation', 50, '2026-10-01T00:00:07.000Z'),
    ])
    const seen = new Set(['antigravity:rpc-conversation:rpc-response'])
    const pricing = createPricing()
    const parser = createAntigravityProvider().createSessionParser(source(), seen, undefined, { pricing })
    if (!parser.parseStream) throw new Error('Statusline parser did not expose its native stream')

    const calls = await collect(parser.parseStream())

    expect(calls).toHaveLength(2)
    expect(calls.map(call => [call.inputTokens, call.outputTokens])).toEqual([
      [10, 10],
      [20, 20],
    ])
    expect(calls.map(call => call.timestamp)).toEqual(['2026-10-01T00:00:02.000Z', '2026-10-01T00:00:05.000Z'])
    expect(calls.map(call => call.deduplicationKey)).toEqual([
      'antigravity-statusline:conversation-a:0:test-model:10:10:0:0',
      'antigravity-statusline:conversation-a:1:test-model:30:30:0:0',
    ])
    expect(seen).toContain(calls[0]?.deduplicationKey)
    expect(seen).toContain(calls[1]?.deduplicationKey)
    expect(pricing.calculateCost).toHaveBeenCalledTimes(2)
    expect(hooks.lastOptions?.maxBytes).toBe(Infinity)
  })

  it('prices and marks only calls consumed by an early downstream reader', async () => {
    writeEvents([
      event('first', 1, '2026-10-01T00:00:01.000Z'),
      event('first', 1, '2026-10-01T00:00:02.000Z'),
      event('second', 2, '2026-10-01T00:00:03.000Z'),
      event('second', 2, '2026-10-01T00:00:04.000Z'),
    ])
    const seen = new Set<string>()
    const pricing = createPricing()
    const parser = createAntigravityProvider().createSessionParser(source(), seen, undefined, { pricing })
    if (!parser.parseStream) throw new Error('Statusline parser did not expose its native stream')

    const calls = await Effect.runPromise(
      withProviderFileSystem(Stream.runCollect(parser.parseStream().pipe(Stream.take(1)))),
    )

    expect(calls).toHaveLength(1)
    expect(pricing.calculateCost).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(new Set([calls[0]?.deduplicationKey]))
  })

  it('acquires and releases the line stream on normal EOF before yielding grouped results', async () => {
    hooks.streamFactory = () =>
      acquiredLineStream([
        JSON.stringify(event('one', 1, '2026-10-01T00:00:01.000Z')),
        JSON.stringify(event('one', 1, '2026-10-01T00:00:02.000Z')),
      ])
    const parser = createAntigravityProvider().createSessionParser(source(), new Set())
    if (!parser.parseStream) throw new Error('Statusline parser did not expose its native stream')

    const iterator = Stream.toAsyncIterable(parser.parseStream().pipe(Stream.provide(NodeFileSystem.layer)))[
      Symbol.asyncIterator
    ]()
    const first = await iterator.next()

    expect(first.done).toBe(false)
    expect(hooks.acquired).toBe(1)
    expect(hooks.released).toBe(1)
    await iterator.return?.()
  })

  it('releases the line stream when pricing fails after EOF', async () => {
    hooks.streamFactory = () =>
      acquiredLineStream([
        JSON.stringify(event('one', 1, '2026-10-01T00:00:01.000Z')),
        JSON.stringify(event('one', 1, '2026-10-01T00:00:02.000Z')),
      ])
    const pricing = createPricing()
    pricing.calculateCost.mockImplementation(() => {
      throw new Error('pricing failed')
    })
    const parser = createAntigravityProvider().createSessionParser(source(), new Set(), undefined, { pricing })
    if (!parser.parseStream) throw new Error('Statusline parser did not expose its native stream')

    await expect(collect(parser.parseStream())).rejects.toThrow('pricing failed')
    expect(hooks.acquired).toBe(1)
    expect(hooks.released).toBe(1)
  })

  it('discards every prefix group when the line stream fails before EOF', async () => {
    hooks.streamFactory = () =>
      Stream.concat(
        acquiredLineStream([
          JSON.stringify(event('one', 1, '2026-10-01T00:00:01.000Z')),
          JSON.stringify(event('one', 1, '2026-10-01T00:00:02.000Z')),
        ]),
        Stream.fail(new SessionLineReadError({ cause: new Error('read failed') })),
      )
    const parser = createAntigravityProvider().createSessionParser(source(), new Set())
    if (!parser.parseStream) throw new Error('Statusline parser did not expose its native stream')

    await expect(collect(parser.parseStream())).resolves.toEqual([])
    expect(hooks.acquired).toBe(1)
    expect(hooks.released).toBe(1)
  })

  it('fails an aborted parse and releases its acquired reader', async () => {
    const controller = new AbortController()
    hooks.streamFactory = () =>
      acquiredLineStream([JSON.stringify(event('one', 1, '2026-10-01T00:00:01.000Z'))], () =>
        controller.abort(new Error('stop scan')),
      )
    const parser = createAntigravityProvider().createSessionParser(source(), new Set(), undefined, {
      signal: controller.signal,
    })
    if (!parser.parseStream) throw new Error('Statusline parser did not expose its native stream')

    await expect(collect(parser.parseStream())).rejects.toHaveProperty('name', 'ScanAbortedError')
    expect(hooks.acquired).toBe(1)
    expect(hooks.released).toBe(1)
  })

  it('does not recover a read-shaped defect raised by the unparsed callback', async () => {
    hooks.streamFactory = () => acquiredLineStream(['invalid json'])
    const parser = createAntigravityProvider().createSessionParser(source(), new Set())
    if (!parser.parseStream) throw new Error('Statusline parser did not expose its native stream')
    const failure = new SessionLineReadError({ cause: new Error('callback failed') })

    await expect(collect(parser.parseStream(Effect.die(failure)))).rejects.toBe(failure)
    expect(hooks.released).toBe(1)
  })

  it('does not recover defects raised by the unparsed callback', async () => {
    hooks.streamFactory = () => acquiredLineStream(['invalid json'])
    const parser = createAntigravityProvider().createSessionParser(source(), new Set())
    if (!parser.parseStream) throw new Error('Statusline parser did not expose its native stream')

    await expect(collect(parser.parseStream(Effect.die(new Error('callback defect'))))).rejects.toThrow(
      'callback defect',
    )
    expect(hooks.released).toBe(1)
  })

  it('attaches the native conversation parser without using statusline parsing', () => {
    const parser = createAntigravityProvider().createSessionParser(
      { path: join(root, 'conversation.pb'), project: 'antigravity-cli', provider: 'antigravity' },
      new Set(),
    )
    expect(parser.parseStream).toBeTypeOf('function')
  })
})
