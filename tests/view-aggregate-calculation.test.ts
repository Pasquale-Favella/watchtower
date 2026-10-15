import { DatabaseSync } from 'node:sqlite'

import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import { captureModelPricingCatalogue, captureProxyPaths } from '../src/main/pipeline/models.js'
import { capturePricingCatalogue, type PricingCatalogue } from '../src/main/pipeline/pricing-calculation.js'
import { LedgerConfig, LedgerIngest, LedgerQueries } from '../src/main/store/ledger-ports.js'
import { makeLedgerQuerySnapshot } from '../src/main/store/ledger-query-snapshot.js'
import { LedgerViewReads } from '../src/main/store/ledger-view-reads.js'
import type { LedgerViewData } from '../src/main/store/view-read-projections.js'
import { calculateAnalyticalViews, calculateDashboardViews } from '../src/main/view-aggregate-calculation.js'
import {
  buildAnalyticalViewsFromSnapshotResult,
  buildDashboardViewsFromSnapshotResult,
} from '../src/main/views-calculation.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'
import { openLedgerFixture } from './fixtures/ledger-runtime.js'

const emptyCatalogue = (): PricingCatalogue =>
  capturePricingCatalogue({
    prices: new Map(),
    overrides: new Map(),
    builtinAliases: {},
    userAliases: {},
    tiers: [],
    routedSegments: new Set(),
  })

function emptyViewData(): LedgerViewData {
  return { sessions: [], turns: [], calls: [], aliases: [], overrides: [] }
}

function session(
  sourceId: number,
  sessionId: string,
  project: string,
  sourceProvider: string,
  projectPath: string,
): LedgerViewData['sessions'][number] {
  return {
    sourceId,
    sessionId,
    project,
    projectPath,
    workingDirectory: projectPath,
    canonicalProject: project,
    canonicalCwd: projectPath,
    sourceProvider,
  }
}

function call(
  input: Partial<LedgerViewData['calls'][number]> &
    Pick<
      LedgerViewData['calls'][number],
      'sourceId' | 'sessionId' | 'turnIndex' | 'callIndex' | 'provider' | 'model' | 'timestamp'
    >,
): LedgerViewData['calls'][number] {
  return {
    sourceId: input.sourceId,
    sessionId: input.sessionId,
    turnIndex: input.turnIndex,
    callIndex: input.callIndex,
    provider: input.provider,
    model: input.model,
    timestamp: input.timestamp,
    speed: input.speed ?? 'standard',
    baseCostUSD: input.baseCostUSD ?? 0,
    savingsUSD: input.savingsUSD ?? 0,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    cacheCreationInputTokens: input.cacheCreationInputTokens ?? 0,
    cacheReadInputTokens: input.cacheReadInputTokens ?? 0,
    cachedInputTokens: input.cachedInputTokens ?? 0,
    webSearchRequests: input.webSearchRequests ?? 0,
    isEstimated: input.isEstimated ?? 0,
    reasoningTokens: input.reasoningTokens ?? 0,
    subagentTypes: input.subagentTypes ?? [],
  }
}

function collisionData(): LedgerViewData {
  const data = emptyViewData()
  data.sessions.push(
    session(1, 'same-public-id', 'one', 'codex', '/proxy/one'),
    session(2, 'same-public-id', 'two', 'claude', '/public/two'),
  )
  // Both source-1 turns and their first calls tie on their timestamps. Stable
  // fact order selects the first turn's provider for session-level inference.
  data.turns.push(
    {
      sourceId: 1,
      sessionId: 'same-public-id',
      turnIndex: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
      category: 'feature',
      subCategory: 'auth',
    },
    {
      sourceId: 1,
      sessionId: 'same-public-id',
      turnIndex: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      category: 'feature',
      subCategory: 'auth',
    },
    {
      sourceId: 1,
      sessionId: 'same-public-id',
      turnIndex: 2,
      timestamp: 'fallback',
      category: 'testing',
      subCategory: null,
    },
    {
      sourceId: 2,
      sessionId: 'same-public-id',
      turnIndex: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
      category: 'general',
      subCategory: null,
    },
  )
  data.calls.push(
    call({
      sourceId: 1,
      sessionId: 'same-public-id',
      turnIndex: 0,
      callIndex: 0,
      provider: 'codex',
      model: 'mystery-model',
      timestamp: '2026-01-01T00:00:01.000Z',
      inputTokens: 1_000_000,
      outputTokens: 2_000_000,
      cacheCreationInputTokens: 4,
      cacheReadInputTokens: 2,
      cachedInputTokens: 3,
      reasoningTokens: 5,
      savingsUSD: 1.5,
      isEstimated: 1,
      subagentTypes: ['explore', 'explore'],
    }),
    call({
      sourceId: 1,
      sessionId: 'same-public-id',
      turnIndex: 0,
      callIndex: 1,
      provider: 'claude',
      model: 'claude-sonnet-4',
      timestamp: '2026-01-01T00:00:01.000Z',
      baseCostUSD: 2,
    }),
    call({
      sourceId: 1,
      sessionId: 'same-public-id',
      turnIndex: 1,
      callIndex: 0,
      provider: 'gemini',
      model: 'gpt-5.4',
      timestamp: '2026-01-01T00:00:01.000Z',
      inputTokens: 1_500_000,
    }),
    call({
      sourceId: 1,
      sessionId: 'same-public-id',
      turnIndex: 2,
      callIndex: 0,
      provider: 'codex',
      model: 'lost-raw-model',
      timestamp: 'not-a-date',
    }),
    call({
      sourceId: 2,
      sessionId: 'same-public-id',
      turnIndex: 0,
      callIndex: 0,
      provider: 'claude',
      model: 'claude-sonnet-4',
      timestamp: '2026-01-01T00:00:03.000Z',
      baseCostUSD: 4,
    }),
    call({
      sourceId: 3,
      sessionId: 'orphan-call',
      turnIndex: 0,
      callIndex: 0,
      provider: 'codex',
      model: 'orphan-raw-model',
      timestamp: '2026-01-01T00:00:04.000Z',
    }),
  )
  data.aliases.push(
    { model: 'mystery-model', aliasOf: 'gpt-5.4' },
    { model: 'lost-raw-model', aliasOf: 'missing-target' },
    { model: 'orphan-raw-model', aliasOf: 'missing-target' },
  )
  data.overrides.push({ model: 'gpt-5.4', inputPricePerMillion: 2, outputPricePerMillion: 3 })
  return data
}

describe('view aggregate calculations', () => {
  it('matches the snapshot builders on a non-collision ledger fixture', () => {
    const { runtime } = openLedgerFixture()
    const opencodeCall0 = buildFixtureCachedCall(0)
    const opencodeCall1 = buildFixtureCachedCall(1)
    const codexCall = buildFixtureCachedCall(2)
    runtime.runSync(
      Effect.gen(function* () {
        const ingest = yield* LedgerIngest
        const config = yield* LedgerConfig
        yield* config.setModelAlias('parity-raw-model', 'claude-sonnet-4')
        yield* config.setPriceOverride('claude-sonnet-4', {
          inputPricePerMillion: 1.25,
          outputPricePerMillion: 2.5,
        })
        yield* ingest.portIn({
          provider: 'opencode',
          envFingerprint: 'view-aggregate-parity',
          filePath: '/cache/opencode/view-aggregate-parity.jsonl',
          verdict: 'new',
          cachedFile: buildFixtureCachedFile({
            canonicalCwd: '/workspace/parity-project',
            canonicalProjectName: 'parity-project',
            turns: [
              buildFixtureCachedTurn(0, 'implement the feature', {
                sessionId: 'parity-opencode',
                timestamp: '2026-01-01T09:00:00.000Z',
                calls: [
                  {
                    ...opencodeCall0,
                    model: 'parity-raw-model',
                    costUSD: 0.125,
                    timestamp: '2026-01-01T09:00:01.000Z',
                    usage: { ...opencodeCall0.usage, inputTokens: 100_000, outputTokens: 200_000 },
                  },
                ],
              }),
              buildFixtureCachedTurn(1, 'test the feature', {
                sessionId: 'parity-opencode',
                timestamp: '2026-02-01T09:00:00.000Z',
                calls: [
                  {
                    ...opencodeCall1,
                    model: 'parity-raw-model',
                    costUSD: 0.25,
                    timestamp: '2026-02-01T09:00:01.000Z',
                    usage: { ...opencodeCall1.usage, inputTokens: 300_000, outputTokens: 100_000 },
                  },
                ],
              }),
            ],
          }),
        })
        yield* ingest.portIn({
          provider: 'codex',
          envFingerprint: 'view-aggregate-parity',
          filePath: '/cache/codex/view-aggregate-parity.jsonl',
          verdict: 'new',
          cachedFile: buildFixtureCachedFile({
            canonicalCwd: '/workspace/other-project',
            canonicalProjectName: 'other-project',
            turns: [
              buildFixtureCachedTurn(0, 'inspect the repository', {
                sessionId: 'parity-codex',
                timestamp: '2026-03-01T09:00:00.000Z',
                calls: [
                  {
                    ...codexCall,
                    provider: 'codex',
                    model: 'gpt-5.4',
                    costUSD: 0.375,
                    timestamp: '2026-03-01T09:00:01.000Z',
                  },
                ],
              }),
            ],
          }),
        })
      }),
    )
    const { requestData, viewData } = runtime.runSync(
      Effect.gen(function* () {
        const queries = yield* LedgerQueries
        const viewReads = yield* LedgerViewReads
        return {
          requestData: yield* queries.getRequestSnapshotData(),
          viewData: yield* viewReads.getViewData(),
        }
      }),
    )
    const inputs = { catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() }
    const snapshot = makeLedgerQuerySnapshot({ ...requestData, ...inputs })

    expect(calculateDashboardViews(viewData, inputs)).toEqual(buildDashboardViewsFromSnapshotResult(snapshot))
    expect(calculateAnalyticalViews(viewData, inputs)).toEqual(buildAnalyticalViewsFromSnapshotResult(snapshot))
  })

  it('preserves numeric category, skill and subagent ordering when costs tie', () => {
    const { runtime, dbPath } = openLedgerFixture()
    const names = ['10', 'alpha', '2']
    runtime.runSync(
      Effect.flatMap(LedgerIngest, ingest =>
        ingest.portIn({
          provider: 'opencode',
          envFingerprint: 'view-numeric-names',
          filePath: '/cache/opencode/view-numeric-names.jsonl',
          verdict: 'new',
          cachedFile: buildFixtureCachedFile({
            turns: names.map((name, index) =>
              buildFixtureCachedTurn(index, name, {
                calls: [{ ...buildFixtureCachedCall(index), costUSD: 1, subagentTypes: [name] }],
              }),
            ),
          }),
        }),
      ),
    )
    const writer = new DatabaseSync(dbPath)
    try {
      const update = writer.prepare('UPDATE ledger_turn SET category = ?, sub_category = ? WHERE turn_index = ?')
      names.forEach((name, index) => update.run(name, name, index))
    } finally {
      writer.close()
    }
    const { requestData, viewData } = runtime.runSync(
      Effect.gen(function* () {
        const queries = yield* LedgerQueries
        const reads = yield* LedgerViewReads
        return { requestData: yield* queries.getRequestSnapshotData(), viewData: yield* reads.getViewData() }
      }),
    )
    const inputs = { catalogue: emptyCatalogue(), proxyPaths: { paths: [], caseSensitive: false } }
    const snapshot = makeLedgerQuerySnapshot({ ...requestData, ...inputs })
    const dashboard = calculateDashboardViews(viewData, inputs)
    const analytical = calculateAnalyticalViews(viewData, inputs)
    expect(dashboard).toEqual(buildDashboardViewsFromSnapshotResult(snapshot))
    expect(analytical).toEqual(buildAnalyticalViewsFromSnapshotResult(snapshot))
    expect(dashboard.value.byCategory.map(entry => entry.name)).toEqual(['2', '10', 'alpha'])
    expect(analytical.value.skills.map(entry => entry.name)).toEqual(['2', '10', 'alpha'])
    expect(analytical.value.subagents.map(entry => entry.name)).toEqual(['2', '10', 'alpha'])
  })

  it('returns empty payloads for empty facts', () => {
    const inputs = { catalogue: emptyCatalogue(), proxyPaths: { paths: [], caseSensitive: false } }
    expect(calculateDashboardViews(emptyViewData(), inputs)).toEqual({
      value: {
        kpis: {
          totalCost: 0,
          totalEstimatedCost: 0,
          totalSavings: 0,
          totalProxiedCost: 0,
          totalCalls: 0,
          totalSessions: 0,
          totalProjects: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          totalReasoningTokens: 0,
        },
        costOverTime: [],
        byProvider: [],
        byModel: [],
        byProject: [],
        byCategory: [],
      },
      unpricedModels: [],
    })
    expect(calculateAnalyticalViews(emptyViewData(), inputs)).toEqual({
      value: { providers: [], models: [], categories: [], skills: [], subagents: [] },
      unpricedModels: [],
    })
  })

  it('keeps valid zero-cost calls and ignores nonpositive savings', () => {
    const data = emptyViewData()
    data.sessions.push(session(1, 'free-session', 'local', 'opencode', '/work/local'))
    data.turns.push({
      sourceId: 1,
      sessionId: 'free-session',
      turnIndex: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
      category: 'conversation',
      subCategory: null,
    })
    data.calls.push(
      call({
        sourceId: 1,
        sessionId: 'free-session',
        turnIndex: 0,
        callIndex: 0,
        provider: 'opencode',
        model: 'local-model:latest',
        timestamp: '2026-01-01T00:00:01.000Z',
        savingsUSD: -3,
      }),
    )
    const result = calculateDashboardViews(data, {
      catalogue: emptyCatalogue(),
      proxyPaths: { paths: [], caseSensitive: false },
    })
    expect(result.unpricedModels).toEqual([])
    expect(result.value.kpis.totalCost).toBe(0)
    expect(result.value.kpis.totalSavings).toBe(0)
    expect(result.value.byModel).toEqual([{ name: 'local-model:latest', cost: 0, calls: 1 }])
  })

  it('prices aliases with the larger cached/read token count but reports raw cache-read totals', () => {
    const data = emptyViewData()
    data.sessions.push(session(1, 'cache-session', 'cache', 'codex', '/work/cache'))
    data.turns.push({
      sourceId: 1,
      sessionId: 'cache-session',
      turnIndex: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
      category: 'coding',
      subCategory: null,
    })
    data.calls.push(
      call({
        sourceId: 1,
        sessionId: 'cache-session',
        turnIndex: 0,
        callIndex: 0,
        provider: 'codex',
        model: 'raw-cache-model',
        timestamp: '2026-01-01T00:00:01.000Z',
        cacheReadInputTokens: 2,
        cachedInputTokens: 5,
      }),
    )
    data.aliases.push({ model: 'raw-cache-model', aliasOf: 'cache-model' })
    const result = calculateDashboardViews(data, {
      catalogue: capturePricingCatalogue({
        prices: new Map([
          [
            'cache-model',
            {
              inputCostPerToken: 0,
              outputCostPerToken: 0,
              cacheWriteCostPerToken: 0,
              cacheReadCostPerToken: 0.1,
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
      }),
      proxyPaths: { paths: [], caseSensitive: false },
    })
    expect(result.value.kpis.totalCost).toBe(0.5)
    expect(result.value.kpis.totalCacheReadTokens).toBe(2)
    expect(result.unpricedModels).toEqual([])
  })

  it('keeps Devin model names, infers an empty provider, and admits later invalid call timestamps', () => {
    const data = emptyViewData()
    data.sessions.push(
      session(1, 'devin-session', 'devin', 'devin', '/work/devin'),
      session(1, 'fallback-session', 'fallback', 'unknown', '/work/fallback'),
    )
    data.turns.push(
      {
        sourceId: 1,
        sessionId: 'devin-session',
        turnIndex: 0,
        timestamp: '2026-01-01T00:00:00.000Z',
        category: 'coding',
        subCategory: null,
      },
      {
        sourceId: 1,
        sessionId: 'fallback-session',
        turnIndex: 0,
        timestamp: '2026-01-01T00:00:00.000Z',
        category: 'coding',
        subCategory: null,
      },
    )
    data.calls.push(
      call({
        sourceId: 1,
        sessionId: 'devin-session',
        turnIndex: 0,
        callIndex: 0,
        provider: 'devin',
        model: 'claude-opus-4.5',
        timestamp: '2026-01-01T00:00:01.000Z',
        baseCostUSD: 1,
      }),
      call({
        sourceId: 1,
        sessionId: 'devin-session',
        turnIndex: 0,
        callIndex: 1,
        provider: 'devin',
        model: 'claude-opus-4.5',
        timestamp: 'not-a-date',
        baseCostUSD: 2,
      }),
      call({
        sourceId: 1,
        sessionId: 'fallback-session',
        turnIndex: 0,
        callIndex: 0,
        provider: '',
        model: 'gpt-5.4',
        timestamp: '2026-01-01T00:00:02.000Z',
        baseCostUSD: 0.5,
      }),
    )
    const result = calculateDashboardViews(data, {
      catalogue: emptyCatalogue(),
      proxyPaths: { paths: [], caseSensitive: false },
    })
    expect(result.value.kpis.totalCalls).toBe(3)
    expect(result.value.kpis.totalCost).toBe(3.5)
    expect(result.value.byProvider).toEqual([
      { name: 'devin', cost: 3, calls: 2, sessions: 1 },
      { name: 'codex', cost: 0.5, calls: 1, sessions: 1 },
    ])
    expect(result.value.byModel).toEqual([
      { name: 'claude-opus-4.5', cost: 3, calls: 2 },
      { name: 'GPT-5.4', cost: 0.5, calls: 1 },
    ])
  })

  it('keeps insertion order for equal-cost provider and model buckets', () => {
    const data = emptyViewData()
    data.sessions.push(
      session(1, 'session-b', 'project-b', 'z-provider', '/work/b'),
      session(1, 'session-a', 'project-a', 'a-provider', '/work/a'),
    )
    data.turns.push(
      {
        sourceId: 1,
        sessionId: 'session-b',
        turnIndex: 0,
        timestamp: '2026-01-01T00:00:00.000Z',
        category: 'coding',
        subCategory: null,
      },
      {
        sourceId: 1,
        sessionId: 'session-a',
        turnIndex: 0,
        timestamp: '2026-01-01T00:00:00.000Z',
        category: 'coding',
        subCategory: null,
      },
    )
    data.calls.push(
      call({
        sourceId: 1,
        sessionId: 'session-b',
        turnIndex: 0,
        callIndex: 0,
        provider: 'z-provider',
        model: 'z-model',
        timestamp: '2026-01-01T00:00:01.000Z',
        baseCostUSD: 1,
      }),
      call({
        sourceId: 1,
        sessionId: 'session-a',
        turnIndex: 0,
        callIndex: 0,
        provider: 'a-provider',
        model: 'a-model',
        timestamp: '2026-01-01T00:00:01.000Z',
        baseCostUSD: 1,
      }),
    )
    const result = calculateDashboardViews(data, {
      catalogue: emptyCatalogue(),
      proxyPaths: { paths: [], caseSensitive: false },
    })
    expect(result.value.byProvider).toEqual([
      { name: 'a-provider', cost: 1, calls: 1, sessions: 1 },
      { name: 'z-provider', cost: 1, calls: 1, sessions: 1 },
    ])
    expect(result.value.byModel).toEqual([
      { name: 'a-model', cost: 1, calls: 1 },
      { name: 'z-model', cost: 1, calls: 1 },
    ])
  })

  it('keeps duplicate public IDs independent and preserves aggregate edge semantics', () => {
    const inputs = {
      catalogue: emptyCatalogue(),
      proxyPaths: { paths: ['proxy/one'], caseSensitive: false },
    }
    const data = collisionData()
    const dashboard = calculateDashboardViews(data, inputs)
    // The old snapshot builder joins proxy paths by public session ID. With a
    // collision, the first source's path can therefore be applied to both rows.
    // This direct calculation intentionally uses each composite source/session
    // identity, so only the first project's cost is proxied.
    expect(dashboard).toEqual({
      value: {
        kpis: {
          totalCost: 17,
          totalEstimatedCost: 8,
          totalSavings: 1.5,
          totalProxiedCost: 13,
          totalCalls: 4,
          totalSessions: 2,
          totalProjects: 2,
          totalInputTokens: 2_500_000,
          totalOutputTokens: 2_000_000,
          totalCacheReadTokens: 2,
          totalCacheWriteTokens: 4,
          totalReasoningTokens: 5,
        },
        costOverTime: [{ date: '2026-01-01', cost: 17 }],
        byProvider: [
          { name: 'codex', cost: 13, calls: 3, sessions: 1 },
          { name: 'claude', cost: 4, calls: 1, sessions: 1 },
        ],
        byModel: [
          { name: 'Sonnet 4', cost: 17, calls: 4 },
          { name: 'GPT-5.4', cost: 13, calls: 3 },
        ],
        byProject: [
          { name: 'one', cost: 13, calls: 3 },
          { name: 'two', cost: 4, calls: 1 },
        ],
        byCategory: [
          { name: 'Feature Dev', cost: 13, turns: 2 },
          { name: 'General', cost: 4, turns: 1 },
        ],
      },
      unpricedModels: ['missing-target'],
    })
    expect(calculateAnalyticalViews(data, inputs)).toEqual({
      value: {
        providers: [
          { name: 'codex', cost: 13, calls: 3, sessions: 1 },
          { name: 'claude', cost: 4, calls: 1, sessions: 1 },
        ],
        models: [
          { name: 'Sonnet 4', cost: 17, calls: 4 },
          { name: 'GPT-5.4', cost: 13, calls: 3 },
        ],
        categories: [
          { name: 'Feature Dev', cost: 13, turns: 2 },
          { name: 'General', cost: 4, turns: 1 },
        ],
        skills: [{ name: 'auth', turns: 2, cost: 13, savingsUSD: 1.5 }],
        subagents: [{ name: 'explore', calls: 2, cost: 16, savingsUSD: 3 }],
      },
      unpricedModels: ['missing-target'],
    })
  })
})
