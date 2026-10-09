import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  homeDir: '',
  pauseNextRead: false,
  pauseSuffix: 'antigravity-statusline.jsonl',
  pauseNextRpc: false,
  onReadStarted: undefined as (() => void) | undefined,
  releaseRead: undefined as (() => void) | undefined,
  openedDatabase: vi.fn(),
  closedDatabase: vi.fn(),
}))

vi.mock('../src/main/pipeline/sqlite.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/pipeline/sqlite.js')>()
  return {
    ...actual,
    openDatabase: (path: string) => {
      const db = actual.openDatabase(path)
      hooks.openedDatabase(path)
      return {
        ...db,
        close: () => {
          db.close()
          hooks.closedDatabase(path)
        },
      }
    },
  }
})

vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => hooks.homeDir || actual.homedir() }
})

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string) => void
      callback(
        null,
        'language_server_antigravity --https_server_port 43123 --csrf_token capturedpricingtoken123 --app_data_dir antigravity-cli',
      )
      return {} as ReturnType<typeof actual.execFile>
    },
  }
})

vi.mock('https', async importOriginal => {
  const actual = await importOriginal<typeof import('node:https')>()
  const request = (
    options: { path: string },
    onResponse: (response: {
      statusCode: number
      on: (event: string, listener: (chunk?: Buffer) => void) => void
    }) => void,
  ) => {
    let body = ''
    return {
      on: () => undefined,
      write: (value: string) => {
        body += value
      },
      end: () => {
        const responseListeners = new Map<string, (chunk?: Buffer) => void>()
        onResponse({
          statusCode: 200,
          on: (event, listener) => responseListeners.set(event, listener),
        })
        const reply = (): void => {
          const response = options.path.endsWith('GetAvailableModels')
            ? { models: { [MODEL]: { model: MODEL, displayName: MODEL } } }
            : {
                generatorMetadata: [
                  {
                    chatModel: {
                      model: MODEL,
                      usage: {
                        model: MODEL,
                        inputTokens: '10',
                        outputTokens: '5',
                        responseOutputTokens: '5',
                        apiProvider: 'fixture',
                        responseId: JSON.parse(body).cascadeId,
                      },
                      chatStartMetadata: { createdAt: '2026-10-01T00:00:00.000Z' },
                    },
                  },
                ],
              }
          responseListeners.get('data')?.(Buffer.from(JSON.stringify(response)))
          responseListeners.get('end')?.()
        }
        if (hooks.pauseNextRpc && options.path.endsWith('GetAvailableModels')) {
          hooks.pauseNextRpc = false
          hooks.onReadStarted?.()
          hooks.releaseRead = reply
        } else {
          queueMicrotask(reply)
        }
      },
      destroy: () => undefined,
    }
  }
  function TestAgent(): Record<string, never> {
    return {}
  }
  return { ...actual, request, Agent: TestAgent, default: { Agent: TestAgent, request } } as unknown as typeof actual
})

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (hooks.pauseNextRead && String(args[0]).endsWith(hooks.pauseSuffix)) {
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

import { appPaths, initAppPaths } from '../src/main/env.js'
import {
  captureScanPricing,
  setLocalModelSavings,
  setModelAliases,
  setPriceOverrides,
} from '../src/main/pipeline/models.js'
import { createAntigravityProvider, flushAntigravityCache } from '../src/main/pipeline/providers/antigravity.js'
import type { ParsedProviderCall, SessionSource } from '../src/main/pipeline/providers/types.js'

const MODEL = 'antigravity-captured-pricing-model'

let root = ''
let priorCacheDir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-antigravity-captured-pricing-'))
  hooks.homeDir = root
  priorCacheDir = appPaths().cacheDir
  initAppPaths({ cacheDir: root })
  hooks.pauseNextRead = false
  hooks.pauseSuffix = 'antigravity-statusline.jsonl'
  hooks.pauseNextRpc = false
  hooks.onReadStarted = undefined
  hooks.releaseRead = undefined
  hooks.openedDatabase.mockClear()
  hooks.closedDatabase.mockClear()
  setModelAliases({})
  setLocalModelSavings({})
  setPriceOverrides({ [MODEL]: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 } })
})

afterEach(async () => {
  await flushAntigravityCache()
  setPriceOverrides({})
  setModelAliases({})
  setLocalModelSavings({})
  initAppPaths({ cacheDir: priorCacheDir })
  hooks.homeDir = ''
  rmSync(root, { recursive: true, force: true })
})

function writeStatusLine(): string {
  const path = join(root, 'antigravity-statusline.jsonl')
  writeFileSync(
    path,
    JSON.stringify({
      at: '2026-10-01T00:00:00.000Z',
      conversationId: 'captured-pricing-conversation',
      model: MODEL,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 2,
      },
    }),
  )
  return path
}

function source(path: string): SessionSource {
  return { path, project: 'antigravity-cli', provider: 'antigravity' }
}

function encodeVarint(value: number): number[] {
  const bytes: number[] = []
  let remaining = value
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80)
    remaining >>>= 7
  }
  bytes.push(remaining)
  return bytes
}

function varintField(number: number, value: number): number[] {
  return [...encodeVarint(number * 8), ...encodeVarint(value)]
}

function bytesField(number: number, value: Uint8Array): number[] {
  return [...encodeVarint(number * 8 + 2), ...encodeVarint(value.length), ...value]
}

function createSqliteGenMetadata(): string {
  const usage = [
    ...varintField(2, 10),
    ...varintField(3, 5),
    ...varintField(9, 5),
    ...bytesField(11, new TextEncoder().encode('sqlite-response')),
  ]
  const chat = [
    ...bytesField(4, Uint8Array.from(usage)),
    ...bytesField(19, new TextEncoder().encode(MODEL)),
    ...bytesField(21, new TextEncoder().encode(MODEL)),
  ]
  const metadata = Uint8Array.from(bytesField(1, Uint8Array.from(chat)))
  const path = join(root, 'antigravity-cache-fixture.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE gen_metadata (idx INTEGER, data BLOB)')
  db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, metadata)
  db.close()
  return path
}

async function collect(parser: AsyncGenerator<ParsedProviderCall>): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  for await (const call of parser) calls.push(call)
  return calls
}

describe('Antigravity captured scan pricing', () => {
  it('keeps a statusline parser on its creation snapshot across file IO and refreshes the next parser', async () => {
    const path = writeStatusLine()
    const provider = createAntigravityProvider()
    const sourceValue = source(path)
    const firstPricing = captureScanPricing()
    const parser = provider.createSessionParser(sourceValue, new Set())

    hooks.pauseNextRead = true
    let started!: () => void
    const readStarted = new Promise<void>(resolve => {
      started = resolve
    })
    hooks.onReadStarted = started
    const pendingFirst = collect(parser.parse())
    try {
      await readStarted
      setPriceOverrides({ [MODEL]: { input: 1000, output: 2000, cacheCreation: 3000, cacheRead: 4000 } })
    } finally {
      hooks.releaseRead?.()
    }

    const firstCalls = await pendingFirst
    expect(firstCalls).toHaveLength(1)
    expect(firstCalls[0]?.costUSD).toBe(firstPricing.calculateCost(MODEL, 10, 5, 3, 2, 0))

    const nextPricing = captureScanPricing()
    const nextCalls = await collect(provider.createSessionParser(sourceValue, new Set()).parse())
    expect(nextCalls).toHaveLength(1)
    expect(nextCalls[0]?.costUSD).toBe(nextPricing.calculateCost(MODEL, 10, 5, 3, 2, 0))
    expect(nextCalls[0]?.costUSD).not.toBe(firstCalls[0]?.costUSD)
  })

  it('uses the captured snapshot for SQLite generator metadata after cache IO', async () => {
    const path = createSqliteGenMetadata()
    const firstPricing = captureScanPricing()
    const parser = createAntigravityProvider().createSessionParser(source(path), new Set())

    hooks.pauseSuffix = 'antigravity-results.json'
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

    const calls = await pending
    expect(calls).toHaveLength(1)
    expect(calls[0]?.costUSD).toBe(firstPricing.calculateCost(MODEL, 10, 5, 0, 0, 0))
    // This fixture lacks the optional trajectory_metadata_blob table. Its
    // failed workspace lookup must close the real DB before falling back.
    expect(hooks.openedDatabase).toHaveBeenCalledTimes(2)
    expect(hooks.closedDatabase.mock.calls).toEqual(hooks.openedDatabase.mock.calls)
  })

  it('uses the captured snapshot for generator metadata returned by the local RPC', async () => {
    const cascadeId = 'rpc-captured-pricing'
    const conversationDir = join(root, '.gemini', 'antigravity-cli', 'conversations')
    const path = join(conversationDir, `${cascadeId}.pb`)
    await (await import('node:fs/promises')).mkdir(conversationDir, { recursive: true })
    writeFileSync(path, new Uint8Array())

    const firstPricing = captureScanPricing()
    hooks.pauseNextRpc = true
    let started!: () => void
    const rpcStarted = new Promise<void>(resolve => {
      started = resolve
    })
    hooks.onReadStarted = started
    const pending = createAntigravityProvider().createSessionParser(source(path), new Set()).parse().next()
    try {
      await rpcStarted
      setPriceOverrides({ [MODEL]: { input: 1000, output: 2000, cacheCreation: 3000, cacheRead: 4000 } })
    } finally {
      hooks.releaseRead?.()
    }

    const result = await pending
    expect(result.done).toBe(false)
    if (result.done) throw new Error('Antigravity RPC parser returned no call')
    expect(result.value.costUSD).toBe(firstPricing.calculateCost(MODEL, 10, 5, 0, 0, 0))

    const nextCascadeId = 'rpc-next-captured-pricing'
    const nextPath = join(conversationDir, `${nextCascadeId}.pb`)
    writeFileSync(nextPath, new Uint8Array())
    const nextPricing = captureScanPricing()
    const nextResult = await createAntigravityProvider().createSessionParser(source(nextPath), new Set()).parse().next()
    expect(nextResult.done).toBe(false)
    if (nextResult.done) throw new Error('Antigravity next RPC parser returned no call')
    expect(nextResult.value.costUSD).toBe(nextPricing.calculateCost(MODEL, 10, 5, 0, 0, 0))
    expect(nextResult.value.costUSD).not.toBe(result.value.costUSD)
  })

  it('uses the scan pricing capability supplied in provider context', async () => {
    const path = writeStatusLine()
    const pricing = captureScanPricing()
    setPriceOverrides({ [MODEL]: { input: 1000, output: 2000, cacheCreation: 3000, cacheRead: 4000 } })
    const calls = await collect(
      createAntigravityProvider().createSessionParser(source(path), new Set(), undefined, { pricing }).parse(),
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.costUSD).toBe(pricing.calculateCost(MODEL, 10, 5, 3, 2, 0))
  })
})
