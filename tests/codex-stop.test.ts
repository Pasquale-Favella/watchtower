import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Fiber, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  statCalls: 0,
  readCalls: 0,
  streamOpens: 0,
  streamCloses: 0,
  blockCacheRead: false,
  readSignal: undefined as AbortSignal | undefined,
  pauseNextStream: false,
  onStreamStarted: undefined as (() => void) | undefined,
  onStreamClosed: undefined as (() => void) | undefined,
  onCacheReadStarted: undefined as (() => void) | undefined,
  blockFlushWrite: false,
  blockFlushOpen: false,
  failNextFlushClose: false,
  flushTempPath: undefined as string | undefined,
  flushHandleCloses: 0,
  onFlushOpenStarted: undefined as (() => void) | undefined,
  releaseFlushOpen: undefined as (() => void) | undefined,
  onFlushWriteStarted: undefined as (() => void) | undefined,
  releaseFlushWrite: undefined as (() => void) | undefined,
}))

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args)
      hooks.streamOpens++
      stream.once('close', () => {
        hooks.streamCloses++
        hooks.onStreamClosed?.()
      })
      if (hooks.pauseNextStream) {
        hooks.pauseNextStream = false
        stream.once('data', () => {
          stream.pause()
          hooks.onStreamStarted?.()
        })
      }
      return stream
    },
  }
})

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: (...args: Parameters<typeof actual.stat>) => {
      hooks.statCalls++
      return actual.stat(...args)
    },
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      hooks.readCalls++
      if (hooks.blockCacheRead && String(args[0]).endsWith('codex-results.json')) {
        const options = args[1]
        hooks.readSignal =
          typeof options === 'object' && options !== null && 'signal' in options
            ? (options.signal as AbortSignal)
            : undefined
        hooks.onCacheReadStarted?.()
        return new Promise<Buffer | string>((_resolve, reject) => {
          const signal = hooks.readSignal
          if (signal?.aborted) reject(signal.reason)
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      return actual.readFile(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (hooks.blockFlushOpen && String(args[0]).endsWith('.tmp')) {
        hooks.blockFlushOpen = false
        await new Promise<void>(resolve => {
          hooks.releaseFlushOpen = resolve
          hooks.onFlushOpenStarted?.()
        })
      }
      const handle = await actual.open(...args)
      if (
        (!hooks.blockFlushWrite && !hooks.releaseFlushOpen && !hooks.failNextFlushClose) ||
        !String(args[0]).endsWith('.tmp')
      )
        return handle
      hooks.flushTempPath = String(args[0])
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'writeFile' && hooks.blockFlushWrite) {
            return async (...writeArgs: Parameters<typeof handle.writeFile>) => {
              await new Promise<void>(resolve => {
                hooks.releaseFlushWrite = resolve
                hooks.onFlushWriteStarted?.()
              })
              return handle.writeFile(...writeArgs)
            }
          }
          if (property === 'close') {
            return async () => {
              hooks.flushHandleCloses++
              if (hooks.failNextFlushClose) {
                hooks.failNextFlushClose = false
                throw new Error('cache close failed')
              }
              return handle.close()
            }
          }
          return Reflect.get(target, property, receiver)
        },
      })
    },
  }
})

import { writeFile } from 'node:fs/promises'

import { appPaths, initAppPaths } from '../src/main/env.js'
import { flushCodexCacheEffect, lookupCachedCodexResultsEffect } from '../src/main/pipeline/codex-cache.js'
import { createCodexProvider } from '../src/main/pipeline/providers/codex.js'
import type { ProviderScanContext } from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'

let root = ''
let priorCacheDir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-codex-stop-'))
  priorCacheDir = appPaths().cacheDir
  initAppPaths({ cacheDir: join(root, 'cache') })
  hooks.statCalls = 0
  hooks.readCalls = 0
  hooks.streamOpens = 0
  hooks.streamCloses = 0
  hooks.blockCacheRead = false
  hooks.readSignal = undefined
  hooks.pauseNextStream = false
  hooks.onStreamStarted = undefined
  hooks.onStreamClosed = undefined
  hooks.onCacheReadStarted = undefined
  hooks.blockFlushWrite = false
  hooks.blockFlushOpen = false
  hooks.failNextFlushClose = false
  hooks.flushTempPath = undefined
  hooks.flushHandleCloses = 0
  hooks.onFlushOpenStarted = undefined
  hooks.releaseFlushOpen = undefined
  hooks.onFlushWriteStarted = undefined
  hooks.releaseFlushWrite = undefined
})

afterEach(async () => {
  initAppPaths({ cacheDir: priorCacheDir })
  rmSync(root, { recursive: true, force: true })
})

function source(path: string) {
  return { path, project: 'codex-stop-project', provider: 'codex' }
}

async function writeSession(path: string, trailer = ''): Promise<void> {
  await writeFile(
    path,
    [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-10-01T00:00:00.000Z',
        payload: { session_id: 'stop-session', cwd: '/project', originator: 'Codex' },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-10-01T00:00:01.000Z',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 2,
              output_tokens: 5,
              reasoning_output_tokens: 1,
            },
            total_token_usage: {
              total_tokens: 18,
              input_tokens: 10,
              cached_input_tokens: 2,
              output_tokens: 5,
              reasoning_output_tokens: 1,
            },
          },
        },
      }),
      trailer,
    ].join('\n'),
  )
}

function parse(path: string, seenKeys = new Set<string>(), context?: ProviderScanContext) {
  return createCodexProvider('/unused').createSessionParser(source(path), seenKeys, undefined, context).parse()
}

function flush(signal?: AbortSignal): Promise<void> {
  return Effect.runPromise(Effect.scoped(flushCodexCacheEffect(signal)))
}

describe('Codex scan cancellation', () => {
  it('preserves the typed scan abort when a native cache read is cancelled without an explicit reason', async () => {
    const path = join(root, 'native-cache-abort.jsonl')
    await writeFile(path, '')
    hooks.blockCacheRead = true
    const started = new Promise<void>(resolve => {
      hooks.onCacheReadStarted = resolve
    })
    const controller = new AbortController()
    const parser = createCodexProvider('/unused').createSessionParser(source(path), new Set(), undefined, {
      signal: controller.signal,
    })
    if (!parser.parseStream) throw new Error('Codex must provide a native parser stream')
    const result = Effect.runPromise(Stream.runCollect(parser.parseStream()))
    const rejected = expect(result).rejects.toMatchObject({ _tag: 'ScanAbortedError', message: 'scan aborted' })
    await started
    controller.abort()
    await rejected
    expect(hooks.readSignal?.aborted).toBe(true)
    expect(hooks.streamOpens).toBe(0)
  })

  it('passes cancellation to cache loading and does not memoize a cancelled empty cache', async () => {
    const path = join(root, 'cache-read-source.jsonl')
    await writeFile(path, '')
    hooks.blockCacheRead = true
    let start!: () => void
    const started = new Promise<void>(resolve => {
      start = resolve
    })
    hooks.onCacheReadStarted = start
    const controller = new AbortController()

    const pending = Effect.runPromise(
      Effect.scoped(lookupCachedCodexResultsEffect(path, controller.signal).pipe(Effect.map(value => value.calls))),
    )
    await started
    expect(hooks.readSignal).not.toBe(controller.signal)
    controller.abort(new ScanAbortedError({ message: 'scan aborted' }))
    await expect(pending).rejects.toMatchObject({ _tag: 'ScanAbortedError' })
    expect(hooks.readSignal?.aborted).toBe(true)

    hooks.blockCacheRead = false
    await expect(
      Effect.runPromise(Effect.scoped(lookupCachedCodexResultsEffect(path, undefined).pipe(Effect.map(x => x.calls)))),
    ).resolves.toBeNull()
    expect(hooks.readCalls).toBe(2)
  })

  it('closes the bounded discovery header stream when its scan is stopped', async () => {
    const codexHome = join(root, 'codex-home')
    const sessionDir = join(codexHome, 'sessions', '2026', '10', '05')
    const path = join(sessionDir, 'rollout-header.jsonl')
    await (await import('node:fs/promises')).mkdir(sessionDir, { recursive: true })
    await writeFile(
      path,
      `${JSON.stringify({ type: 'session_meta', payload: { originator: 'Codex', cwd: '/project' } })}${'x'.repeat(2 * 1024 * 1024)}`,
    )
    hooks.pauseNextStream = true

    let start!: () => void
    const started = new Promise<void>(resolve => {
      start = resolve
    })
    let close!: () => void
    const closed = new Promise<void>(resolve => {
      close = resolve
    })
    hooks.onStreamStarted = start
    hooks.onStreamClosed = close

    const controller = new AbortController()
    const pending = createCodexProvider(codexHome).discoverSessions({ signal: controller.signal })
    await started
    controller.abort(new ScanAbortedError({ message: 'scan aborted' }))

    await expect(pending).rejects.toMatchObject({ _tag: 'ScanAbortedError' })
    expect(hooks.streamCloses).toBe(1)
    await closed
    expect(hooks.streamCloses).toBe(1)
  })

  it('stops an active native session stream, drains it, and skips cache publication', async () => {
    const path = join(root, 'rollout-stop.jsonl')
    await writeSession(path, 'x'.repeat(2 * 1024 * 1024))
    hooks.pauseNextStream = true

    let start!: () => void
    const started = new Promise<void>(resolve => {
      start = resolve
    })
    let close!: () => void
    const closed = new Promise<void>(resolve => {
      close = resolve
    })
    hooks.onStreamStarted = start
    hooks.onStreamClosed = close

    const controller = new AbortController()
    const seenKeys = new Set<string>()
    const parser = parse(path, seenKeys, { signal: controller.signal })
    const pending = parser.next()
    await started
    controller.abort(new ScanAbortedError({ message: 'scan aborted' }))

    await expect(pending).rejects.toMatchObject({ _tag: 'ScanAbortedError', message: 'scan aborted' })
    expect(hooks.streamCloses).toBe(1)
    await closed
    expect(hooks.streamOpens).toBe(1)
    expect(hooks.streamCloses).toBe(1)
    expect(seenKeys).toEqual(new Set())
    await expect(parser.next()).resolves.toMatchObject({ done: true })

    await flush()
    const { readFile: readCache } = await import('node:fs/promises')
    const cache = JSON.parse(await readCache(join(root, 'cache', 'codex-results.json'), 'utf-8')) as {
      files: Record<string, unknown>
    }
    expect(cache.files[path]).toBeUndefined()
  })

  it('does no cache or source IO for a pre-aborted parser', async () => {
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    controller.abort(abort)
    const before = { stats: hooks.statCalls, reads: hooks.readCalls, streams: hooks.streamOpens }
    const seenKeys = new Set<string>()

    await expect(parse(join(root, 'never-read.jsonl'), seenKeys, { signal: controller.signal }).next()).rejects.toBe(
      abort,
    )
    expect({ stats: hooks.statCalls, reads: hooks.readCalls, streams: hooks.streamOpens }).toEqual(before)
    expect(seenKeys).toEqual(new Set())
  })

  it('uses cached calls without opening the session stream on a warm parse', async () => {
    const path = join(root, 'rollout-cached.jsonl')
    await writeSession(path)
    const first = parse(path)
    const calls = []
    for await (const call of first) calls.push(call)
    await flush()
    const streamOpens = hooks.streamOpens

    const seenKeys = new Set<string>()
    const cached = parse(path, seenKeys)
    const cachedCalls = []
    for await (const call of cached) cachedCalls.push(call)

    expect(cachedCalls).toEqual(calls)
    expect(hooks.streamOpens).toBe(streamOpens)
    expect(seenKeys).toEqual(new Set(calls.map(call => call.deduplicationKey)))
  })

  it('removes the second cache fingerprint stat from a cold parser request', async () => {
    const path = join(root, 'single-stat-lookup.jsonl')
    await writeSession(path)
    hooks.statCalls = 0

    const calls = []
    for await (const call of parse(path)) calls.push(call)

    expect(calls).toHaveLength(1)
    // One stat is owned by the session-line reader; the cache lookup supplies
    // the parser fingerprint without its former second stat.
    expect(hooks.statCalls).toBe(2)
  })

  it('cancels a staged cache flush without replacing disk or evicting memory entries', async () => {
    const cachedPath = join(root, 'rollout-flush-cached.jsonl')
    const pendingPath = join(root, 'rollout-flush-pending.jsonl')
    await writeSession(cachedPath)
    await writeSession(pendingPath)

    const initial = parse(cachedPath)
    const initialCalls = []
    for await (const call of initial) initialCalls.push(call)
    await flush()

    const cachePath = join(root, 'cache', 'codex-results.json')
    const oldContents = await (await import('node:fs/promises')).readFile(cachePath)
    const pending = parse(pendingPath)
    const pendingCalls = []
    for await (const call of pending) pendingCalls.push(call)

    hooks.blockFlushWrite = true
    let start!: () => void
    const started = new Promise<void>(resolve => {
      start = resolve
    })
    hooks.onFlushWriteStarted = start
    const controller = new AbortController()
    const flushing = flush(controller.signal)
    let tempPath: string | undefined
    try {
      await started
      tempPath = hooks.flushTempPath
      if (!tempPath) throw new Error('Cache flush did not create its temporary file')
    } finally {
      controller.abort(new ScanAbortedError({ message: 'scan aborted' }))
      hooks.releaseFlushWrite?.()
    }
    await expect(flushing).rejects.toMatchObject({ _tag: 'ScanAbortedError' })

    expect(hooks.flushHandleCloses).toBe(1)
    expect(tempPath).toBeDefined()
    expect(existsSync(tempPath ?? '')).toBe(false)
    await expect((await import('node:fs/promises')).readFile(cachePath)).resolves.toEqual(oldContents)
    await expect(
      Effect.runPromise(
        Effect.scoped(lookupCachedCodexResultsEffect(cachedPath, undefined).pipe(Effect.map(x => x.calls))),
      ),
    ).resolves.toEqual(initialCalls)
    await expect(
      Effect.runPromise(
        Effect.scoped(lookupCachedCodexResultsEffect(pendingPath, undefined).pipe(Effect.map(x => x.calls))),
      ),
    ).resolves.toEqual(pendingCalls)
  })

  it('closes an opened cache handle when interrupted during open acquisition', async () => {
    const cachedPath = join(root, 'rollout-open-cached.jsonl')
    const pendingPath = join(root, 'rollout-open-pending.jsonl')
    await writeSession(cachedPath)
    await writeSession(pendingPath)

    const initialCalls = []
    for await (const call of parse(cachedPath)) initialCalls.push(call)
    await flush()
    const cachePath = join(root, 'cache', 'codex-results.json')
    const oldContents = await (await import('node:fs/promises')).readFile(cachePath)
    const pendingCalls = []
    for await (const call of parse(pendingPath)) pendingCalls.push(call)

    hooks.blockFlushOpen = true
    let start!: () => void
    const started = new Promise<void>(resolve => {
      start = resolve
    })
    hooks.onFlushOpenStarted = start
    const fiber = Effect.runFork(Effect.scoped(flushCodexCacheEffect(undefined)))
    await started

    const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
    hooks.releaseFlushOpen?.()
    await interrupted

    expect(hooks.flushHandleCloses).toBe(1)
    expect(hooks.flushTempPath).toBeDefined()
    expect(existsSync(hooks.flushTempPath ?? '')).toBe(false)
    await expect((await import('node:fs/promises')).readFile(cachePath)).resolves.toEqual(oldContents)
    await expect(
      Effect.runPromise(
        Effect.scoped(lookupCachedCodexResultsEffect(cachedPath, undefined).pipe(Effect.map(x => x.calls))),
      ),
    ).resolves.toEqual(initialCalls)
    await expect(
      Effect.runPromise(
        Effect.scoped(lookupCachedCodexResultsEffect(pendingPath, undefined).pipe(Effect.map(x => x.calls))),
      ),
    ).resolves.toEqual(pendingCalls)
  })

  it('does not replace the published cache when closing the staged handle fails', async () => {
    const cachedPath = join(root, 'rollout-close-cached.jsonl')
    const pendingPath = join(root, 'rollout-close-pending.jsonl')
    await writeSession(cachedPath)
    await writeSession(pendingPath)
    for await (const _call of parse(cachedPath)) {
      /* Populate the existing disk cache. */
    }
    await flush()
    const cachePath = join(root, 'cache', 'codex-results.json')
    const oldContents = await (await import('node:fs/promises')).readFile(cachePath)
    const pendingCalls = []
    for await (const call of parse(pendingPath)) pendingCalls.push(call)

    hooks.failNextFlushClose = true
    await flush()

    expect(hooks.flushHandleCloses).toBe(2)
    expect(hooks.flushTempPath).toBeDefined()
    expect(existsSync(hooks.flushTempPath ?? '')).toBe(false)
    await expect((await import('node:fs/promises')).readFile(cachePath)).resolves.toEqual(oldContents)
    await expect(
      Effect.runPromise(lookupCachedCodexResultsEffect(pendingPath).pipe(Effect.map(x => x.calls))),
    ).resolves.toEqual(pendingCalls)
  })
})
