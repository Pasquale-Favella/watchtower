import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect, Stream } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  pause: undefined as (() => Promise<void>) | undefined,
}))

vi.mock('../src/main/pipeline/fs-utils.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/main/pipeline/fs-utils.js')>()
  return {
    ...actual,
    readSessionFile: async (...args: Parameters<typeof actual.readSessionFile>) => {
      await hooks.pause?.()
      return actual.readSessionFile(...args)
    },
    readSessionFileEffect: (...args: Parameters<typeof actual.readSessionFileEffect>) =>
      Effect.promise(async () => hooks.pause?.()).pipe(Effect.andThen(actual.readSessionFileEffect(...args))),
    readSessionLinesStream: (...args: Parameters<typeof actual.readSessionLinesStream>) =>
      Stream.unwrap(
        Effect.promise(async () => {
          await hooks.pause?.()
          return actual.readSessionLinesStream(...args)
        }),
      ),
  }
})

import { calculateCost, captureScanPricing, setModelAliases, setPriceOverrides } from '../src/main/pipeline/models.js'
import { createOmpProvider, createPiProvider } from '../src/main/pipeline/providers/pi.js'
import { createQwenProvider } from '../src/main/pipeline/providers/qwen.js'
import type {
  ParsedProviderCall,
  Provider,
  SessionParser,
  SessionSource,
} from '../src/main/pipeline/providers/types.js'
import { createZcodeProvider } from '../src/main/pipeline/providers/zcode.js'
import { createZerostackProvider } from '../src/main/pipeline/providers/zerostack.js'
import { deferred } from './helpers/deferred.js'

const model = 'file-provider-captured-alias'
const baseline = 'file-provider-captured-baseline'
const timestamp = '2026-10-05T09:00:00.000Z'
let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-file-pricing-'))
  setModelAliases({ [model]: baseline })
  setPriceOverrides({ [baseline]: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4 } })
})

afterEach(() => {
  hooks.pause = undefined
  setPriceOverrides({})
  setModelAliases({})
  rmSync(root, { recursive: true, force: true })
})

async function collect(parser: SessionParser): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  for await (const call of parser.parse()) calls.push(call)
  return calls
}

function fixture(name: string): { provider: Provider; source: SessionSource; expected: number } {
  const path = join(root, `${name}.jsonl`)
  const source = { path, provider: name, project: 'captured-project' }
  if (name === 'pi' || name === 'omp') {
    writeFileSync(
      path,
      JSON.stringify({
        type: 'message',
        id: 'priced-call',
        timestamp,
        message: {
          role: 'assistant',
          model,
          content: [],
          usage: { input: 100, output: 50, cacheWrite: 30, cacheRead: 20 },
        },
      }),
    )
    return {
      source,
      provider: name === 'pi' ? createPiProvider(root) : createOmpProvider(root),
      expected: calculateCost(model, 100, 50, 30, 20, 0),
    }
  }
  if (name === 'qwen') {
    writeFileSync(
      path,
      JSON.stringify({
        type: 'assistant',
        uuid: 'priced-call',
        sessionId: 'qwen-session',
        timestamp,
        model,
        message: { role: 'assistant', parts: [] },
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          thoughtsTokenCount: 5,
          totalTokenCount: 155,
          cachedContentTokenCount: 20,
        },
      }),
    )
    return { source, provider: createQwenProvider(root), expected: calculateCost(model, 100, 55, 0, 20, 0) }
  }
  writeFileSync(
    path,
    JSON.stringify({
      id: 'zero-session',
      model,
      updated_at: timestamp,
      total_input_tokens: 100,
      total_output_tokens: 50,
      messages: [],
    }),
  )
  return { source, provider: createZerostackProvider(root), expected: calculateCost(model, 100, 50, 0, 0, 0) }
}

describe('file provider captured pricing', () => {
  it.each(['pi', 'omp', 'qwen', 'zerostack'])(
    '%s keeps its creation snapshot across a pending file read',
    async name => {
      const { provider, source, expected } = fixture(name)
      const captured = captureScanPricing()
      const parser = provider.createSessionParser(source, new Set())
      const started = deferred<undefined>()
      const release = deferred<undefined>()
      hooks.pause = () => {
        started.resolve(undefined)
        return release.promise
      }
      const pending = collect(parser)
      try {
        await started.promise
        setPriceOverrides({ [baseline]: { input: 100, output: 200, cacheCreation: 300, cacheRead: 400 } })
      } finally {
        release.resolve(undefined)
      }
      expect((await pending).map(call => call.costUSD)).toEqual([expected])
      hooks.pause = undefined
      const nextCalls = await collect(provider.createSessionParser(source, new Set()))
      expect(nextCalls).toHaveLength(1)
      expect(nextCalls[0]?.costUSD).toBeCloseTo(expected * 100, 12)
      expect(
        (await collect(provider.createSessionParser(source, new Set(), undefined, { pricing: captured }))).map(
          call => call.costUSD,
        ),
      ).toEqual([expected])
    },
  )

  it('ZCode uses the factory snapshot and explicit context while preserving cache splitting and reasoning counters', async () => {
    const path = join(root, 'zcode.sqlite')
    const db = new DatabaseSync(path)
    try {
      db.exec(`
        CREATE TABLE session(id TEXT, directory TEXT);
        CREATE TABLE model_usage(id TEXT, session_id TEXT, turn_id TEXT, model_id TEXT,
          input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
          cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
          started_at INTEGER, completed_at INTEGER);
        CREATE TABLE tool_usage(session_id TEXT, turn_id TEXT, tool_name TEXT, started_at INTEGER);
        INSERT INTO session VALUES ('captured-session', '/workspace');
      `)
      db.prepare('INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'priced-call',
        'captured-session',
        'turn-1',
        model,
        100,
        50,
        5,
        30,
        20,
        Date.parse(timestamp),
        null,
      )
    } finally {
      db.close()
    }
    const provider = createZcodeProvider(path)
    const source = { path: `${path}:captured-session`, provider: 'zcode', project: 'captured-project' }
    const expected = calculateCost(model, 50, 50, 30, 20, 0)
    const pricing = captureScanPricing()
    const parser = provider.createSessionParser(source, new Set())
    setPriceOverrides({ [baseline]: { input: 100, output: 200, cacheCreation: 300, cacheRead: 400 } })
    expect(await collect(parser)).toEqual([
      expect.objectContaining({
        costUSD: expected,
        inputTokens: 50,
        outputTokens: 50,
        reasoningTokens: 5,
        cacheCreationInputTokens: 30,
        cacheReadInputTokens: 20,
      }),
    ])
    expect((await collect(provider.createSessionParser(source, new Set()))).map(call => call.costUSD)).toEqual([
      expected * 100,
    ])
    expect(
      (await collect(provider.createSessionParser(source, new Set(), undefined, { pricing }))).map(
        call => call.costUSD,
      ),
    ).toEqual([expected])
  })
})
