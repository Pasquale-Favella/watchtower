import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LedgerStore } from '../src/main/store/ledger.js'
import { buildSessionRows, buildSessionSummaries, defaultRange, queryScope } from '../src/main/store/aggregate.js'
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

    const scope = buildSessionSummaries(store, { range: FULL_RANGE })
    expect(scope[0]!.totalCostUSD).toBeCloseTo(0.42, 6)

    const calls = queryScope(store, { range: FULL_RANGE }).calls
    expect(calls).toHaveLength(1)
    // Non-Claude providers fold reasoning tokens into the output bucket:
    // input 100 @ $3/M + output (50+5) @ $15/M = 0.0003 + 0.000825
    expect(calls[0]!.displayCostUSD).toBeCloseTo(0.001125, 9)
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
