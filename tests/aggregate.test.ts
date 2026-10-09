import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import { calculateCost } from '../src/main/pipeline/models.js'
import { buildSessionSummary, cachedTurnToClassified } from '../src/main/pipeline/parser.js'
import { aggregateSessions } from '../src/main/pipeline/sessions-report.js'
import type { ClassifiedTurn, SessionSummary } from '../src/main/pipeline/types.js'
import {
  buildSessionRowsFromSnapshot,
  buildSessionSummariesFromSnapshot,
  defaultRange,
  queryScopeFromSnapshot,
} from '../src/main/store/aggregate-calculation.js'
import { LedgerConfig, LedgerIngest, type LedgerIngestPort } from '../src/main/store/ledger-ports.js'
import { type LedgerQuerySnapshot, loadLedgerQuerySnapshotEffect } from '../src/main/store/ledger-query-snapshot.js'
import { buildFixtureCachedFile, buildFixtureCachedTurn, FIXTURE_SOURCE_PATH } from './fixtures/cached-file.js'
import { openLedgerFixture, viewInputs } from './fixtures/ledger-runtime.js'

type TestRuntime = ReturnType<typeof openLedgerFixture>['runtime']

function portIn(runtime: TestRuntime, input: Parameters<LedgerIngestPort['portIn']>[0]): void {
  runtime.runSync(Effect.flatMap(LedgerIngest, ingest => ingest.portIn(input)))
}

function loadSnapshot(runtime: TestRuntime): LedgerQuerySnapshot {
  return runtime.runSync(loadLedgerQuerySnapshotEffect(viewInputs({ period: 'lifetime' })))
}

const baseInput = {
  provider: 'opencode',
  envFingerprint: 'env-demo',
  filePath: FIXTURE_SOURCE_PATH,
}

const FULL_RANGE = defaultRange(new Date('2026-08-01T00:00:00.000Z'), 60)

// The OLD path's reference assembly for the same classified facts, mirroring the
// parser's post-assembly attachments (title, prLinks, workingDirectory).
function oldPathSummaries(cachedFile: ReturnType<typeof buildFixtureCachedFile>): SessionSummary[] {
  const project = cachedFile.canonicalProjectName ?? 'demo-project'
  let carriedBranch: string | undefined
  const turns: ClassifiedTurn[] = cachedFile.turns.map(turn => {
    if (turn.gitBranch) carriedBranch = turn.gitBranch
    return cachedTurnToClassified(turn, carriedBranch)
  })
  const summary = buildSessionSummary('sess-0', project, turns, cachedFile.mcpInventory)
  // Canonical identity (#102): the fixture carries canonicalCwd
  // '/workspace/demo-project', so the seam derives this key, path and display.
  summary.projectKey = '/workspace/demo-project'
  summary.projectPath = '/workspace/demo-project'
  const explicitLinks = new Set(turns.flatMap(turn => turn.prRefs ?? []))
  for (const link of cachedFile.prLinks ?? []) explicitLinks.add(link)
  if (explicitLinks.size) summary.prLinks = [...explicitLinks].sort()
  if (cachedFile.workingDirectory) summary.workingDirectory = cachedFile.workingDirectory
  if (cachedFile.title) summary.title = cachedFile.title
  return [summary]
}

describe('aggregation seam (T2): flat rows → byte-compatible session aggregates', () => {
  it('assembles the single-turn fixture byte-identically to the old parser assembly', () => {
    const { runtime } = openLedgerFixture()
    const file = buildFixtureCachedFile()
    portIn(runtime, { ...baseInput, verdict: 'new', cachedFile: file })

    const actual = buildSessionSummariesFromSnapshot(loadSnapshot(runtime), { range: FULL_RANGE })
    const expected = oldPathSummaries(file)

    expect(actual).toEqual(expected)
    expect(actual).toHaveLength(1)
    expect(actual[0]!.totalCostUSD).toBeCloseTo(0.42, 6)
    expect(actual[0]!.categoryBreakdown['refactoring']).toEqual({
      turns: 1,
      costUSD: 0.42,
      savingsUSD: 0,
      retries: 0,
      editTurns: 1,
      oneShotTurns: 1,
    })
    expect(actual[0]!.modelBreakdown['demo-model']).toMatchObject({
      calls: 1,
      costUSD: 0.42,
      savingsUSD: 0,
      estimatedCostUSD: 0,
    })
    expect(actual[0]!.toolBreakdown).toEqual({ Edit: { calls: 1 } })
  })

  it('aggregates a multi-turn, multi-call, PR-carrying session identically to the old path', () => {
    const { runtime } = openLedgerFixture()
    const file = buildFixtureCachedFile()
    const turn1 = buildFixtureCachedTurn(1, 'Add the new endpoint')
    turn1.calls[0]!.bashCommands = ['npm test']
    turn1.calls[0]!.toolSequence = [[{ tool: 'Edit', file: 'src/api.ts' }]]
    turn1.prRefs = ['https://github.com/acme/demo-project/pull/7']
    file.turns.push(turn1)
    file.turns[0]!.prRefs = ['https://github.com/acme/demo-project/pull/6']

    portIn(runtime, { ...baseInput, verdict: 'new', cachedFile: file })

    const actual = buildSessionSummariesFromSnapshot(loadSnapshot(runtime), { range: FULL_RANGE })
    const expected = oldPathSummaries(file)

    expect(actual).toEqual(expected)
    expect(actual).toHaveLength(1)
    const session = actual[0]!
    expect(session.turns).toHaveLength(2)
    expect(session.turns[0]!.prRefs).toEqual(['https://github.com/acme/demo-project/pull/6'])
    expect(session.turns[1]!.prRefs).toEqual(['https://github.com/acme/demo-project/pull/7'])
    expect(session.prLinks).toEqual([
      'https://github.com/acme/demo-project/pull/6',
      'https://github.com/acme/demo-project/pull/7',
    ])
    expect(session.bashBreakdown).toEqual({ 'npm test': { calls: 1 } })
    expect(session.turns[1]!.assistantCalls[0]!.toolSequence).toEqual([[{ tool: 'Edit', file: 'src/api.ts' }]])
    expect(session.totalInputTokens).toBe(200)
    expect(session.totalOutputTokens).toBe(100)
    expect(session.apiCalls).toBe(2)
  })

  it('carries a git branch forward across turns from the ledger (Claude-style branch data)', () => {
    const { runtime } = openLedgerFixture()
    const file = buildFixtureCachedFile()
    const turn1 = buildFixtureCachedTurn(1, 'Add the new endpoint')
    turn1.gitBranch = 'feature/auth'
    file.turns.push(turn1)

    portIn(runtime, { ...baseInput, verdict: 'new', cachedFile: file })

    const sessions = buildSessionSummariesFromSnapshot(loadSnapshot(runtime), { range: FULL_RANGE })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.turns[1]!.gitBranch).toBe('feature/auth')
    expect(sessions[0]!.everHadBranch).toBe(true)
  })

  it('slices by date range: only in-range turns contribute, carrying PR state across the boundary', () => {
    const { runtime } = openLedgerFixture()
    const file = buildFixtureCachedFile()
    // Turn 0 lands BEFORE the range with a PR reference; turn 1 is in-range and
    // ref-less, so the range-start seeding must carry pull/6 into it.
    file.turns[0]!.calls[0]!.timestamp = '2026-06-28T09:00:00.000Z'
    file.turns[0]!.timestamp = '2026-06-28T09:00:00.000Z'
    file.turns[0]!.prRefs = ['https://github.com/acme/demo-project/pull/6']
    const inRange = buildFixtureCachedTurn(1, 'Add the new endpoint')
    file.turns.push(inRange)

    portIn(runtime, { ...baseInput, verdict: 'new', cachedFile: file })

    const narrow = { range: defaultRange(new Date('2026-07-06T00:00:00.000Z'), 7) }
    const actual = buildSessionSummariesFromSnapshot(loadSnapshot(runtime), narrow)
    expect(actual).toHaveLength(1)
    const session = actual[0]!
    expect(session.turns).toHaveLength(1)
    expect(session.turns[0]!.prRefs).toBeUndefined()
    expect(session.prRefsAtRangeStart).toEqual(['https://github.com/acme/demo-project/pull/6'])
    expect(session.totalInputTokens).toBe(100)
    expect(session.firstTimestamp).toBe('2026-07-01T09:11:00.000Z')

    const empty = buildSessionSummariesFromSnapshot(loadSnapshot(runtime), {
      range: defaultRange(new Date('2026-06-01T00:00:00.000Z'), 7),
    })
    expect(empty).toEqual([])
  })

  it('filters by provider from the request snapshot: only that provider’s sessions survive', () => {
    const { runtime } = openLedgerFixture()
    portIn(runtime, { ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })
    portIn(runtime, {
      ...baseInput,
      provider: 'codex',
      envFingerprint: 'env-demo',
      filePath: '/Users/demo/.codex/other/sess-0.jsonl',
      verdict: 'new',
      cachedFile: buildFixtureCachedFile(),
    })

    const opencode = buildSessionSummariesFromSnapshot(loadSnapshot(runtime), {
      range: FULL_RANGE,
      provider: 'opencode',
    })
    const codex = buildSessionSummariesFromSnapshot(loadSnapshot(runtime), { range: FULL_RANGE, provider: 'codex' })
    const all = buildSessionSummariesFromSnapshot(loadSnapshot(runtime), { range: FULL_RANGE })

    expect(opencode).toHaveLength(1)
    expect(codex).toHaveLength(1)
    expect(all).toHaveLength(2)
    // Same session_id across providers stays distinct (keyed by source + id).
    expect(opencode[0]!.sessionId).toBe(codex[0]!.sessionId)
  })

  it('a configured price override reprices display cost on read without touching stored rows', () => {
    const { runtime } = openLedgerFixture()
    portIn(runtime, { ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })

    runtime.runSync(
      Effect.flatMap(LedgerConfig, config =>
        config.setPriceOverride('demo-model', { inputPricePerMillion: 3, outputPricePerMillion: 15 }),
      ),
    )

    // Session summaries carry the display (repriced) cost, mirroring the
    // Models lens (override on the effective model; input+output only).
    const scope = buildSessionSummariesFromSnapshot(loadSnapshot(runtime), { range: FULL_RANGE })
    expect(scope[0]!.totalCostUSD).toBeCloseTo(0.00105, 9)

    const calls = queryScopeFromSnapshot(loadSnapshot(runtime), { range: FULL_RANGE }).calls
    expect(calls).toHaveLength(1)
    // Models-lens override: input 100 @ $3/M + output 50 @ $15/M = 0.0003 + 0.00075
    expect(calls[0]!.displayCostUSD).toBeCloseTo(0.00105, 9)
    expect(calls[0]!.baseCostUSD).toBeCloseTo(0.42, 6)
  })

  it('a configured model alias rewrites the model identity on read', () => {
    const { runtime } = openLedgerFixture()
    portIn(runtime, { ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })
    runtime.runSync(Effect.flatMap(LedgerConfig, config => config.setModelAlias('demo-model', 'claude-sonnet-4.5')))

    const calls = queryScopeFromSnapshot(loadSnapshot(runtime), { range: FULL_RANGE }).calls
    expect(calls[0]!.resolvedModel).toBe('claude-sonnet-4.5')
    expect(calls[0]!.model).toBe('demo-model')
  })

  it('an Alias merges identity and reprices the session summary (no rescan)', () => {
    const { runtime } = openLedgerFixture()
    portIn(runtime, { ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })
    runtime.runSync(Effect.flatMap(LedgerConfig, config => config.setModelAlias('demo-model', 'claude-sonnet-4-6')))

    const summaries = buildSessionSummariesFromSnapshot(loadSnapshot(runtime), { range: FULL_RANGE })
    expect(summaries).toHaveLength(1)
    const summary = summaries[0]!
    // Identity merges into the target everywhere except Compare/audit.
    expect(summary.turns[0]!.assistantCalls[0]!.model).toBe('claude-sonnet-4-6')
    expect(summary.turns[0]!.assistantCalls[0]!.rawModel).toBe('demo-model')
    // Cost reprices through the target's rate card (the scan priced the raw
    // name at its stored base); the stored row is untouched.
    expect(summary.totalCostUSD).not.toBeCloseTo(0.42, 6)
    expect(summary.totalCostUSD).toBeGreaterThan(0)
    expect(summary.totalCostUSD).toBeCloseTo(
      queryScopeFromSnapshot(loadSnapshot(runtime), { range: FULL_RANGE }).calls[0]!.displayCostUSD,
      9,
    )
    // Provenance survives on the merged breakdown row.
    const keys = Object.keys(summary.modelBreakdown)
    expect(keys).toHaveLength(1)
    expect(summary.modelBreakdown[keys[0]!]!.sourceModels).toEqual(['demo-model'])

    const rows = buildSessionRowsFromSnapshot(loadSnapshot(runtime), { range: FULL_RANGE })
    expect(rows[0]!.cost).toBeCloseTo(summary.totalCostUSD, 9)
    expect(rows[0]!.models).toEqual(keys)
  })

  it('a Price override on the effective model wins over the Alias', () => {
    const { runtime } = openLedgerFixture()
    portIn(runtime, { ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })
    runtime.runSync(Effect.flatMap(LedgerConfig, config => config.setModelAlias('demo-model', 'claude-sonnet-4-6')))
    runtime.runSync(
      Effect.flatMap(LedgerConfig, config =>
        config.setPriceOverride('claude-sonnet-4-6', { inputPricePerMillion: 3, outputPricePerMillion: 15 }),
      ),
    )

    // Fixture usage: input 100, output 50 → 0.0003 + 0.00075.
    const summaries = buildSessionSummariesFromSnapshot(loadSnapshot(runtime), { range: FULL_RANGE })
    expect(summaries[0]!.totalCostUSD).toBeCloseTo(0.00105, 9)
    expect(queryScopeFromSnapshot(loadSnapshot(runtime), { range: FULL_RANGE }).calls[0]!.displayCostUSD).toBeCloseTo(
      0.00105,
      9,
    )
  })

  it('an Alias matches provider-prefixed, pinned and cased variants of the stored id', () => {
    const { runtime } = openLedgerFixture()
    const variants = ['Opencode/Demo-Model@20250929', 'openrouter/opencode/demo-model', 'demo-model:thinking']
    variants.forEach((model, i) => {
      const file = buildFixtureCachedFile()
      file.turns[0]!.calls[0]!.model = model
      portIn(runtime, {
        ...baseInput,
        filePath: `/cache/opencode/variant-${i}.jsonl`,
        verdict: 'new',
        cachedFile: file,
      })
    })
    runtime.runSync(Effect.flatMap(LedgerConfig, config => config.setModelAlias('demo-model', 'claude-sonnet-4-6')))

    // Fixture usage: input 100, output 50, cache-read 20, repriced at the target's rates.
    const expected = calculateCost('claude-sonnet-4-6', 100, 50, 0, 20, 0, 'standard')
    expect(expected).toBeGreaterThan(0)
    const summaries = buildSessionSummariesFromSnapshot(loadSnapshot(runtime), { range: FULL_RANGE })
    expect(summaries).toHaveLength(variants.length)
    for (const summary of summaries) {
      expect(summary.totalCostUSD).toBeCloseTo(expected, 9)
      expect(summary.turns[0]!.assistantCalls[0]!.model).toBe('claude-sonnet-4-6')
    }
    expect(summaries.map(s => s.turns[0]!.assistantCalls[0]!.rawModel).sort()).toEqual([...variants].sort())
  })

  it('a Price override matches variant spellings of the effective model', () => {
    const { runtime } = openLedgerFixture()
    const file = buildFixtureCachedFile()
    file.turns[0]!.calls[0]!.model = 'DEMO-MODEL'
    portIn(runtime, { ...baseInput, verdict: 'new', cachedFile: file })
    runtime.runSync(
      Effect.flatMap(LedgerConfig, config =>
        config.setPriceOverride('demo-model', { inputPricePerMillion: 3, outputPricePerMillion: 15 }),
      ),
    )

    // Fixture usage: input 100, output 50 → 0.0003 + 0.00075 (input+output only).
    const summaries = buildSessionSummariesFromSnapshot(loadSnapshot(runtime), { range: FULL_RANGE })
    expect(summaries[0]!.totalCostUSD).toBeCloseTo(0.00105, 9)
  })

  it('removing custom pricing reverts honestly to the unpriced treatment', () => {
    const { runtime } = openLedgerFixture()
    portIn(runtime, { ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })
    runtime.runSync(Effect.flatMap(LedgerConfig, config => config.setModelAlias('demo-model', 'claude-sonnet-4-6')))
    runtime.runSync(
      Effect.flatMap(LedgerConfig, config =>
        config.setPriceOverride('claude-sonnet-4-6', { inputPricePerMillion: 3, outputPricePerMillion: 15 }),
      ),
    )

    expect(
      buildSessionSummariesFromSnapshot(loadSnapshot(runtime), { range: FULL_RANGE })[0]!.totalCostUSD,
    ).toBeCloseTo(0.00105, 9)

    runtime.runSync(Effect.flatMap(LedgerConfig, config => config.removePriceOverride('claude-sonnet-4-6')))
    runtime.runSync(Effect.flatMap(LedgerConfig, config => config.removeModelAlias('demo-model')))

    const summaries = buildSessionSummariesFromSnapshot(loadSnapshot(runtime), { range: FULL_RANGE })
    expect(summaries[0]!.totalCostUSD).toBeCloseTo(0.42, 6)
    expect(summaries[0]!.turns[0]!.assistantCalls[0]!.model).toBe('demo-model')
    expect(summaries[0]!.turns[0]!.assistantCalls[0]!.rawModel).toBeUndefined()
    expect(Object.keys(summaries[0]!.modelBreakdown)).toEqual(['demo-model'])
  })

  it('Scope filtering still applies under custom pricing', () => {
    const { runtime } = openLedgerFixture()
    portIn(runtime, { ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })
    portIn(runtime, {
      ...baseInput,
      provider: 'codex',
      envFingerprint: 'env-demo',
      filePath: '/Users/demo/.codex/other/sess-0.jsonl',
      verdict: 'new',
      cachedFile: buildFixtureCachedFile(),
    })
    runtime.runSync(
      Effect.flatMap(LedgerConfig, config =>
        config.setPriceOverride('demo-model', { inputPricePerMillion: 3, outputPricePerMillion: 15 }),
      ),
    )

    const opencode = buildSessionSummariesFromSnapshot(loadSnapshot(runtime), {
      range: FULL_RANGE,
      provider: 'opencode',
    })
    const codex = buildSessionSummariesFromSnapshot(loadSnapshot(runtime), { range: FULL_RANGE, provider: 'codex' })
    expect(opencode).toHaveLength(1)
    expect(codex).toHaveLength(1)
    expect(opencode[0]!.totalCostUSD).toBeCloseTo(0.00105, 9)
    expect(codex[0]!.totalCostUSD).toBeCloseTo(0.00105, 9)
  })

  it('the Sessions payload (`SessionRow[]`) is byte-identical to the old `aggregateSessions` rows', () => {
    const { runtime } = openLedgerFixture()
    const file = buildFixtureCachedFile()
    portIn(runtime, { ...baseInput, verdict: 'new', cachedFile: file })

    const actual = buildSessionRowsFromSnapshot(loadSnapshot(runtime), { range: FULL_RANGE })
    // The report-shaped reference: the old view path projects the old-path
    // summaries (already proven byte-equal to the seam) into SessionRow[].
    const expected = aggregateSessions([
      {
        project: 'demo-project',
        projectPath: '/workspace/demo-project',
        totalCostUSD: 0.42,
        totalSavingsUSD: 0,
        totalEstimatedCostUSD: 0,
        totalApiCalls: 1,
        totalProxiedCostUSD: 0,
        sessions: oldPathSummaries(file),
      },
    ])

    expect(actual).toEqual(expected)
    expect(actual).toHaveLength(1)
    expect(actual[0]).toMatchObject({
      sessionId: 'sess-0',
      project: 'demo-project',
      provider: 'opencode',
      models: ['demo-model'],
      cost: 0.42,
      calls: 1,
      turns: 1,
      startedAt: '2026-07-01T09:00:00.000Z',
      endedAt: '2026-07-01T09:00:00.000Z',
    })
  })
})

describe('query-time pricing snapshots', () => {
  it('keeps each request on the aliases and overrides it captured', () => {
    const { runtime } = openLedgerFixture()
    portIn(runtime, { ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })

    runtime.runSync(
      Effect.flatMap(LedgerConfig, config =>
        config.setPriceOverride('demo-model', { inputPricePerMillion: 1_000_000, outputPricePerMillion: 0 }),
      ),
    )
    const firstSnapshot = loadSnapshot(runtime)
    const firstSummary = buildSessionSummariesFromSnapshot(firstSnapshot, { range: FULL_RANGE })

    runtime.runSync(
      Effect.flatMap(LedgerConfig, config =>
        config.setPriceOverride('demo-model', { inputPricePerMillion: 2_000_000, outputPricePerMillion: 0 }),
      ),
    )
    const secondSnapshot = loadSnapshot(runtime)
    const secondSummary = buildSessionSummariesFromSnapshot(secondSnapshot, { range: FULL_RANGE })

    expect(buildSessionSummariesFromSnapshot(firstSnapshot, { range: FULL_RANGE })).toEqual(firstSummary)
    expect(secondSummary[0]!.totalCostUSD).toBeCloseTo(firstSummary[0]!.totalCostUSD * 2, 9)
  })
})
