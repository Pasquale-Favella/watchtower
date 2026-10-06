import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import { captureModelPricingCatalogue } from '../src/main/pipeline/models.js'
import { capturePricingCatalogue } from '../src/main/pipeline/pricing-calculation.js'
import { searchSessionsFromData } from '../src/main/session-search-calculation.js'
import { LedgerSessionReads } from '../src/main/store/ledger-session-reads.js'
import type { SessionSummaryData } from '../src/main/store/session-read-projections.js'
import { buildProjectRowsFromSessionData, querySessionRowsFromSessionData } from '../src/main/store-rows-calculation.js'
import { openWorkerOwner } from '../src/main/worker-runtime.js'
import { buildFixtureCachedFile, FIXTURE_SOURCE_PATH } from './fixtures/cached-file.js'
import {
  legacyBuildProjectRowsFromLedger,
  legacyQuerySessionRowsFromLedger,
  legacySearchSessionsFromLedger,
} from './fixtures/pre-wave17-store-views.js'
import { projectRows, sessionRows, sessionSearch } from './fixtures/store-view-queries.js'

const catalogue = capturePricingCatalogue({
  prices: new Map(),
  overrides: new Map(),
  builtinAliases: {},
  userAliases: {},
  tiers: [],
  routedSegments: new Set(),
})

function data(): SessionSummaryData {
  return {
    sessions: [
      {
        sourceId: 1,
        sessionId: 'same-label-a',
        project: 'tree',
        projectPath: '/work/tree',
        workingDirectory: '/work/tree',
        canonicalProject: 'tree',
        canonicalCwd: '/work/tree',
        title: 'A',
        sourceProvider: 'claude',
        repoUrl: 'https://a',
      },
      {
        sourceId: 1,
        sessionId: 'same-label-b',
        project: 'tree',
        projectPath: '/other/tree',
        workingDirectory: '/other/tree',
        canonicalProject: 'tree',
        canonicalCwd: '/other/tree',
        title: 'B',
        sourceProvider: 'claude',
        repoUrl: null,
      },
      {
        sourceId: 2,
        sessionId: 'orphan',
        project: 'legacy-label',
        projectPath: 'legacy-label',
        workingDirectory: null,
        canonicalProject: null,
        canonicalCwd: null,
        title: null,
        sourceProvider: 'codex',
        repoUrl: null,
      },
      // Duplicate public ID across sources: the first metadata row owns the
      // legacy project-path fallback while both composite identities survive.
      {
        sourceId: 3,
        sessionId: 'duplicate',
        project: 'old',
        projectPath: 'first-label',
        workingDirectory: null,
        canonicalProject: null,
        canonicalCwd: null,
        title: null,
        sourceProvider: 'claude',
        repoUrl: null,
      },
      {
        sourceId: 4,
        sessionId: 'duplicate',
        project: 'old',
        projectPath: 'second-label',
        workingDirectory: null,
        canonicalProject: null,
        canonicalCwd: null,
        title: null,
        sourceProvider: 'claude',
        repoUrl: null,
      },
    ],
    turns: [
      { sourceId: 1, sessionId: 'same-label-a', turnIndex: 0, timestamp: '2026-01-02T00:00:00.000Z' },
      { sourceId: 1, sessionId: 'same-label-b', turnIndex: 0, timestamp: '2026-01-03T00:00:00.000Z' },
      { sourceId: 2, sessionId: 'orphan', turnIndex: 0, timestamp: '2026-01-01T00:00:00.000Z' },
      { sourceId: 3, sessionId: 'duplicate', turnIndex: 9, timestamp: '2026-01-04T00:00:00.000Z' },
      { sourceId: 3, sessionId: 'duplicate', turnIndex: 2, timestamp: '2026-01-05T00:00:00.000Z' },
      { sourceId: 4, sessionId: 'duplicate', turnIndex: 1, timestamp: '2026-01-04T00:00:00.000Z' },
    ],
    calls: [
      call(1, 'same-label-a', 0, 0, 'claude', 'claude-sonnet-4', '2026-01-02T00:00:01.000Z', 3),
      call(1, 'same-label-b', 0, 0, 'claude', 'claude-sonnet-4', '2026-01-03T00:00:01.000Z', 2),
      call(2, 'orphan', 0, 0, 'codex', 'gpt-5.4', '2026-01-01T00:00:01.000Z', 1),
      call(3, 'duplicate', 9, 0, 'claude', 'claude-sonnet-4', '2026-01-04T00:00:02.000Z', 1),
      call(3, 'duplicate', 2, 0, 'claude', 'claude-sonnet-4', '2026-01-05T00:00:02.000Z', 2),
      call(4, 'duplicate', 1, 0, 'claude', 'claude-sonnet-4', '2026-01-04T00:00:02.000Z', 4),
    ],
    aliases: [],
    overrides: [],
  }
}

function call(
  sourceId: number,
  sessionId: string,
  turnIndex: number,
  callIndex: number,
  provider: string,
  model: string,
  timestamp: string,
  baseCostUSD: number,
) {
  return {
    sourceId,
    sessionId,
    turnIndex,
    callIndex,
    provider,
    model,
    timestamp,
    speed: 'standard' as const,
    baseCostUSD,
    isEstimated: 0,
    savingsUSD: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    webSearchRequests: 0,
  }
}

describe('store row calculations', () => {
  it('keeps same-label checkouts separate, groups duplicate public IDs by source, and preserves fallback metadata order', () => {
    const { rows } = buildProjectRowsFromSessionData(data(), catalogue)
    expect(rows).toEqual([
      expect.objectContaining({ project: 'orphan:claude', projectPath: 'first-label', cost: 7, calls: 3, sessions: 2 }),
      expect.objectContaining({
        project: 'tree',
        projectPath: '/work/tree',
        repoUrl: 'https://a',
        cost: 3,
        calls: 1,
        sessions: 1,
      }),
      expect.objectContaining({ project: 'tree', projectPath: '/other/tree', cost: 2, calls: 1, sessions: 1 }),
      expect.objectContaining({ project: 'orphan:codex', projectPath: 'legacy-label', cost: 1, calls: 1, sessions: 1 }),
    ])
    expect(Object.hasOwn(rows[0]!, 'repoUrl')).toBe(true)
    expect(rows[0]!.repoUrl).toBeUndefined()
  })

  it('admits whole turns by the first ordered call timestamp and includes later invalid calls', () => {
    const facts = data()
    facts.turns.push(
      { sourceId: 1, sessionId: 'same-label-a', turnIndex: 5, timestamp: 'fallback' },
      { sourceId: 1, sessionId: 'same-label-a', turnIndex: 6, timestamp: '2026-01-06T00:00:00.000Z' },
    )
    facts.calls.push(
      call(1, 'same-label-a', 5, 0, 'claude', 'claude-sonnet-4', 'not-a-date', 100),
      call(1, 'same-label-a', 6, 0, 'claude', 'claude-sonnet-4', '2026-01-06T00:00:01.000Z', 5),
      call(1, 'same-label-a', 6, 1, 'claude', 'claude-sonnet-4', 'not-a-date', 7),
    )
    const { rows } = querySessionRowsFromSessionData(facts, catalogue, {})
    expect(rows.find(row => row.sessionId === 'same-label-a')).toMatchObject({ calls: 3, cost: 15, turns: 2 })
  })

  it('uses inclusive boundaries, exact project labels, and stable descending timestamp ties', () => {
    const facts = data()
    facts.turns.push({ sourceId: 1, sessionId: 'same-label-a', turnIndex: 1, timestamp: '2026-01-03T00:00:00.000Z' })
    facts.calls.push(call(1, 'same-label-a', 1, 0, 'claude', 'claude-sonnet-4', '2026-01-03T00:00:01.000Z', 1))
    const all = querySessionRowsFromSessionData(facts, catalogue, {
      since: '2026-01-03T00:00:01.000Z',
      until: '2026-01-04T00:00:02.000Z',
    }).rows
    expect(all.map(row => row.sessionId)).toEqual(['duplicate', 'duplicate', 'same-label-b'])
    expect(querySessionRowsFromSessionData(facts, catalogue, { project: 'Tree' }).rows).toEqual([])
  })

  it('prices query-time aliases and overrides, reports merged raw-model provenance, and drops nonpositive savings', () => {
    const original = data()
    const facts: SessionSummaryData = {
      ...original,
      sessions: [...original.sessions].slice(0, 1),
      turns: [{ sourceId: 1, sessionId: 'same-label-a', turnIndex: 0, timestamp: '2026-01-02T00:00:00.000Z' }],
      calls: [
        {
          ...call(1, 'same-label-a', 0, 0, 'codex', 'mystery-model', '2026-01-02T00:00:01.000Z', 5),
          inputTokens: 1_000_000,
          outputTokens: 2_000_000,
          savingsUSD: -1,
        },
      ],
      aliases: [{ model: 'mystery-model', aliasOf: 'gpt-5.4' }],
      overrides: [{ model: 'gpt-5.4', inputPricePerMillion: 2, outputPricePerMillion: 3 }],
    }
    const { rows } = querySessionRowsFromSessionData(facts, catalogue, {})
    expect(rows[0]).toMatchObject({
      cost: 8,
      savingsUSD: 0,
      models: ['GPT-5.4'],
      modelProvenance: { 'GPT-5.4': ['mystery-model'] },
    })
  })

  it('uses the legacy object-key order for numeric-looking model identities', () => {
    const original = data()
    const facts: SessionSummaryData = {
      ...original,
      sessions: [...original.sessions].slice(0, 1),
      turns: [{ sourceId: 1, sessionId: 'same-label-a', turnIndex: 0, timestamp: '2026-01-02T00:00:00.000Z' }],
      calls: [
        call(1, 'same-label-a', 0, 0, 'codex', 'z-model', '2026-01-02T00:00:01.000Z', 1),
        call(1, 'same-label-a', 0, 1, 'codex', '2', '2026-01-02T00:00:02.000Z', 1),
      ],
      aliases: [],
      overrides: [],
    }
    expect(querySessionRowsFromSessionData(facts, catalogue, {}).rows[0]?.models).toEqual(['2', 'z-model'])
  })

  it('matches the legacy view builders on a real ledger session-read projection', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-row-calculation-'))
    const owner = openWorkerOwner(join(directory, 'ledger.db'))
    try {
      owner.ledger.portIn({
        provider: 'opencode',
        envFingerprint: 'rows-parity',
        filePath: FIXTURE_SOURCE_PATH,
        verdict: 'new',
        cachedFile: buildFixtureCachedFile(),
      })
      const data = await owner.runtime.runPromise(
        Effect.flatMap(LedgerSessionReads, reads => reads.getSessionSummaryData()),
      )
      const searchData = await owner.runtime.runPromise(
        Effect.flatMap(LedgerSessionReads, reads => reads.getSessionSearchData()),
      )
      const catalogue = captureModelPricingCatalogue()
      const projectResult = buildProjectRowsFromSessionData(data, catalogue).rows
      const sessionResult = querySessionRowsFromSessionData(data, catalogue, {}).rows
      const searchResult = searchSessionsFromData(searchData, 'auth', catalogue)
      expect(projectResult).toStrictEqual(legacyBuildProjectRowsFromLedger(owner.ledger))
      expect(sessionResult).toStrictEqual(legacyQuerySessionRowsFromLedger(owner.ledger, {}))
      expect(searchResult).toStrictEqual(legacySearchSessionsFromLedger(owner.ledger, 'auth'))
      expect(await projectRows(owner.ledger)).toStrictEqual(projectResult)
      expect(await sessionRows(owner.ledger)).toStrictEqual(sessionResult)
      expect(await sessionSearch(owner.ledger, 'auth')).toStrictEqual(searchResult)
    } finally {
      await Effect.runPromise(owner.runtime.disposeEffect)
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
