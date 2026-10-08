import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  pauseNextRead: false,
  onReadStarted: undefined as (() => void) | undefined,
  releaseRead: undefined as (() => void) | undefined,
}))

vi.mock('../src/main/pipeline/fs-utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/pipeline/fs-utils.js')>()
  return {
    ...actual,
    readSessionLinesStream: (...args: Parameters<typeof actual.readSessionLinesStream>) => {
      const nativeStream = actual.readSessionLinesStream(...args)
      if (!hooks.pauseNextRead) return nativeStream
      hooks.pauseNextRead = false
      return Stream.fromEffect(
        Effect.promise(
          () =>
            new Promise<void>(resolve => {
              hooks.releaseRead = resolve
              hooks.onReadStarted?.()
            }),
        ),
      ).pipe(Stream.flatMap(() => nativeStream))
    },
  }
})

import { readFile, writeFile } from 'node:fs/promises'

import { appPaths, initAppPaths } from '../src/main/env.js'
import { flushCodexCache } from '../src/main/pipeline/codex-cache.js'
import {
  captureScanPricing,
  setLocalModelSavings,
  setModelAliases,
  setPriceOverrides,
} from '../src/main/pipeline/models.js'
import { createCodexProvider } from '../src/main/pipeline/providers/codex.js'
import type { ParsedProviderCall, SessionSource } from '../src/main/pipeline/providers/types.js'

const MODEL = 'codex-captured-pricing-model'

let root = ''
let priorCacheDir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-codex-captured-pricing-'))
  priorCacheDir = appPaths().cacheDir
  initAppPaths({ cacheDir: join(root, 'cache') })
  hooks.pauseNextRead = false
  hooks.onReadStarted = undefined
  hooks.releaseRead = undefined
  setModelAliases({})
  setLocalModelSavings({})
  setPriceOverrides({ [MODEL]: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 } })
})

afterEach(() => {
  setPriceOverrides({})
  setModelAliases({})
  setLocalModelSavings({})
  initAppPaths({ cacheDir: priorCacheDir })
  rmSync(root, { recursive: true, force: true })
})

function source(path: string, sessionId: string): SessionSource {
  return { path, project: 'codex-pricing', provider: 'codex', sessionId } as SessionSource
}

async function writeSession(path: string, sessionId: string): Promise<void> {
  await writeFile(
    path,
    [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-10-01T00:00:00.000Z',
        payload: { session_id: sessionId, cwd: '/project', originator: 'Codex', model: MODEL },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-10-01T00:00:01.000Z',
        payload: {
          type: 'token_count',
          info: {
            model: MODEL,
            last_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 2,
              output_tokens: 5,
              reasoning_output_tokens: 1,
            },
            total_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 2,
              output_tokens: 5,
              reasoning_output_tokens: 1,
              total_tokens: 18,
            },
          },
        },
      }),
    ].join('\n'),
  )
}

async function collect(parser: AsyncGenerator<ParsedProviderCall>): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  for await (const call of parser) calls.push(call)
  return calls
}

async function collectNative(parser: {
  parseStream?: () => Stream.Stream<ParsedProviderCall, Error>
}): Promise<ParsedProviderCall[]> {
  if (!parser.parseStream) throw new Error('Codex parser did not expose its native stream')
  const calls = await Effect.runPromise(Stream.runCollect(parser.parseStream()))
  return [...calls]
}

describe('Codex captured scan pricing', () => {
  it('uses the scan pricing supplied before live prices changed', async () => {
    const path = join(root, 'rollout-scan-context.jsonl')
    await writeSession(path, 'codex-scan-context')
    const pricing = captureScanPricing()
    const expected = pricing.calculateCost(MODEL, 8, 5, 0, 2, 0)
    setPriceOverrides({ [MODEL]: { input: 1000, output: 2000, cacheCreation: 3000, cacheRead: 4000 } })
    const calls = await collect(
      createCodexProvider('/unused')
        .createSessionParser(source(path, 'codex-scan-context'), new Set(), undefined, { pricing })
        .parse(),
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.costUSD).toBe(expected)
  })

  it('keeps a parser on its creation snapshot across file IO and uses refreshed pricing for the next parser', async () => {
    const firstPath = join(root, 'rollout-first.jsonl')
    const nextPath = join(root, 'rollout-next.jsonl')
    await writeSession(firstPath, 'codex-first')
    await writeSession(nextPath, 'codex-next')

    const firstPricing = captureScanPricing()
    const firstExpected = firstPricing.calculateCost(MODEL, 8, 5, 0, 2, 0)
    const provider = createCodexProvider('/unused')
    const firstParser = provider.createSessionParser(source(firstPath, 'codex-first'), new Set()).parse()
    hooks.pauseNextRead = true
    let started!: () => void
    const readStarted = new Promise<void>(resolve => {
      started = resolve
    })
    hooks.onReadStarted = started

    const pendingFirst = collect(firstParser)
    try {
      await readStarted
      setPriceOverrides({ [MODEL]: { input: 1000, output: 2000, cacheCreation: 3000, cacheRead: 4000 } })
    } finally {
      hooks.releaseRead?.()
    }
    const firstCalls = await pendingFirst
    expect(firstCalls).toHaveLength(1)
    expect(firstCalls[0]?.costUSD).toBe(firstExpected)

    const nextPricing = captureScanPricing()
    const nextExpected = nextPricing.calculateCost(MODEL, 8, 5, 0, 2, 0)
    const nextCalls = await collect(provider.createSessionParser(source(nextPath, 'codex-next'), new Set()).parse())
    expect(nextCalls).toHaveLength(1)
    expect(nextCalls[0]?.costUSD).toBe(nextExpected)
    expect(nextCalls[0]?.costUSD).not.toBe(firstExpected)

    await flushCodexCache()
    const warmCalls = await collect(provider.createSessionParser(source(firstPath, 'codex-first'), new Set()).parse())
    expect(warmCalls).toEqual(firstCalls)
  })

  it('returns identical calls from native cold and warm cache streams', async () => {
    const path = join(root, 'rollout-native.jsonl')
    await writeSession(path, 'codex-native')
    const provider = createCodexProvider('/unused')

    const cold = await collectNative(provider.createSessionParser(source(path, 'codex-native'), new Set()))
    const warm = await collectNative(provider.createSessionParser(source(path, 'codex-native'), new Set()))

    expect(cold).toHaveLength(1)
    expect(warm).toEqual(cold)
  })

  it('only records dedup keys as warm cached calls are pulled', async () => {
    const path = join(root, 'rollout-native-partial-cache.jsonl')
    await writeSession(path, 'codex-native-partial')
    const lines = await readFile(path, 'utf-8')
    const second = JSON.parse(lines.split('\n')[1]!) as {
      timestamp: string
      payload: {
        info: {
          last_token_usage: Record<string, number>
          total_token_usage: Record<string, number>
        }
      }
    }
    second.timestamp = '2026-10-01T00:00:02.000Z'
    second.payload.info.last_token_usage = {
      input_tokens: 20,
      cached_input_tokens: 4,
      output_tokens: 10,
      reasoning_output_tokens: 2,
    }
    second.payload.info.total_token_usage = {
      input_tokens: 30,
      cached_input_tokens: 6,
      output_tokens: 15,
      reasoning_output_tokens: 3,
      total_tokens: 54,
    }
    await writeFile(path, `${lines}\n${JSON.stringify(second)}`)

    const provider = createCodexProvider('/unused')
    const full = await collect(provider.createSessionParser(source(path, 'codex-native-partial'), new Set()).parse())
    expect(full).toHaveLength(2)

    const seen = new Set<string>()
    const parser = provider.createSessionParser(source(path, 'codex-native-partial'), seen)
    if (!parser.parseStream) throw new Error('Codex parser did not expose its native stream')
    await Effect.runPromise(Stream.runCollect(parser.parseStream().pipe(Stream.take(1))))
    expect(seen.size).toBe(1)
  })
})
