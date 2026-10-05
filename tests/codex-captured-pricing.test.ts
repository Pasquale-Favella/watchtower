import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
    readSessionLines: async function* (...args: Parameters<typeof actual.readSessionLines>) {
      if (hooks.pauseNextRead) {
        hooks.pauseNextRead = false
        await new Promise<void>(resolve => {
          hooks.releaseRead = resolve
          hooks.onReadStarted?.()
        })
      }
      yield* actual.readSessionLines(...args)
    },
  }
})

import { writeFile } from 'node:fs/promises'

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
})
