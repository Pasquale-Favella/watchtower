import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import { buildCsvExportFilesFromRows, buildJsonExportFromRows } from '../src/main/export-calculation.js'
import { buildExportRows, calculateExportData } from '../src/main/export-rows-calculation.js'
import { capturePricingCatalogue, type PricingCatalogue } from '../src/main/pipeline/pricing-calculation.js'
import type { LedgerExportData } from '../src/main/store/export-read-projections.js'
import { LedgerExportReads } from '../src/main/store/ledger-export-reads.js'
import { LedgerIngest } from '../src/main/store/ledger-ports.js'
import type { ActiveCurrency } from '../src/shared/schemas/fx.js'
import {
  buildFixtureCachedCall,
  buildFixtureCachedFile,
  buildFixtureCachedTurn,
  FIXTURE_SOURCE_PATH,
} from './fixtures/cached-file.js'
import { openLedgerFixture } from './fixtures/ledger-runtime.js'
import { PRE_RETIREMENT_EXPORT_EXPECTATIONS } from './fixtures/pre-retirement-export-expectations.js'

const USD: ActiveCurrency = { code: 'USD', symbol: '$', rate: 1 }
const JPY: ActiveCurrency = { code: 'JPY', symbol: '¥', rate: 150 }
const GENERATED = '2026-10-07T12:00:00.000Z'

function catalogue(): PricingCatalogue {
  return capturePricingCatalogue({
    prices: new Map([
      [
        'gpt-5',
        {
          inputCostPerToken: 0.01,
          outputCostPerToken: 0,
          cacheWriteCostPerToken: 0,
          cacheReadCostPerToken: 0,
          webSearchCostPerRequest: 0,
          fastMultiplier: 1,
        },
      ],
    ]),
    overrides: new Map(),
    builtinAliases: {},
    userAliases: {},
    tiers: [],
    routedSegments: new Set(),
  })
}

function emptyData(): LedgerExportData {
  return { sessions: [], turns: [], calls: [], aliases: [], overrides: [] }
}

function session(
  sourceId: number,
  sessionId: string,
  projectPath: string,
  provider = 'codex',
  repoUrl: string | null = null,
): LedgerExportData['sessions'][number] {
  return {
    sourceId,
    sessionId,
    project: projectPath.split(/[\\/]/).at(-1) ?? projectPath,
    projectPath,
    workingDirectory: projectPath,
    canonicalProject: null,
    canonicalCwd: projectPath,
    sourceProvider: provider,
    repoUrl,
  }
}

function turn(
  sourceId: number,
  sessionId: string,
  turnIndex: number,
  timestamp: string,
  category = 'coding',
): LedgerExportData['turns'][number] {
  return { sourceId, sessionId, turnIndex, timestamp, category }
}

function call(input: {
  sourceId: number
  sessionId: string
  turnIndex: number
  callIndex: number
  model?: string
  provider?: string
  timestamp?: string
  baseCostUSD?: number
  savingsUSD?: number
  tools?: string[]
  mcpTools?: string[]
  bashCommands?: string[]
}): LedgerExportData['calls'][number] {
  return {
    sourceId: input.sourceId,
    sessionId: input.sessionId,
    turnIndex: input.turnIndex,
    callIndex: input.callIndex,
    provider: input.provider ?? 'codex',
    model: input.model ?? 'gpt-5',
    timestamp: input.timestamp ?? '2026-01-01T00:00:00.000Z',
    speed: 'standard',
    baseCostUSD: input.baseCostUSD ?? 0,
    savingsUSD: input.savingsUSD ?? 0,
    inputTokens: 1,
    outputTokens: 0,
    cacheCreationInputTokens: 2,
    cacheReadInputTokens: 3,
    cachedInputTokens: 5,
    webSearchRequests: 0,
    reasoningTokens: 0,
    tools: input.tools ?? [],
    mcpTools: input.mcpTools ?? [],
    bashCommands: input.bashCommands ?? [],
  }
}

describe('direct export table calculation', () => {
  it('preserves turn discovery order for duplicate public IDs with different first turn indexes', () => {
    const input = emptyData()
    input.sessions.push(session(1, 'same-id', '/work/first'), session(2, 'same-id', '/work/second'))
    input.turns.push(
      turn(2, 'same-id', 0, '2026-01-01T00:00:00.000Z'),
      turn(1, 'same-id', 4, '2026-01-01T00:00:00.000Z'),
    )
    input.calls.push(
      call({ sourceId: 2, sessionId: 'same-id', turnIndex: 0, callIndex: 0, baseCostUSD: 1 }),
      call({ sourceId: 1, sessionId: 'same-id', turnIndex: 4, callIndex: 0, baseCostUSD: 1 }),
    )

    const calculated = calculateExportData(input, catalogue())
    const rows = buildExportRows(calculated.data, USD)
    expect(rows.records.map(row => row.project)).toEqual(['/work/second', '/work/first'])
    expect(rows.projects.map(row => row.Project)).toEqual(['/work/second', '/work/first'])
    expect(rows.sessions.map(row => row.Project)).toEqual(['/work/second', '/work/first'])
    expect(rows.daily[0]?.Sessions).toBe(1)
  })

  it('keeps duplicate-ID tie order when the first discovered turn has no admitted calls', () => {
    const input = emptyData()
    input.sessions.push(session(1, 'same-id', '/work/first'), session(2, 'same-id', '/work/second'))
    input.turns.push(
      turn(1, 'same-id', 0, '2026-01-01T00:00:00.000Z'),
      turn(2, 'same-id', 1, '2026-01-01T00:00:00.000Z'),
      turn(1, 'same-id', 2, '2026-01-01T00:00:00.000Z'),
    )
    input.calls.push(
      call({ sourceId: 1, sessionId: 'same-id', turnIndex: 0, callIndex: 0, timestamp: 'invalid' }),
      call({ sourceId: 2, sessionId: 'same-id', turnIndex: 1, callIndex: 0, baseCostUSD: 1 }),
      call({ sourceId: 1, sessionId: 'same-id', turnIndex: 2, callIndex: 0, baseCostUSD: 1 }),
    )

    const calculated = calculateExportData(input, catalogue())
    const rows = buildExportRows(calculated.data, USD)
    expect(rows.records.map(row => row.project)).toEqual(['/work/first', '/work/second'])
    expect(rows.projects.map(row => row.Project)).toEqual(['/work/first', '/work/second'])
    expect(rows.sessions.map(row => row.Project)).toEqual(['/work/first', '/work/second'])
    expect(rows.daily[0]?.Sessions).toBe(1)
  })

  it.each([USD, JPY])('sorts session ties after $code conversion and rounding', currency => {
    const input = emptyData()
    input.sessions.push(session(1, 'a-low', '/work/project'), session(1, 'z-high', '/work/project'))
    input.turns.push(turn(1, 'a-low', 0, '2026-01-01T00:00:00.000Z'), turn(1, 'z-high', 0, '2026-01-01T00:00:00.000Z'))
    input.calls.push(
      call({ sourceId: 1, sessionId: 'a-low', turnIndex: 0, callIndex: 0, baseCostUSD: 0.0034 }),
      call({ sourceId: 1, sessionId: 'z-high', turnIndex: 0, callIndex: 0, baseCostUSD: 0.004 }),
    )

    const calculated = calculateExportData(input, catalogue())
    const rows = buildExportRows(calculated.data, currency)
    expect(rows.sessions.map(row => row['Session ID'])).toEqual(['a-low', 'z-high'])
    expect(rows.sessions.map(row => row[`Cost (${currency.code})`])).toEqual(currency.code === 'JPY' ? [1, 1] : [0, 0])
  })

  it('sorts the complete turn list before excluding invalid first calls', () => {
    const input = emptyData()
    input.sessions.push(session(1, 'mixed', '/work/project'))
    input.turns.push(
      turn(1, 'mixed', 0, '2026-02-01T00:00:00.000Z'),
      turn(1, 'mixed', 1, '2026-04-01T00:00:00.000Z'),
      turn(1, 'mixed', 2, '2026-05-01T00:00:00.000Z'),
    )
    input.calls.push(
      call({ sourceId: 1, sessionId: 'mixed', turnIndex: 0, callIndex: 0, timestamp: '2026-03-01T00:00:00.000Z' }),
      call({ sourceId: 1, sessionId: 'mixed', turnIndex: 1, callIndex: 0, timestamp: 'invalid' }),
      call({ sourceId: 1, sessionId: 'mixed', turnIndex: 2, callIndex: 0, timestamp: '2026-01-01T00:00:00.000Z' }),
    )

    const calculated = calculateExportData(input, catalogue())
    const rows = buildExportRows(calculated.data, USD)
    expect(rows.records.map(row => row.timestamp)).toEqual(['2026-03-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'])
  })

  it('preserves numeric category and tool enumeration for equal totals', () => {
    const input = emptyData()
    input.sessions.push(session(1, 'ordered', '/work/project'))
    for (const [index, name] of ['10', 'alpha', '2'].entries()) {
      input.turns.push(turn(1, 'ordered', index, '2026-01-01T00:00:00.000Z', name))
      input.calls.push(
        call({ sourceId: 1, sessionId: 'ordered', turnIndex: index, callIndex: 0, baseCostUSD: 1, tools: [name] }),
      )
    }

    const calculated = calculateExportData(input, catalogue())
    const rows = buildExportRows(calculated.data, USD)
    expect(rows.activity.map(row => row.Activity)).toEqual(['2', '10', 'alpha'])
    expect(rows.tools.map(row => row.Tool)).toEqual(['2', '10', 'alpha'])
  })

  it('prices before admission, groups direct facts, and preserves export table semantics', () => {
    const input = emptyData()
    input.sessions.push(
      session(1, 'same-id', '/work/alpha', 'codex', 'https://example.test/alpha.git'),
      session(2, 'same-id', '/work/beta', 'devin', 'https://example.test/beta.git'),
    )
    input.aliases.push({ model: 'raw-model', aliasOf: 'gpt-5' }, { model: 'unpriced-raw', aliasOf: 'unknown-target' })
    input.turns.push(
      turn(1, 'same-id', 0, '2026-01-01T23:59:00.000Z'),
      turn(1, 'same-id', 1, '2026-01-02T08:00:00.000Z'),
      turn(2, 'same-id', 0, '2026-01-02T08:00:00.000Z'),
    )
    input.calls.push(
      // The first call timestamp controls admission; a later valid call cannot rescue this turn.
      call({ sourceId: 1, sessionId: 'same-id', turnIndex: 0, callIndex: 0, timestamp: 'invalid', model: 'gpt-5' }),
      call({ sourceId: 1, sessionId: 'same-id', turnIndex: 0, callIndex: 1, timestamp: '2026-01-01T23:59:30.000Z' }),
      // Accepted turns retain later calls with invalid individual timestamps.
      call({
        sourceId: 1,
        sessionId: 'same-id',
        turnIndex: 1,
        callIndex: 1,
        model: 'raw-model',
        timestamp: 'invalid',
        baseCostUSD: 99,
        savingsUSD: -4,
        tools: ['bash', 'bash', 'mcp__ignored__tool'],
        mcpTools: ['mcp__server__tool', 'mcp__server__tool'],
        bashCommands: ['ls', 'ls'],
      }),
      call({
        sourceId: 1,
        sessionId: 'same-id',
        turnIndex: 1,
        callIndex: 0,
        model: 'gpt-5',
        timestamp: '2026-01-02T08:00:01.000Z',
        baseCostUSD: 2,
        savingsUSD: 0.5,
        tools: ['bash'],
      }),
      call({
        sourceId: 2,
        sessionId: 'same-id',
        turnIndex: 0,
        callIndex: 0,
        provider: 'devin',
        model: 'claude-sonnet-4',
        baseCostUSD: 1,
      }),
      // An orphan call is excluded from rows but still contributes the unresolved alias diagnostic.
      call({
        sourceId: 9,
        sessionId: 'orphan',
        turnIndex: 0,
        callIndex: 0,
        model: 'unpriced-raw',
        baseCostUSD: 0,
      }),
    )

    const calculation = calculateExportData(input, catalogue())
    expect(calculation.sessionCount).toBe(2)
    expect(calculation.unpricedModels).toEqual(['unknown-target'])
    const rows = buildExportRows(calculation.data, USD)
    expect(rows.records).toEqual([
      {
        project: '/work/alpha',
        repoUrl: 'https://example.test/alpha.git',
        sessionId: 'same-id',
        timestamp: '2026-01-02T08:00:01.000Z',
        category: 'coding',
        provider: 'codex',
        model: 'gpt-5',
        inputTokens: 1,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheWriteTokens: 2,
        cacheReadTokens: 5,
        cost: 2,
        savings: 0.5,
      },
      {
        project: '/work/alpha',
        repoUrl: 'https://example.test/alpha.git',
        sessionId: 'same-id',
        timestamp: 'invalid',
        category: 'coding',
        provider: 'codex',
        model: 'gpt-5',
        inputTokens: 1,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheWriteTokens: 2,
        cacheReadTokens: 5,
        cost: 0.01,
        savings: 0,
      },
      {
        project: '/work/beta',
        repoUrl: 'https://example.test/beta.git',
        sessionId: 'same-id',
        timestamp: '2026-01-01T00:00:00.000Z',
        category: 'coding',
        provider: 'devin',
        model: 'claude-sonnet-4',
        inputTokens: 1,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheWriteTokens: 2,
        cacheReadTokens: 5,
        cost: 1,
        savings: 0,
      },
    ])
    expect(rows.models.map(row => row.Model)).toEqual(['GPT-5', 'claude-sonnet-4'])
    expect(rows.tools).toEqual([{ Tool: 'bash', Calls: 3, 'Share (%)': 100 }])
    expect(rows.mcp).toEqual([{ Server: 'server', Calls: 2, 'Share (%)': 100 }])
    expect(rows.shellCommands).toEqual([{ Command: 'ls', Calls: 2, 'Share (%)': 100 }])
    expect(rows.daily.map(row => row.Date)).toEqual(['2026-01-02'])
    expect(rows.daily[0]?.Sessions).toBe(1) // Daily intentionally counts distinct public IDs.
  })

  it('converts only after currency-free calculation and serializes all nine tables', () => {
    const input = emptyData()
    input.sessions.push(session(1, 'one', '/work/project'))
    input.turns.push(turn(1, 'one', 0, '2026-01-01T00:00:00.000Z'))
    input.calls.push(call({ sourceId: 1, sessionId: 'one', turnIndex: 0, callIndex: 0, baseCostUSD: 2.75 }))

    const calculation = calculateExportData(input, catalogue())
    const rows = buildExportRows(calculation.data, JPY)
    expect(rows.records[0]?.cost).toBe(413)
    expect(rows.sessions[0]?.['Cost (JPY)']).toBe(413)
    expect(buildCsvExportFilesFromRows(rows, JPY, GENERATED).map(file => file.name)).toEqual([
      'README.txt',
      'daily.csv',
      'activity.csv',
      'models.csv',
      'records.csv',
      'projects.csv',
      'sessions.csv',
      'tools.csv',
      'mcp.csv',
      'shell-commands.csv',
    ])
    expect(JSON.parse(buildJsonExportFromRows(rows, JPY, GENERATED))).toMatchObject({
      schema: 'watchtower.export.v1',
      generated: GENERATED,
      currency: { code: 'JPY', symbol: '¥', rate: 150 },
    })
  })

  it('keeps synthetic model cost in the share denominator while hiding its row', () => {
    const input = emptyData()
    input.sessions.push(session(1, 'real', '/work/project'), session(1, 'synthetic', '/work/project'))
    input.turns.push(
      turn(1, 'real', 0, '2026-01-01T00:00:00.000Z'),
      turn(1, 'synthetic', 0, '2026-01-02T00:00:00.000Z'),
    )
    input.calls.push(
      call({ sourceId: 1, sessionId: 'real', turnIndex: 0, callIndex: 0, baseCostUSD: 1, model: 'gpt-5' }),
      call({
        sourceId: 1,
        sessionId: 'synthetic',
        turnIndex: 0,
        callIndex: 0,
        baseCostUSD: 3,
        model: '<synthetic>',
      }),
    )

    const calculation = calculateExportData(input, catalogue())
    const rows = buildExportRows(calculation.data, USD)
    expect(rows.models).toEqual([
      {
        Model: 'GPT-5',
        'Cost (USD)': 1,
        'Saved (USD)': 0,
        'Share (%)': 25,
        'API Calls': 1,
        'Input Tokens': 1,
        'Output Tokens': 0,
        'Cache Read Tokens': 3,
        'Cache Write Tokens': 2,
      },
    ])
  })

  it('returns empty tables while preserving the zero-session guard value', () => {
    const calculation = calculateExportData(emptyData(), catalogue())
    expect(calculation.sessionCount).toBe(0)
    expect(buildExportRows(calculation.data, USD)).toEqual({
      daily: [],
      activity: [],
      models: [],
      projects: [],
      sessions: [],
      records: [],
      tools: [],
      mcp: [],
      shellCommands: [],
    })
  })

  it.each([
    { name: 'baseline', cachedFile: buildFixtureCachedFile() },
    {
      name: 'mixed valid and invalid first calls',
      cachedFile: buildFixtureCachedFile({
        turns: [
          buildFixtureCachedTurn(0, 'first', {
            timestamp: '2026-02-01T00:00:00.000Z',
            calls: [{ ...buildFixtureCachedCall(0), timestamp: '2026-03-01T00:00:00.000Z' }],
          }),
          buildFixtureCachedTurn(1, 'excluded', {
            timestamp: '2026-04-01T00:00:00.000Z',
            calls: [{ ...buildFixtureCachedCall(1), timestamp: 'invalid' }],
          }),
          buildFixtureCachedTurn(2, 'last', {
            timestamp: '2026-05-01T00:00:00.000Z',
            calls: [{ ...buildFixtureCachedCall(2), timestamp: '2026-01-01T00:00:00.000Z' }],
          }),
        ],
      }),
    },
  ] as const)('matches pinned pre-retirement bytes on native $name facts', ({ name, cachedFile }) => {
    const { runtime } = openLedgerFixture()
    runtime.runSync(
      Effect.flatMap(LedgerIngest, ingest =>
        ingest.portIn({
          provider: 'opencode',
          envFingerprint: 'export-calculation-parity',
          filePath: `${FIXTURE_SOURCE_PATH}-export-calculation-parity`,
          verdict: 'new',
          cachedFile,
        }),
      ),
    )
    const exportData = runtime.runSync(Effect.flatMap(LedgerExportReads, exports => exports.getExportData()))
    const direct = calculateExportData(exportData, catalogue())
    expect(direct.unpricedModels).toEqual([])
    const pinned = PRE_RETIREMENT_EXPORT_EXPECTATIONS[name]
    for (const currency of [USD, JPY]) {
      const rows = buildExportRows(direct.data, currency)
      const expected = currency.code === 'USD' ? pinned.USD : pinned.JPY
      expect(buildCsvExportFilesFromRows(rows, currency, GENERATED).map(file => file.contents)).toEqual(expected.csv)
      expect(buildJsonExportFromRows(rows, currency, GENERATED)).toBe(expected.json)
    }
  })
})
