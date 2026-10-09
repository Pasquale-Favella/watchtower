import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  pauseNextRead: false,
  onReadStarted: undefined as (() => void) | undefined,
  releaseRead: undefined as (() => void) | undefined,
}))

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (hooks.pauseNextRead && String(args[0]).endsWith('.txt')) {
        hooks.pauseNextRead = false
        await new Promise<void>(resolve => {
          hooks.releaseRead = resolve
          hooks.onReadStarted?.()
        })
      }
      return actual.readFile(...args)
    },
  }
})

import {
  captureScanPricing,
  setLocalModelSavings,
  setModelAliases,
  setPriceOverrides,
} from '../src/main/pipeline/models.js'
import { createCursorAgentProvider } from '../src/main/pipeline/providers/cursor-agent.js'
import type { ParsedProviderCall, SessionSource } from '../src/main/pipeline/providers/types.js'

const MODEL = 'cursor-agent-captured-pricing-model'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-cursor-agent-captured-pricing-'))
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
  rmSync(root, { recursive: true, force: true })
})

function createSource(conversationId: string): SessionSource {
  const directory = join(root, 'agent-transcripts')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `${conversationId}.txt`)
  writeFileSync(path, 'user: <user_query>a prompt</user_query>\nA: an answer')
  return { path, project: 'cursor-agent-pricing', provider: 'cursor-agent' }
}

function addSummary(conversationId: string): void {
  const dbPath = join(root, 'ai-tracking', 'ai-code-tracking.db')
  mkdirSync(join(root, 'ai-tracking'), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(
    'CREATE TABLE IF NOT EXISTS conversation_summaries (conversationId TEXT, model TEXT, title TEXT, updatedAt TEXT)',
  )
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)').run(
    conversationId,
    MODEL,
    'captured pricing fixture',
    '2026-10-01T00:00:00.000Z',
  )
  db.close()
}

async function collect(parser: AsyncGenerator<ParsedProviderCall>): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  for await (const call of parser) calls.push(call)
  return calls
}

describe('Cursor Agent captured scan pricing', () => {
  it('keeps the transcript parser on its creation snapshot across file IO and refreshes the next parser', async () => {
    const firstSource = createSource('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    addSummary('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    const provider = createCursorAgentProvider(root)
    const firstPricing = captureScanPricing()
    const parser = provider.createSessionParser(firstSource, new Set())

    hooks.pauseNextRead = true
    let started!: () => void
    const readStarted = new Promise<void>(resolve => {
      started = resolve
    })
    hooks.onReadStarted = started
    const pending = collect(parser.parse())
    try {
      await readStarted
      setPriceOverrides({ [MODEL]: { input: 1000, output: 2000, cacheCreation: 3000, cacheRead: 4000 } })
    } finally {
      hooks.releaseRead?.()
    }

    const firstCalls = await pending
    expect(firstCalls).toHaveLength(1)
    const firstCall = firstCalls[0]
    if (!firstCall) throw new Error('Cursor Agent parser returned no first call')
    expect(firstCall.costUSD).toBe(
      firstPricing.calculateCost(MODEL, firstCall.inputTokens, firstCall.outputTokens, 0, 0, 0),
    )

    const nextId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const nextSource = createSource(nextId)
    addSummary(nextId)
    const nextPricing = captureScanPricing()
    const nextCalls = await collect(createCursorAgentProvider(root).createSessionParser(nextSource, new Set()).parse())
    expect(nextCalls).toHaveLength(1)
    const nextCall = nextCalls[0]
    if (!nextCall) throw new Error('Cursor Agent parser returned no next call')
    expect(nextCall.costUSD).toBe(
      nextPricing.calculateCost(MODEL, nextCall.inputTokens, nextCall.outputTokens, 0, 0, 0),
    )
    expect(nextCall.costUSD).not.toBe(firstCall.costUSD)
  })

  it('uses the pricing capability supplied in provider context', async () => {
    const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    const transcript = createSource(id)
    addSummary(id)
    const pricing = captureScanPricing()
    setPriceOverrides({ [MODEL]: { input: 1000, output: 2000, cacheCreation: 3000, cacheRead: 4000 } })
    const calls = await collect(
      createCursorAgentProvider(root).createSessionParser(transcript, new Set(), undefined, { pricing }).parse(),
    )
    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (!call) throw new Error('Cursor Agent context parser returned no call')
    expect(call.costUSD).toBe(pricing.calculateCost(MODEL, call.inputTokens, call.outputTokens, 0, 0, 0))
  })
})
