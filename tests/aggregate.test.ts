import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LedgerStore } from '../src/main/store/ledger.js'
import { buildSessionRows, buildSessionSummaries, defaultRange, queryScope } from '../src/main/store/aggregate.js'
import { calculateCost } from '../src/main/pipeline/models.js'
import { buildSessionSummary, cachedTurnToClassified } from '../src/main/pipeline/parser.js'
import { aggregateSessions } from '../src/main/pipeline/sessions-report.js'
import type { ClassifiedTurn } from '../src/main/pipeline/types.js'
import {
  buildFixtureCachedFile,
  buildFixtureCachedTurn,
  FIXTURE_SOURCE_PATH,
} from './fixtures/cached-file.js'

const tempDirs: string[] = []

function makeStore(): LedgerStore {
  const dir = mkdtempSync(join(tmpdir(), 'tr-agg-'))
  tempDirs.push(dir)
  return new LedgerStore(join(dir, 'data.db'))
}

afterEach(() => {
  tempDirs.splice(0)
})

const baseInput = {
  provider: 'opencode',
  envFingerprint: 'env-demo',
  filePath: FIXTURE_SOURCE_PATH,
}

const FULL_RANGE = defaultRange(new Date('2026-08-01T00:00:00.000Z'), 60)

// The OLD path's reference assembly for the same classified facts, mirroring the
// parser's post-assembly attachments (title, prLinks, workingDirectory).
function oldPathSummaries(cachedFile: ReturnType<typeof buildFixtureCachedFile>): ReturnType<typeof buildSessionSummaries> {
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
    const store = makeStore()
    const file = buildFixtureCachedFile()
    store.portIn({ ...baseInput, verdict: 'new', cachedFile: file })

    const actual = buildSessionSummaries(store, { range: FULL_RANGE })
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

    store.close()
  })

  it('aggregates a multi-turn, multi-call, PR-carrying session identically to the old path', () => {
    const store = makeStore()
    const file = buildFixtureCachedFile()
    const turn1 = buildFixtureCachedTurn(1, 'Add the new endpoint')
    turn1.calls[0]!.bashCommands = ['npm test']
    turn1.calls[0]!.toolSequence = [[{ tool: 'Edit', file: 'src/api.ts' }]]
    turn1.prRefs = ['https://github.com/acme/demo-project/pull/7']
    file.turns.push(turn1)
    file.turns[0]!.prRefs = ['https://github.com/acme/demo-project/pull/6']

    store.portIn({ ...baseInput, verdict: 'new', cachedFile: file })

    const actual = buildSessionSummaries(store, { range: FULL_RANGE })
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

    store.close()
  })

  it('carries a git branch forward across turns from the ledger (Claude-style branch data)', () => {
    const store = makeStore()
    const file = buildFixtureCachedFile()
    const turn1 = buildFixtureCachedTurn(1, 'Add the new endpoint')
    turn1.gitBranch = 'feature/auth'
    file.turns.push(turn1)

    store.portIn({ ...baseInput, verdict: 'new', cachedFile: file })

    const sessions = buildSessionSummaries(store, { range: FULL_RANGE })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.turns[1]!.gitBranch).toBe('feature/auth')
    expect(sessions[0]!.everHadBranch).toBe(true)

    store.close()
  })

  it('slices by date range: only in-range turns contribute, carrying PR state across the boundary', () => {
    const store = makeStore()
    const file = buildFixtureCachedFile()
    // Turn 0 lands BEFORE the range with a PR reference; turn 1 is in-range and
    // ref-less, so the range-start seeding must carry pull/6 into it.
    file.turns[0]!.calls[0]!.timestamp = '2026-06-28T09:00:00.000Z'
    file.turns[0]!.timestamp = '2026-06-28T09:00:00.000Z'
    file.turns[0]!.prRefs = ['https://github.com/acme/demo-project/pull/6']
    const inRange = buildFixtureCachedTurn(1, 'Add the new endpoint')
    file.turns.push(inRange)

    store.portIn({ ...baseInput, verdict: 'new', cachedFile: file })

    const narrow = { range: defaultRange(new Date('2026-07-06T00:00:00.000Z'), 7) }
    const actual = buildSessionSummaries(store, narrow)
    expect(actual).toHaveLength(1)
    const session = actual[0]!
    expect(session.turns).toHaveLength(1)
    expect(session.turns[0]!.prRefs).toBeUndefined()
    expect(session.prRefsAtRangeStart).toEqual(['https://github.com/acme/demo-project/pull/6'])
    expect(session.totalInputTokens).toBe(100)
    expect(session.firstTimestamp).toBe('2026-07-01T09:11:00.000Z')

    const empty = buildSessionSummaries(store, { range: defaultRange(new Date('2026-06-01T00:00:00.000Z'), 7) })
    expect(empty).toEqual([])

    store.close()
  })

  it('filters by provider at the SQL read: only that provider’s sessions survive', () => {
    const store = makeStore()
    store.portIn({ ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })
    store.portIn({
      ...baseInput,
      provider: 'codex',
      envFingerprint: 'env-demo',
      filePath: '/Users/demo/.codex/other/sess-0.jsonl',
      verdict: 'new',
      cachedFile: buildFixtureCachedFile(),
    })

    const opencode = buildSessionSummaries(store, { range: FULL_RANGE, provider: 'opencode' })
    const codex = buildSessionSummaries(store, { range: FULL_RANGE, provider: 'codex' })
    const all = buildSessionSummaries(store, { range: FULL_RANGE })

    expect(opencode).toHaveLength(1)
    expect(codex).toHaveLength(1)
    expect(all).toHaveLength(2)
    // Same session_id across providers stays distinct (keyed by source + id).
    expect(opencode[0]!.sessionId).toBe(codex[0]!.sessionId)

    store.close()
  })

  it('a configured price override reprices display cost on read without touching stored rows', () => {
    const store = makeStore()
    store.portIn({ ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })

    store.setPriceOverride('demo-model', { inputPricePerMillion: 3, outputPricePerMillion: 15 })

    // Session summaries carry the display (repriced) cost, mirroring the
    // Models lens (override on the effective model; input+output only).
    const scope = buildSessionSummaries(store, { range: FULL_RANGE })
    expect(scope[0]!.totalCostUSD).toBeCloseTo(0.00105, 9)

    const calls = queryScope(store, { range: FULL_RANGE }).calls
    expect(calls).toHaveLength(1)
    // Models-lens override: input 100 @ $3/M + output 50 @ $15/M = 0.0003 + 0.00075
    expect(calls[0]!.displayCostUSD).toBeCloseTo(0.00105, 9)
    expect(calls[0]!.baseCostUSD).toBeCloseTo(0.42, 6)

    store.close()
  })

  it('a configured model alias rewrites the model identity on read', () => {
    const store = makeStore()
    store.portIn({ ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })
    store.setModelAlias('demo-model', 'claude-sonnet-4.5')

    const calls = queryScope(store, { range: FULL_RANGE }).calls
    expect(calls[0]!.resolvedModel).toBe('claude-sonnet-4.5')
    expect(calls[0]!.model).toBe('demo-model')

    store.close()
  })

  it('an Alias merges identity and reprices the session summary (no rescan)', () => {
    const store = makeStore()
    store.portIn({ ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })
    store.setModelAlias('demo-model', 'claude-sonnet-4-6')

    const summaries = buildSessionSummaries(store, { range: FULL_RANGE })
    expect(summaries).toHaveLength(1)
    const summary = summaries[0]!
    // Identity merges into the target everywhere except Compare/audit.
    expect(summary.turns[0]!.assistantCalls[0]!.model).toBe('claude-sonnet-4-6')
    expect(summary.turns[0]!.assistantCalls[0]!.rawModel).toBe('demo-model')
    // Cost reprices through the target's rate card (the scan priced the raw
    // name at its stored base); the stored row is untouched.
    expect(summary.totalCostUSD).not.toBeCloseTo(0.42, 6)
    expect(summary.totalCostUSD).toBeGreaterThan(0)
    expect(summary.totalCostUSD).toBeCloseTo(queryScope(store, { range: FULL_RANGE }).calls[0]!.displayCostUSD, 9)
    // Provenance survives on the merged breakdown row.
    const keys = Object.keys(summary.modelBreakdown)
    expect(keys).toHaveLength(1)
    expect(summary.modelBreakdown[keys[0]!]!.sourceModels).toEqual(['demo-model'])

    const rows = buildSessionRows(store, { range: FULL_RANGE })
    expect(rows[0]!.cost).toBeCloseTo(summary.totalCostUSD, 9)
    expect(rows[0]!.models).toEqual(keys)

    store.close()
  })

  it('a Price override on the effective model wins over the Alias', () => {
    const store = makeStore()
    store.portIn({ ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })
    store.setModelAlias('demo-model', 'claude-sonnet-4-6')
    store.setPriceOverride('claude-sonnet-4-6', { inputPricePerMillion: 3, outputPricePerMillion: 15 })

    // Fixture usage: input 100, output 50 → 0.0003 + 0.00075.
    const summaries = buildSessionSummaries(store, { range: FULL_RANGE })
    expect(summaries[0]!.totalCostUSD).toBeCloseTo(0.00105, 9)
    expect(queryScope(store, { range: FULL_RANGE }).calls[0]!.displayCostUSD).toBeCloseTo(0.00105, 9)

    store.close()
  })

  it('an Alias matches provider-prefixed, pinned and cased variants of the stored id', () => {
    const store = makeStore()
    const variants = [
      'Opencode/Demo-Model@20250929',
      'openrouter/opencode/demo-model',
      'demo-model:thinking',
    ]
    variants.forEach((model, i) => {
      const file = buildFixtureCachedFile()
      file.turns[0]!.calls[0]!.model = model
      store.portIn({ ...baseInput, filePath: `/cache/opencode/variant-${i}.jsonl`, verdict: 'new', cachedFile: file })
    })
    store.setModelAlias('demo-model', 'claude-sonnet-4-6')

    // Fixture usage: input 100, output 50, cache-read 20, repriced at the target's rates.
    const expected = calculateCost('claude-sonnet-4-6', 100, 50, 0, 20, 0, 'standard')
    expect(expected).toBeGreaterThan(0)
    const summaries = buildSessionSummaries(store, { range: FULL_RANGE })
    expect(summaries).toHaveLength(variants.length)
    for (const summary of summaries) {
      expect(summary.totalCostUSD).toBeCloseTo(expected, 9)
      expect(summary.turns[0]!.assistantCalls[0]!.model).toBe('claude-sonnet-4-6')
    }
    expect(summaries.map(s => s.turns[0]!.assistantCalls[0]!.rawModel).sort()).toEqual([...variants].sort())

    store.close()
  })

  it('a Price override matches variant spellings of the effective model', () => {
    const store = makeStore()
    const file = buildFixtureCachedFile()
    file.turns[0]!.calls[0]!.model = 'DEMO-MODEL'
    store.portIn({ ...baseInput, verdict: 'new', cachedFile: file })
    store.setPriceOverride('demo-model', { inputPricePerMillion: 3, outputPricePerMillion: 15 })

    // Fixture usage: input 100, output 50 → 0.0003 + 0.00075 (input+output only).
    const summaries = buildSessionSummaries(store, { range: FULL_RANGE })
    expect(summaries[0]!.totalCostUSD).toBeCloseTo(0.00105, 9)

    store.close()
  })

  it('removing custom pricing reverts honestly to the unpriced treatment', () => {
    const store = makeStore()
    store.portIn({ ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })
    store.setModelAlias('demo-model', 'claude-sonnet-4-6')
    store.setPriceOverride('claude-sonnet-4-6', { inputPricePerMillion: 3, outputPricePerMillion: 15 })

    expect(buildSessionSummaries(store, { range: FULL_RANGE })[0]!.totalCostUSD).toBeCloseTo(0.00105, 9)

    store.removePriceOverride('claude-sonnet-4-6')
    store.removeModelAlias('demo-model')

    const summaries = buildSessionSummaries(store, { range: FULL_RANGE })
    expect(summaries[0]!.totalCostUSD).toBeCloseTo(0.42, 6)
    expect(summaries[0]!.turns[0]!.assistantCalls[0]!.model).toBe('demo-model')
    expect(summaries[0]!.turns[0]!.assistantCalls[0]!.rawModel).toBeUndefined()
    expect(Object.keys(summaries[0]!.modelBreakdown)).toEqual(['demo-model'])

    store.close()
  })

  it('Scope filtering still applies under custom pricing', () => {
    const store = makeStore()
    store.portIn({ ...baseInput, verdict: 'new', cachedFile: buildFixtureCachedFile() })
    store.portIn({
      ...baseInput,
      provider: 'codex',
      envFingerprint: 'env-demo',
      filePath: '/Users/demo/.codex/other/sess-0.jsonl',
      verdict: 'new',
      cachedFile: buildFixtureCachedFile(),
    })
    store.setPriceOverride('demo-model', { inputPricePerMillion: 3, outputPricePerMillion: 15 })

    const opencode = buildSessionSummaries(store, { range: FULL_RANGE, provider: 'opencode' })
    const codex = buildSessionSummaries(store, { range: FULL_RANGE, provider: 'codex' })
    expect(opencode).toHaveLength(1)
    expect(codex).toHaveLength(1)
    expect(opencode[0]!.totalCostUSD).toBeCloseTo(0.00105, 9)
    expect(codex[0]!.totalCostUSD).toBeCloseTo(0.00105, 9)

    store.close()
  })

  it('pushes provider + range into SQL: untouched sessions never load, seeding survives', () => {
    const store = makeStore()
    // An old claude session (out of range), a recent claude session with a
    // pre-range PR turn, and a recent opencode session.
    const oldFile = buildFixtureCachedFile()
    oldFile.turns[0]!.calls[0]!.timestamp = '2026-06-01T09:00:00.000Z'
    oldFile.turns[0]!.timestamp = '2026-06-01T09:00:00.000Z'
    store.portIn({ ...baseInput, provider: 'claude', envFingerprint: 'env-demo', filePath: '/cache/claude/old.jsonl', verdict: 'new', cachedFile: oldFile })

    const recentFile = buildFixtureCachedFile()
    recentFile.turns[0]!.calls[0]!.timestamp = '2026-06-28T09:00:00.000Z'
    recentFile.turns[0]!.timestamp = '2026-06-28T09:00:00.000Z'
    recentFile.turns[0]!.prRefs = ['https://github.com/acme/demo-project/pull/6']
    const inRangeTurn = buildFixtureCachedTurn(1, 'Follow-up')
    recentFile.turns.push(inRangeTurn)
    store.portIn({ ...baseInput, provider: 'claude', envFingerprint: 'env-demo', filePath: '/cache/claude/recent.jsonl', verdict: 'new', cachedFile: recentFile })

    const otherFile = buildFixtureCachedFile()
    store.portIn({ ...baseInput, provider: 'opencode', envFingerprint: 'env-demo', filePath: '/cache/opencode/other.jsonl', verdict: 'new', cachedFile: otherFile })

    const july = { range: defaultRange(new Date('2026-07-06T00:00:00.000Z'), 7), provider: 'claude' }
    const scope = queryScope(store, july)
    // The old session has no in-range calls: its rows never load, while the
    // recent session loads with its FULL history (pre-range PR turn intact).
    expect(new Set(scope.sessions.map(s => s.sessionId))).toEqual(new Set(['sess-0']))
    expect(scope.turns.filter(t => t.timestamp.startsWith('2026-06-01'))).toEqual([])

    const summaries = buildSessionSummaries(store, july)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.turns).toHaveLength(1)
    expect(summaries[0]!.prRefsAtRangeStart).toEqual(['https://github.com/acme/demo-project/pull/6'])

    store.close()
  })

  it('the Sessions payload (`SessionRow[]`) is byte-identical to the old `aggregateSessions` rows', () => {
    const store = makeStore()
    const file = buildFixtureCachedFile()
    store.portIn({ ...baseInput, verdict: 'new', cachedFile: file })

    const actual = buildSessionRows(store, { range: FULL_RANGE })
    // The report-shaped reference: the old view path projects the old-path
    // summaries (already proven byte-equal to the seam) into SessionRow[].
    const expected = aggregateSessions([
      { project: 'demo-project', projectPath: '/workspace/demo-project', totalCostUSD: 0.42, totalSavingsUSD: 0, totalEstimatedCostUSD: 0, totalApiCalls: 1, totalProxiedCostUSD: 0, sessions: oldPathSummaries(file) },
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

    store.close()
  })
})
