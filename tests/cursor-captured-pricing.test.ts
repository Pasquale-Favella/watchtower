import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  pauseNextRead: false,
  onReadStarted: undefined as (() => void) | undefined,
  releaseRead: undefined as (() => void) | undefined,
}))

vi.mock('../src/main/pipeline/cursor-cache.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/pipeline/cursor-cache.js')>()
  return {
    ...actual,
    readCachedResults: async (dbPath: string) => {
      if (hooks.pauseNextRead) {
        hooks.pauseNextRead = false
        await new Promise<void>(resolve => {
          hooks.releaseRead = resolve
          hooks.onReadStarted?.()
        })
      }
      return (hooks.cache.get(dbPath) as Awaited<ReturnType<typeof actual.readCachedResults>>) ?? null
    },
    writeCachedResults: async (dbPath: string, calls: unknown[]) => {
      hooks.cache.set(dbPath, calls)
    },
  }
})

import {
  captureScanPricing,
  setLocalModelSavings,
  setModelAliases,
  setPriceOverrides,
} from '../src/main/pipeline/models.js'
import { createCursorProvider } from '../src/main/pipeline/providers/cursor.js'
import type { ParsedProviderCall, SessionSource } from '../src/main/pipeline/providers/types.js'

const MODEL = 'cursor-captured-pricing-model'
const UUID = '11111111-1111-1111-1111-111111111111'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-cursor-captured-pricing-'))
  hooks.cache.clear()
  hooks.pauseNextRead = false
  hooks.onReadStarted = undefined
  hooks.releaseRead = undefined
  setModelAliases({})
  setLocalModelSavings({})
  setPriceOverrides({
    [MODEL]: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 },
  })
})

afterEach(() => {
  setPriceOverrides({})
  setModelAliases({})
  setLocalModelSavings({})
  rmSync(root, { recursive: true, force: true })
})

function createDb(filename: string): string {
  const path = join(root, filename)
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)')
  const insert = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
  const now = new Date().toISOString()
  insert.run(
    `bubbleId:${UUID}:bubble-token`,
    JSON.stringify({
      type: 2,
      createdAt: now,
      text: 'bubble reply',
      requestId: 'joined-request',
      tokenCount: { inputTokens: 10, outputTokens: 5 },
      modelInfo: { modelName: MODEL },
      codeBlocks: [],
    }),
  )
  insert.run(
    `bubbleId:22222222-2222-2222-2222-222222222222:bubble-meter`,
    JSON.stringify({
      type: 2,
      createdAt: now,
      text: '',
      tokenCount: { inputTokens: 0, outputTokens: 0 },
      modelInfo: { modelName: MODEL },
      codeBlocks: [],
    }),
  )
  insert.run(
    'composerData:22222222-2222-2222-2222-222222222222',
    JSON.stringify({
      promptTokenBreakdown: { totalUsedTokens: 30 },
      createdAt: Date.now(),
    }),
  )
  insert.run(
    'agentKv:blob:unjoined',
    JSON.stringify({
      role: 'user',
      content: 'unjoined prompt has enough characters to estimate tokens',
      providerOptions: { cursor: { requestId: 'unjoined-request', modelName: MODEL } },
    }),
  )
  db.close()
  return path
}

function source(path: string): SessionSource {
  return { path, project: 'cursor-pricing', provider: 'cursor' }
}

async function collect(parser: AsyncGenerator<ParsedProviderCall>): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  for await (const call of parser) calls.push(call)
  return calls
}

describe('Cursor captured scan pricing', () => {
  it('keeps all parser cost variants on one snapshot across cache IO and refreshes the next parser', async () => {
    const firstPath = createDb('first.vscdb')
    const nextPath = createDb('next.vscdb')
    const provider = createCursorProvider()
    const firstPricing = captureScanPricing()
    const firstParser = provider.createSessionParser(source(firstPath), new Set())

    hooks.pauseNextRead = true
    let started!: () => void
    const readStarted = new Promise<void>(resolve => {
      started = resolve
    })
    hooks.onReadStarted = started
    const pendingFirst = collect(firstParser.parse())
    try {
      await readStarted
      setPriceOverrides({ [MODEL]: { input: 1000, output: 2000, cacheCreation: 3000, cacheRead: 4000 } })
    } finally {
      hooks.releaseRead?.()
    }

    const firstCalls = await pendingFirst
    expect(firstCalls.map(call => call.deduplicationKey)).toEqual([
      `cursor:bubble:bubbleId:${UUID}:bubble-token`,
      'cursor:composer-input:22222222-2222-2222-2222-222222222222',
      'cursor:agentKv:unjoined-request',
    ])
    for (const call of firstCalls) {
      expect(call.costUSD).toBe(firstPricing.calculateCost(MODEL, call.inputTokens, call.outputTokens, 0, 0, 0))
    }

    const nextPricing = captureScanPricing()
    const nextCalls = await collect(provider.createSessionParser(source(nextPath), new Set()).parse())
    expect(nextCalls.map(call => call.costUSD)).toEqual(
      firstCalls.map(call => nextPricing.calculateCost(MODEL, call.inputTokens, call.outputTokens, 0, 0, 0)),
    )
    expect(nextCalls.map(call => call.costUSD)).not.toEqual(firstCalls.map(call => call.costUSD))

    const warmCalls = await collect(provider.createSessionParser(source(firstPath), new Set()).parse())
    expect(warmCalls).toEqual(firstCalls)
  })

  it('uses the pricing capability supplied in provider context', async () => {
    const path = createDb('context.vscdb')
    const pricing = captureScanPricing()
    setPriceOverrides({ [MODEL]: { input: 1000, output: 2000, cacheCreation: 3000, cacheRead: 4000 } })
    const calls = await collect(
      createCursorProvider().createSessionParser(source(path), new Set(), undefined, { pricing }).parse(),
    )
    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call.costUSD).toBe(pricing.calculateCost(MODEL, call.inputTokens, call.outputTokens, 0, 0, 0))
    }
  })
})
