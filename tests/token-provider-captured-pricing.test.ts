import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { setPriceOverrides } from '../src/main/pipeline/models.js'
import { createDroidProvider } from '../src/main/pipeline/providers/droid.js'
import { createForgeProvider } from '../src/main/pipeline/providers/forge.js'
import { createGeminiProvider } from '../src/main/pipeline/providers/gemini.js'
import { createGooseProvider } from '../src/main/pipeline/providers/goose.js'
import { createGrokProvider } from '../src/main/pipeline/providers/grok.js'
import { createKimiProvider } from '../src/main/pipeline/providers/kimi.js'
import { createKimicodeProvider } from '../src/main/pipeline/providers/kimicode.js'
import type {
  ParsedProviderCall,
  Provider,
  ProviderScanContext,
  SessionSource,
} from '../src/main/pipeline/providers/types.js'
import type { ScanCostCalculation, ScanPricing } from '../src/main/pipeline/scan-pricing.js'

const directories: string[] = []

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-token-pricing-'))
  directories.push(directory)
  return directory
}

function makePricing(cost: number): { pricing: ScanPricing; calculations: Parameters<ScanCostCalculation>[] } {
  const calculations: Parameters<ScanCostCalculation>[] = []
  const calculateCost: ScanCostCalculation = (...args) => {
    calculations.push(args)
    return cost
  }
  return {
    pricing: { calculateCost, calculateLocalModelSavings: () => null },
    calculations,
  }
}

async function firstCall(
  provider: Provider,
  source: SessionSource,
  context?: ProviderScanContext,
): Promise<IteratorResult<ParsedProviderCall>> {
  const parser = provider.createSessionParser(source, new Set(), undefined, context).parse()
  const result = await parser.next()
  await parser.return(undefined)
  return result
}

function writeJsonl(path: string, entries: unknown[]): void {
  writeFileSync(path, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`)
}

function createForgeDb(path: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(
      'CREATE TABLE conversations (conversation_id TEXT, title TEXT, workspace_id INTEGER, context TEXT, created_at TEXT, updated_at TEXT)',
    )
    const context = JSON.stringify({
      messages: [
        {
          message: { text: { role: 'assistant', content: 'answer', model: 'fixture-model' } },
          usage: {
            prompt_tokens: { actual: 100 },
            completion_tokens: { actual: 20 },
            cached_tokens: { actual: 10 },
          },
        },
      ],
    })
    db.prepare(
      'INSERT INTO conversations (conversation_id, title, workspace_id, context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('forge-session', 'Fixture', 1, context, '2026-01-01 00:00:00', '2026-01-01 00:00:01')
  } finally {
    db.close()
  }
}

function createGooseDb(path: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(`CREATE TABLE sessions (
      id TEXT, name TEXT, working_dir TEXT, created_at TEXT, updated_at TEXT,
      accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER,
      provider_name TEXT, model_config_json BLOB
    )`)
    db.exec(
      'CREATE TABLE messages (message_id TEXT, session_id TEXT, role TEXT, content_json BLOB, created_timestamp INTEGER)',
    )
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'goose-session',
      'Fixture',
      '/tmp/project',
      '2026-01-01',
      '2026-01-02',
      100,
      25,
      'openai',
      Buffer.from('{"model_name":"fixture-model"}'),
    )
  } finally {
    db.close()
  }
}

afterEach(() => {
  setPriceOverrides({})
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('token provider scan pricing capture', () => {
  it('uses injected scan pricing in all seven provider parsers', async () => {
    const directory = tempDirectory()
    const { pricing, calculations } = makePricing(12.5)
    const context = { pricing }

    const droidPath = join(directory, 'droid.jsonl')
    writeJsonl(droidPath, [
      { type: 'session_start', id: 'droid-session' },
      {
        type: 'message',
        id: 'droid-message',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      },
    ])
    writeFileSync(
      join(directory, 'droid.settings.json'),
      JSON.stringify({ model: 'fixture-model', tokenUsage: { inputTokens: 100, outputTokens: 20, thinkingTokens: 5 } }),
    )
    const droidCall = await firstCall(
      createDroidProvider(directory),
      { path: droidPath, project: 'p', provider: 'droid' },
      context,
    )
    expect(droidCall.value?.costUSD).toBe(12.5)
    expect(calculations.at(-1)).toEqual(['fixture-model', 100, 25, 0, 0, 0])

    const forgePath = join(directory, 'forge.db')
    createForgeDb(forgePath)
    const forgeCall = await firstCall(
      createForgeProvider(forgePath),
      { path: `${forgePath}:forge-session`, project: 'p', provider: 'forge' },
      context,
    )
    expect(forgeCall.value).toMatchObject({ costUSD: 12.5, inputTokens: 90, cacheReadInputTokens: 10 })
    expect(calculations.at(-1)).toEqual(['fixture-model', 90, 20, 0, 10, 0])

    const geminiPath = join(directory, 'gemini.json')
    writeFileSync(
      geminiPath,
      JSON.stringify({
        sessionId: 'gemini-session',
        startTime: '2026-01-01T00:00:00.000Z',
        messages: [
          {
            id: 'gemini-message',
            timestamp: '2026-01-01T00:00:01.000Z',
            type: 'gemini',
            content: 'answer',
            model: 'fixture-model',
            tokens: { input: 100, cached: 10, output: 20, thoughts: 5 },
          },
        ],
      }),
    )
    const geminiCall = await firstCall(
      createGeminiProvider(),
      { path: geminiPath, project: 'p', provider: 'gemini' },
      context,
    )
    expect(geminiCall.value).toMatchObject({ costUSD: 12.5, inputTokens: 90, reasoningTokens: 5 })
    expect(calculations.at(-1)).toEqual(['fixture-model', 90, 25, 0, 10, 0])

    const goosePath = join(directory, 'goose.db')
    createGooseDb(goosePath)
    const gooseCall = await firstCall(
      createGooseProvider(),
      { path: `${goosePath}:goose-session`, project: 'p', provider: 'goose' },
      context,
    )
    expect(gooseCall.value?.costUSD).toBe(12.5)
    expect(calculations.at(-1)).toEqual(['fixture-model', 100, 25, 0, 0, 0])

    const grokDir = join(directory, 'grok')
    mkdirSync(grokDir)
    const grokPath = join(grokDir, 'updates.jsonl')
    writeFileSync(
      join(grokDir, 'summary.json'),
      JSON.stringify({ current_model_id: 'fixture-model', info: { id: 'grok-session' } }),
    )
    writeJsonl(grokPath, [
      { params: { _meta: { totalTokens: 120, promptId: 'turn-1' } } },
      { params: { _meta: { totalTokens: 145, promptId: 'turn-1' } } },
    ])
    const grokCall = await firstCall(
      createGrokProvider(directory),
      { path: grokPath, project: 'p', provider: 'grok' },
      context,
    )
    expect(grokCall.value).toMatchObject({ costUSD: 12.5, inputTokens: 145, outputTokens: 25 })
    expect(calculations.at(-1)).toEqual(['fixture-model', 145, 25, 0, 0, 0])

    const kimicodeDir = join(directory, 'sessions', 'wd_project_123456789abc', 'session_one', 'agents', 'agent-one')
    mkdirSync(kimicodeDir, { recursive: true })
    const kimicodePath = join(kimicodeDir, 'wire.jsonl')
    writeJsonl(kimicodePath, [
      {
        type: 'llm.request',
        model: 'fixture-model',
        modelAlias: 'alias',
        turnStep: 'turn-1',
        time: '2026-01-01T00:00:00.000Z',
      },
      {
        type: 'usage.record',
        model: 'alias',
        time: '2026-01-01T00:00:01.000Z',
        usage: { inputOther: 100, output: 25, inputCacheRead: 10, inputCacheCreation: 5 },
      },
    ])
    const kimicodeCall = await firstCall(
      createKimicodeProvider(directory),
      { path: kimicodePath, project: 'p', provider: 'kimicode', sourceId: 'agent-one' },
      context,
    )
    expect(kimicodeCall.value).toMatchObject({ costUSD: 12.5, inputTokens: 100, cacheCreationInputTokens: 5 })
    expect(calculations.at(-1)).toEqual(['fixture-model', 100, 25, 5, 10, 0])

    const kimiDir = join(directory, 'kimi')
    mkdirSync(kimiDir)
    const kimiPath = join(kimiDir, 'wire.jsonl')
    writeJsonl(kimiPath, [
      {
        type: 'StatusUpdate',
        timestamp: '2026-01-01T00:00:01.000Z',
        payload: {
          model: 'fixture-model',
          token_usage: { input_other: 100, output: 25, input_cache_read: 10, input_cache_creation: 5 },
        },
      },
    ])
    const kimiCall = await firstCall(
      createKimiProvider(kimiDir),
      { path: kimiPath, project: 'p', provider: 'kimi' },
      context,
    )
    expect(kimiCall.value).toMatchObject({ costUSD: 12.5, inputTokens: 100, cacheCreationInputTokens: 5 })
    expect(calculations.at(-1)).toEqual(['fixture-model', 100, 25, 5, 10, 0])
    expect(calculations).toHaveLength(7)
  })

  it('captures Gemini prices before file IO and uses fresh pricing for a new parser', async () => {
    const directory = tempDirectory()
    const sessionPath = join(directory, 'session.json')
    writeFileSync(
      sessionPath,
      JSON.stringify({
        sessionId: 'captured-session',
        startTime: '2026-01-01T00:00:00.000Z',
        messages: [
          {
            id: 'message-one',
            timestamp: '2026-01-01T00:00:01.000Z',
            type: 'gemini',
            content: 'answer',
            model: 'capture-pricing-fixture',
            tokens: { input: 100_000 },
          },
        ],
      }),
    )
    const provider = createGeminiProvider()
    const source = { path: sessionPath, project: 'p', provider: 'gemini' }

    setPriceOverrides({ 'capture-pricing-fixture': { input: 1, output: 1 } })
    const capturedParser = provider.createSessionParser(source, new Set())
    setPriceOverrides({ 'capture-pricing-fixture': { input: 4, output: 4 } })

    const captured = await capturedParser.parse().next()
    const fresh = await firstCall(provider, source)

    expect(captured.value?.costUSD).toBeCloseTo(0.1)
    expect(fresh.value?.costUSD).toBeCloseTo(0.4)
  })
})
