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
    readSessionFile: async (...args: Parameters<typeof actual.readSessionFile>) => {
      if (hooks.pauseNextRead) {
        hooks.pauseNextRead = false
        await new Promise<void>(resolve => {
          hooks.releaseRead = resolve
          hooks.onReadStarted?.()
        })
      }
      return actual.readSessionFile(...args)
    },
  }
})

import { writeFile } from 'node:fs/promises'

import {
  captureScanPricing,
  setLocalModelSavings,
  setModelAliases,
  setPriceOverrides,
} from '../src/main/pipeline/models.js'
import { createCopilotProvider } from '../src/main/pipeline/providers/copilot.js'
import type { ParsedProviderCall, SessionSource } from '../src/main/pipeline/providers/types.js'

const MODEL = 'copilot-captured-pricing-model'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-copilot-captured-pricing-'))
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

function source(path: string): SessionSource {
  return { path, project: 'copilot-pricing', provider: 'copilot' }
}

async function writeSession(path: string, sessionId: string): Promise<void> {
  await writeFile(
    path,
    [
      JSON.stringify({
        type: 'session.start',
        timestamp: '2026-10-01T00:00:00.000Z',
        data: { selectedModel: MODEL, sessionId },
      }),
      JSON.stringify({
        type: 'assistant.message',
        timestamp: '2026-10-01T00:00:01.000Z',
        data: { messageId: `${sessionId}-message`, model: MODEL, outputTokens: 100 },
      }),
    ].join('\n'),
  )
}

async function firstCall(parser: AsyncGenerator<ParsedProviderCall>): Promise<ParsedProviderCall> {
  const result = await parser.next()
  await parser.return(undefined)
  if (result.done) throw new Error('Copilot parser returned no call')
  return result.value
}

describe('Copilot captured scan pricing', () => {
  it('uses the scan pricing supplied before live prices changed', async () => {
    const path = join(root, 'scan-context', 'events.jsonl')
    await (await import('node:fs/promises')).mkdir(join(root, 'scan-context'), { recursive: true })
    await writeSession(path, 'scan-context')
    const pricing = captureScanPricing()
    const expected = pricing.calculateCost(MODEL, 0, 100, 0, 0, 0)
    setPriceOverrides({ [MODEL]: { input: 1000, output: 2000, cacheCreation: 3000, cacheRead: 4000 } })
    const call = await firstCall(
      createCopilotProvider().createSessionParser(source(path), new Set(), undefined, { pricing }).parse(),
    )
    expect(call.costUSD).toBe(expected)
  })

  it('keeps a parser on its creation snapshot across file IO and uses refreshed pricing for the next parser', async () => {
    const firstPath = join(root, 'first-session', 'events.jsonl')
    const nextPath = join(root, 'next-session', 'events.jsonl')
    await (await import('node:fs/promises')).mkdir(join(root, 'first-session'), { recursive: true })
    await (await import('node:fs/promises')).mkdir(join(root, 'next-session'), { recursive: true })
    await writeSession(firstPath, 'first-session')
    await writeSession(nextPath, 'next-session')

    const firstPricing = captureScanPricing()
    const firstExpected = firstPricing.calculateCost(MODEL, 0, 100, 0, 0, 0)
    const provider = createCopilotProvider()
    const firstParser = provider.createSessionParser(source(firstPath), new Set()).parse()
    hooks.pauseNextRead = true
    let started!: () => void
    const readStarted = new Promise<void>(resolve => {
      started = resolve
    })
    hooks.onReadStarted = started

    const pendingFirst = firstCall(firstParser)
    try {
      await readStarted
      setPriceOverrides({ [MODEL]: { input: 1000, output: 2000, cacheCreation: 3000, cacheRead: 4000 } })
    } finally {
      hooks.releaseRead?.()
    }
    const first = await pendingFirst
    expect(first.costUSD).toBe(firstExpected)

    const nextPricing = captureScanPricing()
    const nextExpected = nextPricing.calculateCost(MODEL, 0, 100, 0, 0, 0)
    const next = await firstCall(provider.createSessionParser(source(nextPath), new Set()).parse())
    expect(next.costUSD).toBe(nextExpected)
    expect(next.costUSD).not.toBe(firstExpected)
  })
})
