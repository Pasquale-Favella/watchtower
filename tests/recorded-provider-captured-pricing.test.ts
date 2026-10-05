import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { captureScanPricing, setPriceOverrides } from '../src/main/pipeline/models.js'
import { createCodebuffProvider } from '../src/main/pipeline/providers/codebuff.js'
import { createCodeWhaleProvider } from '../src/main/pipeline/providers/codewhale.js'
import { createCrushProvider } from '../src/main/pipeline/providers/crush.js'
import { createHermesProvider } from '../src/main/pipeline/providers/hermes.js'
import { createOpenClawProvider } from '../src/main/pipeline/providers/openclaw.js'
import { quickdesk } from '../src/main/pipeline/providers/quickdesk.js'
import type { ParsedProviderCall } from '../src/main/pipeline/providers/types.js'
import type { Provider, ProviderScanContext, SessionSource } from '../src/main/pipeline/providers/types.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'

const directories: string[] = []

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-captured-pricing-'))
  directories.push(directory)
  return directory
}

function fixedPricing(cost: number): ScanPricing {
  return {
    calculateCost: () => cost,
    calculateLocalModelSavings: () => null,
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

function makeCrushDb(path: string, cost: number): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      cost REAL,
      created_at INTEGER,
      updated_at INTEGER,
      message_count INTEGER,
      parent_session_id TEXT
    )`)
    db.exec('CREATE TABLE messages (session_id TEXT, model TEXT)')
    db.prepare(
      'INSERT INTO sessions (id, prompt_tokens, completion_tokens, cost, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('session-1', 100, 50, cost, 1_700_000_000, 1_700_000_001)
    db.prepare('INSERT INTO messages (session_id, model) VALUES (?, ?)').run('session-1', 'capture-fixture-model')
  } finally {
    db.close()
  }
}

afterEach(() => {
  setPriceOverrides({})
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('provider scan pricing capture', () => {
  it('keeps one Codebuff parser on its captured prices across IO and captures updated prices for a new parser', async () => {
    const directory = tempDirectory()
    const chatDir = join(directory, 'chat')
    mkdirSync(chatDir)
    writeFileSync(
      join(chatDir, 'chat-messages.json'),
      JSON.stringify([
        {
          id: 'message-1',
          variant: 'assistant',
          timestamp: '2026-01-01T00:00:00.000Z',
          metadata: { model: 'capture-fixture-model', usage: { inputTokens: 1_000_000 } },
        },
      ]),
    )
    const provider = createCodebuffProvider(directory)
    const source = { path: chatDir, project: 'fixture', provider: 'codebuff' }

    setPriceOverrides({ 'capture-fixture-model': { input: 1, output: 1 } })
    const pricing = captureScanPricing()
    const capturedParser = provider.createSessionParser(source, new Set())
    setPriceOverrides({ 'capture-fixture-model': { input: 3, output: 3 } })

    const captured = await capturedParser.parse().next()
    const fresh = await firstCall(provider, source)

    expect(captured.value?.costUSD).toBe(1)
    expect(fresh.value?.costUSD).toBe(3)
    expect((await firstCall(provider, source, { pricing })).value?.costUSD).toBe(1)
  })

  it('uses the supplied scan pricing for CodeWhale fallback while preserving unknown-model zero and exact recorded cost', async () => {
    const directory = tempDirectory()
    const path = join(directory, 'session.json')
    const provider = createCodeWhaleProvider(directory)
    const source = { path, project: 'fixture', provider: 'codewhale' }
    writeFileSync(
      path,
      JSON.stringify({
        metadata: {
          id: 'session-a',
          updated_at: '2026-01-01T00:00:00.000Z',
          total_tokens: 1_000_000,
          model: 'unpriced-fixture-model',
        },
        messages: [],
      }),
    )
    const unknown = await firstCall(provider, source)
    expect(unknown.value).toMatchObject({ costUSD: 0, costIsEstimated: true })
    expect((await firstCall(provider, source, { pricing: fixedPricing(99) })).value).toMatchObject({
      costUSD: 99,
      costIsEstimated: true,
    })

    writeFileSync(
      path,
      JSON.stringify({
        metadata: {
          id: 'session-b',
          updated_at: '2026-01-01T00:00:00.000Z',
          total_tokens: 1_000_000,
          model: 'unpriced-fixture-model',
          cost: { session_cost_usd: 2.25 },
        },
        messages: [],
      }),
    )
    const exact = await firstCall(provider, source)
    expect(exact.value).toMatchObject({ costUSD: 2.25, costIsEstimated: false })
  })

  it('keeps QuickDesk recorded zero and Crush positive recorded cost ahead of scan fallback', async () => {
    const directory = tempDirectory()
    const metricsPath = join(directory, 'metrics-2026-01-01.jsonl')
    writeFileSync(
      metricsPath,
      `${JSON.stringify({ Model: 'capture-fixture-model', InputTokens: 100, OutputTokens: 20, CostUSD: 0, _aws: { Timestamp: 1_767_225_600_000 } })}\n`,
    )
    const quickdeskCall = await firstCall(
      quickdesk,
      { path: metricsPath, project: 'fixture', provider: 'quickdesk', sourcePath: directory },
      { pricing: fixedPricing(99) },
    )
    expect(quickdeskCall.value?.costUSD).toBe(0)

    const dbPath = join(directory, 'crush.db')
    makeCrushDb(dbPath, 4.5)
    const crushCall = await firstCall(
      createCrushProvider(),
      { path: `${dbPath}:session-1`, project: 'fixture', provider: 'crush' },
      { pricing: fixedPricing(99) },
    )
    expect(crushCall.value?.costUSD).toBe(4.5)
    const fallbackPath = join(directory, 'crush-fallback.db')
    makeCrushDb(fallbackPath, 0)
    expect(
      (
        await firstCall(
          createCrushProvider(),
          { path: `${fallbackPath}:session-1`, project: 'fixture', provider: 'crush' },
          { pricing: fixedPricing(99) },
        )
      ).value?.costUSD,
    ).toBe(99)
    writeFileSync(
      metricsPath,
      JSON.stringify({
        Model: 'capture-fixture-model',
        InputTokens: 100,
        OutputTokens: 20,
        _aws: { Timestamp: 1_767_225_600_000 },
      }),
    )
    expect(
      (
        await firstCall(
          quickdesk,
          { path: metricsPath, project: 'fixture', provider: 'quickdesk', sourcePath: directory },
          { pricing: fixedPricing(99) },
        )
      ).value?.costUSD,
    ).toBe(99)
  })

  it.each([undefined, 0, -1, 4.5])('OpenClaw uses injected fallback with recorded cost %s', async recorded => {
    const directory = tempDirectory()
    const path = join(directory, 'openclaw.jsonl')
    writeFileSync(
      path,
      JSON.stringify({
        type: 'message',
        id: 'priced-call',
        timestamp: '2026-10-05T09:00:00.000Z',
        message: {
          role: 'assistant',
          model: 'capture-fixture-model',
          content: [],
          usage: {
            input: 100,
            output: 50,
            cacheWrite: 30,
            cacheRead: 20,
            ...(recorded === undefined ? {} : { cost: { total: recorded } }),
          },
        },
      }),
    )
    expect(
      (
        await firstCall(
          createOpenClawProvider(directory),
          { path, project: 'fixture', provider: 'openclaw' },
          { pricing: fixedPricing(99) },
        )
      ).value?.costUSD,
    ).toBe(recorded !== undefined && recorded > 0 ? recorded : 99)
  })

  it.each([
    { actual: null, estimate: null, expected: 99 },
    { actual: 0, estimate: 0, expected: 99 },
    { actual: 0, estimate: 2.5, expected: 2.5 },
    { actual: 4.5, estimate: 2.5, expected: 4.5 },
  ])('Hermes preserves recorded precedence for $actual/$estimate', async ({ actual, estimate, expected }) => {
    const directory = tempDirectory()
    const path = join(directory, 'hermes.db')
    const db = new DatabaseSync(path)
    try {
      db.exec(`CREATE TABLE sessions(id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
        reasoning_tokens INTEGER, actual_cost_usd REAL, estimated_cost_usd REAL);
        CREATE TABLE messages(session_id TEXT, role TEXT, content TEXT, tool_calls TEXT);`)
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'priced-session',
        'capture-fixture-model',
        100,
        50,
        5,
        actual,
        estimate,
      )
    } finally {
      db.close()
    }
    expect(
      (
        await firstCall(
          createHermesProvider(directory),
          { path: `${path}#hermes-session=priced-session`, project: 'fixture', provider: 'hermes' },
          { pricing: fixedPricing(99) },
        )
      ).value?.costUSD,
    ).toBe(expected)
  })
})
