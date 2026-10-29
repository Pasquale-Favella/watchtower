/**
 * Purpose-shaped ledger reads: the narrow read is correct, and the wire did not
 * move.
 *
 * The claim under test is NOT "the narrow read is faster" (that is
 * `scripts/measure-query-path.cjs`'s job) and NOT "the SQL still works"
 * (`tests/ledger.test.ts` already locks that through the facade). The claim is
 * narrower and falsifiable:
 *
 *  1. **The narrow read is exactly the kept set.** `LedgerQueries.getCallFacts`
 *     returns 29 of `getCalls`'s 38 columns, and the nine it drops are absent
 *     from the row — asserted by key set, and made non-vacuous by asserting the
 *     WIDE read still carries all nine with the values port-in wrote.
 *  2. **Dropped fields have explicit consumers.** The consumer inventory is
 *     scanned on disk. Optimize can consume its optional focused diagnostics;
 *     the default snapshot still excludes those fields. A sibling test checks
 *     the scanner against a probe containing dropped fields.
 *  3. **A consumer needing a dropped field still gets it.** `getCalls` is the
 *     fallback and the measurement baseline; it is unchanged, and
 *     `tests/ledger.test.ts:209` independently pins `callKey` on it.
 *  4. **The wire is byte-identical.** Three Section payloads and the seam's own
 *     `SessionSummary[]` are compared against literals captured from THIS tree
 *     before `getCallFacts` existed. `queryScope`'s `calls` legitimately change
 *     shape — that is the slice — so they are asserted as "the wide row minus
 *     exactly the nine dropped keys" instead, which is a stronger statement
 *     than a literal.
 *
 * The dedicated test TypeScript config checks the fixtures and casts. No
 * `process.env` is mutated anywhere in this file.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import { queryOverview } from '../src/core/application/queries/overview-query.js'
import { PricingDiagnostics } from '../src/core/ports/pricing-diagnostics.js'
import { querySessionDetail } from '../src/core/application/queries/session-detail-query.js'
import { queryDashboardViews } from '../src/core/application/queries/view-queries.js'
import {
  captureLocalModelSavings,
  captureModelPricingCatalogue,
  captureProxyPaths,
} from '../src/infrastructure/pricing/models.js'
import { sessionRowFromSummary } from '../src/infrastructure/ingestion/sessions-report.js'
import { CATEGORY_LABELS, type SessionSummary } from '../src/core/domain/observations/types.js'
import {
  buildSessionSummariesFromSnapshot,
  buildSessionSummariesFromSnapshotResult,
  queryScopeFromSnapshotResult,
} from '../src/core/analytics/projections/aggregate-calculation.js'
import { LedgerConfig, LedgerIngest, LedgerQueries } from '../src/core/ports/repository.js'
import {
  loadLedgerQuerySnapshotEffect,
  makeLedgerQuerySnapshot,
} from '../src/core/application/queries/ledger-query-snapshot.js'
import type { LedgerCallFactsRow } from '../src/core/analytics/projections/read-projections.js'
import type { EngineRuntime, EngineServices } from '../src/infrastructure/runtime/engine-runtime.js'
import { sessionDetailSchema } from '../src/shared/schemas/views.js'
import { buildFixtureCachedFile, buildFixtureCachedTurn, FIXTURE_SOURCE_PATH } from './fixtures/cached-file.js'
import { openLedgerFixture, viewInputs } from './fixtures/ledger-runtime.js'

/** The nine `ledger_call` columns `getCallFacts` does not select. */
const DROPPED_CALL_FIELDS = [
  'callKey',
  'projectPath',
  'agentType',
  'locAdded',
  'locRemoved',
  'interrupted',
  'userModified',
  'toolErrors',
  'editFailed',
] as const

/** The twenty-nine it does. */
const KEPT_CALL_FIELDS = [
  'sourceId',
  'sessionId',
  'turnIndex',
  'callIndex',
  'dedupKey',
  'provider',
  'model',
  'timestamp',
  'speed',
  'project',
  'workingDirectory',
  'baseCostUSD',
  'isEstimated',
  'savingsUSD',
  'savingsBaselineModel',
  'inputTokens',
  'outputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens',
  'cachedInputTokens',
  'reasoningTokens',
  'webSearchRequests',
  'cacheCreationOneHourTokens',
  'tools',
  'mcpTools',
  'skills',
  'subagentTypes',
  'bashCommands',
  'toolSequence',
] as const

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The files that consume the `queryScope` seam's rows. A dropped column any of
 *  them read would make the narrow read wrong, so the whole consumer set is
 *  scanned rather than the handful this slice edited. */
const CONSUMER_FILES = [
  'src/core/analytics/projections/aggregate-calculation.ts',
  'src/core/analytics/projections/views-calculation.ts',
  'src/core/domain/sessions/canonical-session-project.ts',
  'src/core/analytics/projections/session-detail-calculation.ts',
  'src/core/analytics/projections/session-search-calculation.ts',
  'src/core/analytics/projections/store-rows-calculation.ts',
  'src/core/analytics/projections/ledger-mcp-calculation.ts',
  'src/core/analytics/projections/overview-calculation.ts',
  'src/core/domain/sessions/overview-scope.ts',
  'src/core/analytics/projections/models-calculation.ts',
  'src/core/analytics/projections/spend-calculation.ts',
  'src/core/analytics/projections/compare-calculation.ts',
  'src/core/analytics/attribution/yield-calculation.ts',
  'src/core/analytics/detectors/optimize-calculation.ts',
  'src/core/analytics/detectors/skills-calculation.ts',
  'src/core/analytics/projections/sessions-calculation.ts',
  'src/core/analytics/projections/pull-requests-calculation.ts',
  'src/core/analytics/projections/export-calculation.ts',
  'src/infrastructure/ingestion/sessions-report.ts',
  'src/core/analytics/attribution/pr-attribution.ts',
  'src/core/domain/sessions/session-row.ts',
  'src/core/ingestion/normalization/parser-calculations.ts',
  'src/platform/mcp/tools.ts',
]

const RANGE = {
  start: new Date('2026-06-01T00:00:00.000Z'),
  end: new Date('2026-08-01T00:00:00.000Z'),
}

/** A fixture that populates every column the narrow read drops, so "the narrow
 *  read does not return them" is a statement about rows that HAVE them. */
function richFixture() {
  const file = buildFixtureCachedFile()
  const call = file.turns[0]!.calls[0]!
  call.project = 'call-level-project'
  call.projectPath = '/call/level/path'
  call.locAdded = 12
  call.locRemoved = 3
  call.interrupted = true
  call.userModified = true
  call.toolErrors = 2
  call.editFailed = 1
  file.agentType = 'workflow-subagent'
  const turn1 = buildFixtureCachedTurn(1, 'Add the endpoint')
  turn1.calls[0]!.bashCommands = ['npm test']
  turn1.calls[0]!.toolSequence = [[{ tool: 'Edit', file: 'src/api.ts' }]]
  turn1.calls[0]!.skills = ['demo-skill']
  turn1.calls[0]!.subagentTypes = ['general']
  turn1.prRefs = ['https://github.com/acme/demo-project/pull/7']
  file.turns.push(turn1)
  return file
}

function portRich(runtime: EngineRuntime): void {
  runtime.runSync(
    Effect.flatMap(LedgerIngest, ingest =>
      ingest.portIn({
        provider: 'opencode',
        envFingerprint: 'env-narrow',
        filePath: FIXTURE_SOURCE_PATH,
        verdict: 'new',
        cachedFile: richFixture(),
      }),
    ),
  )
}

/** The narrow read through the REAL port — repository, SqlClient, node:sqlite
 *  and the row schema — over the fixture runtime's writer connection, not
 *  through a hand-made array (the same native runtime used by
 *  `tests/ledger-repository-ports.test.ts`). */
function readCallFacts(runtime: EngineRuntime): Promise<LedgerCallFactsRow[]> {
  return runtime.runPromise(Effect.flatMap(LedgerQueries, queries => queries.getCallFacts()))
}

function snapshotFor(runtime: EngineRuntime) {
  return runtime.runSync(loadLedgerQuerySnapshotEffect(viewInputs({ period: 'lifetime' })))
}

function readCalls(runtime: EngineRuntime) {
  return runtime.runSync(Effect.flatMap(LedgerQueries, queries => queries.getCalls()))
}

function sessionDetail(runtime: EngineRuntime, sessionId: string) {
  return runtime.runPromise(
    querySessionDetail({ catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths(), sessionId }).pipe(
      Effect.provideService(PricingDiagnostics, PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void })),
    ),
  )
}

/** Independent pre-slice detail oracle, rebuilt from the native decoded ports. */
function legacySessionDetail(runtime: EngineRuntime, sessionId: string) {
  const { catalogue, proxyPaths } = viewInputs({ period: 'lifetime' })
  const snapshot = runtime.runSync(
    Effect.gen(function* () {
      const queries = yield* LedgerQueries
      const config = yield* LedgerConfig
      const [sources, sessions, turns, calls, aliases, overrides] = yield* Effect.all([
        queries.getSources(),
        queries.getSessions(),
        queries.getTurns(),
        queries.getCallFacts(),
        config.getModelAliases(),
        config.getPriceOverrides(),
      ])
      return makeLedgerQuerySnapshot({
        sources,
        sessions,
        turns,
        calls,
        aliases,
        overrides,
        catalogue,
        proxyPaths,
      })
    }),
  )
  const session = buildSessionSummariesFromSnapshot(snapshot, {
    range: { start: new Date(-8640000000000000), end: new Date(8640000000000000) },
  }).find(summary => summary.sessionId === sessionId)
  return session ? Schema.decodeUnknownSync(sessionDetailSchema)(legacyDetailFromSummary(session)) : null
}

function legacyDetailFromSummary(session: SessionSummary) {
  const provider = sessionRowFromSummary(session, session.project).provider
  return {
    sessionId: session.sessionId,
    project: session.project,
    provider,
    title: session.title ?? '',
    workingDirectory: session.workingDirectory,
    firstTimestamp: session.firstTimestamp,
    lastTimestamp: session.lastTimestamp,
    totalCostUSD: session.totalCostUSD,
    totalEstimatedCostUSD: session.totalEstimatedCostUSD ?? 0,
    totalSavingsUSD: session.totalSavingsUSD,
    totalInputTokens: session.totalInputTokens,
    totalOutputTokens: session.totalOutputTokens,
    totalCacheReadTokens: session.totalCacheReadTokens,
    totalCacheWriteTokens: session.totalCacheWriteTokens,
    totalReasoningTokens: session.totalReasoningTokens,
    apiCalls: session.apiCalls,
    prLinks: session.prLinks ?? [],
    modelBreakdown: Object.fromEntries(
      Object.entries(session.modelBreakdown).map(([model, breakdown]) => [
        model,
        { calls: breakdown.calls, costUSD: breakdown.costUSD },
      ]),
    ),
    turns: session.turns.map(turn => ({
      timestamp: turn.timestamp,
      userMessage: turn.userMessage,
      category: CATEGORY_LABELS[turn.category] ?? turn.category,
      gitBranch: turn.gitBranch,
      prRefs: turn.prRefs ?? [],
      retries: turn.retries,
      hasEdits: turn.hasEdits,
      assistantCalls: turn.assistantCalls.map(call => ({
        provider: call.provider,
        model: call.model,
        costUSD: call.costUSD,
        isEstimated: call.isEstimated,
        savingsUSD: call.savingsUSD,
        speed: call.speed,
        hasPlanMode: call.hasPlanMode,
        tools: call.tools,
        mcpTools: call.mcpTools,
        skills: call.skills,
        subagentTypes: call.subagentTypes,
        usage: {
          inputTokens: call.usage.inputTokens,
          outputTokens: call.usage.outputTokens,
          reasoningTokens: call.usage.reasoningTokens,
          cacheReadInputTokens: call.usage.cacheReadInputTokens,
          cacheCreationInputTokens: call.usage.cacheCreationInputTokens,
        },
      })),
    })),
  }
}

function runWorkerQuery<A, E, R>(runtime: EngineRuntime, effect: Effect.Effect<A, E, R>): Promise<A> {
  return runtime.runPromise(effect as Effect.Effect<A, E, EngineServices>)
}

describe("the purpose-shaped call read selects exactly the aggregation seam's columns", () => {
  it('returns the 29 kept fields and none of the 9 dropped ones', async () => {
    const { runtime } = openLedgerFixture()
    portRich(runtime)

    const narrow = await readCallFacts(runtime)
    const wide = readCalls(runtime)

    expect(narrow.length).toBe(wide.length)
    expect(narrow.length).toBeGreaterThan(0)
    expect(Object.keys(narrow[0]!).sort()).toEqual([...KEPT_CALL_FIELDS].sort())
    for (const field of DROPPED_CALL_FIELDS) {
      expect(Object.keys(narrow[0]!)).not.toContain(field)
    }
  })

  it('the wide read still carries every dropped column with the ported value', () => {
    const { runtime } = openLedgerFixture()
    portRich(runtime)

    const wide = readCalls(runtime)
    const first = wide.find(call => call.callIndex === 0)!
    expect(wide.length).toBeGreaterThan(0)
    // 38 columns, machine-checked rather than remembered: the split's whole
    // claim is "29 of 38", and a silent DDL change would move this number.
    expect(Object.keys(first).length).toBe(38)
    expect(first.callKey).toBe('call-1')
    expect(first.projectPath).toBe('/call/level/path')
    expect(first.agentType).toBe('workflow-subagent')
    expect(first.locAdded).toBe(12)
    expect(first.locRemoved).toBe(3)
    expect(first.interrupted).toBe(1)
    expect(first.userModified).toBe(1)
    expect(first.toolErrors).toBe(2)
    expect(first.editFailed).toBe(1)
  })

  it('every kept field is value-identical to the wide read (no silent reshaping)', async () => {
    const { runtime } = openLedgerFixture()
    portRich(runtime)

    const narrow = await readCallFacts(runtime)
    const wide = readCalls(runtime)
    const keyOf = (row: { sourceId: number; sessionId: string; turnIndex: number; callIndex: number }) =>
      `${row.sourceId}\0${row.sessionId}\0${row.turnIndex}\0${row.callIndex}`
    const wideByKey = new Map(wide.map(row => [keyOf(row), row]))

    expect(narrow).toHaveLength(wide.length)
    for (const row of narrow) {
      const reference = wideByKey.get(keyOf(row))
      expect(reference).toBeDefined()
      for (const field of KEPT_CALL_FIELDS) {
        expect(row[field]).toEqual(reference![field])
      }
    }
  })
})

describe('dropped columns require explicit focused consumers', () => {
  /** Every `RECEIVER.field` occurrence of a dropped name, as `file:receiver`.
   *  Pinning the inventory rather than asserting "no hits" is what makes this a
   *  proof: `projectPath` and `agentType` DO appear in the consumer set, always
   *  on a session / project / summary row, and a future call-row read would
   *  show up here as a receiver that is not in the expected list. */
  function droppedFieldReceivers(): Record<string, string[]> {
    const found: Record<string, string[]> = {}
    for (const field of DROPPED_CALL_FIELDS) {
      const hits = new Set<string>()
      for (const relative of CONSUMER_FILES) {
        const source = readFileSync(join(REPO_ROOT, relative), 'utf8')
        const pattern = new RegExp(`([A-Za-z_$][A-Za-z0-9_$]*)\\.${field}\\b`, 'g')
        for (const match of source.matchAll(pattern)) hits.add(`${relative}:${match[1]}`)
      }
      found[field] = [...hits].sort()
    }
    return found
  }

  it('pins existing identity readers and the opted-in Optimize diagnostics', () => {
    expect(droppedFieldReceivers()).toEqual({
      callKey: [],
      projectPath: [
        'src/core/analytics/detectors/optimize-calculation.ts:a',
        'src/core/analytics/detectors/optimize-calculation.ts:b',
        'src/core/analytics/detectors/optimize-calculation.ts:p',
        'src/core/analytics/detectors/optimize-calculation.ts:project',
        'src/core/analytics/projections/aggregate-calculation.ts:s',
        'src/core/analytics/projections/store-rows-calculation.ts:canonical',
        'src/core/analytics/projections/store-rows-calculation.ts:item',
        'src/core/analytics/projections/store-rows-calculation.ts:session',
        'src/core/analytics/projections/views-calculation.ts:session',
        'src/core/domain/sessions/canonical-session-project.ts:session',
      ],
      agentType: [
        'src/core/analytics/projections/aggregate-calculation.ts:session',
        'src/core/analytics/projections/aggregate-calculation.ts:summary',
      ],
      locAdded: [],
      locRemoved: [],
      interrupted: [
        'src/core/analytics/detectors/optimize-calculation.ts:c',
        'src/core/analytics/projections/aggregate-calculation.ts:call',
        'src/core/analytics/projections/aggregate-calculation.ts:row',
      ],
      userModified: [
        'src/core/analytics/projections/aggregate-calculation.ts:call',
        'src/core/analytics/projections/aggregate-calculation.ts:row',
      ],
      toolErrors: [
        'src/core/analytics/detectors/optimize-calculation.ts:c',
        'src/core/analytics/projections/aggregate-calculation.ts:call',
        'src/core/analytics/projections/aggregate-calculation.ts:row',
      ],
      editFailed: [
        'src/core/analytics/detectors/optimize-calculation.ts:c',
        'src/core/analytics/projections/aggregate-calculation.ts:call',
        'src/core/analytics/projections/aggregate-calculation.ts:row',
      ],
    })
  })

  it('the scan is not vacuous: a dropped name on a call row IS found when present', () => {
    const probe = 'const a = row.locAdded\nconst b = call.projectPath\n'
    const found = DROPPED_CALL_FIELDS.filter(field => new RegExp(`[A-Za-z_$][A-Za-z0-9_$]*\\.${field}\\b`).test(probe))
    expect(found).toEqual(['projectPath', 'locAdded'])
  })

  it('the behavioural backstop: the dropped values are IN the ledger and appear nowhere downstream', async () => {
    const { runtime } = openLedgerFixture()
    portRich(runtime)

    // The fixture gives every dropped column a non-default value, and the wide
    // read returns all nine of them...
    const wide = readCalls(runtime)
    expect(wide[0]!.projectPath).toBe('/call/level/path')
    expect(wide[0]!.locAdded).toBe(12)
    expect(wide[0]!.locRemoved).toBe(3)
    expect(wide[0]!.toolErrors).toBe(2)
    expect(wide[0]!.editFailed).toBe(1)

    // ...while nothing the consumers see carries the one value that could only
    // have come from a dropped column. If any of them read one, this trips.
    const downstream = JSON.stringify([
      buildSessionSummariesFromSnapshotResult(snapshotFor(runtime), { range: RANGE }).summaries,
      await runWorkerQuery(runtime, queryDashboardViews(viewInputs({ period: 'lifetime' }))),
      await sessionDetail(runtime, 'sess-0'),
    ])
    expect(downstream).not.toContain('/call/level/path')
  })
})

describe('the wire is unchanged: payloads deep-equal their pre-slice shape', () => {
  it('querySessionDetail — the Session detail wire payload', async () => {
    const { runtime } = openLedgerFixture()
    portRich(runtime)
    const actual = await sessionDetail(runtime, 'sess-0')
    expect(actual).toEqual(SESSION_DETAIL)
    expect(actual).toStrictEqual(legacySessionDetail(runtime, 'sess-0'))
  })

  it('queryDashboardViews — the store:views wire payload', async () => {
    const { runtime } = openLedgerFixture()
    portRich(runtime)
    await expect(runWorkerQuery(runtime, queryDashboardViews(viewInputs({ period: 'lifetime' })))).resolves.toEqual(
      DASHBOARD_VIEWS,
    )
  })

  it('queryOverview, on a custom range so no local-date dependency', async () => {
    const { runtime } = openLedgerFixture()
    portRich(runtime)
    const scope = { period: 'all' as const, range: { since: '2026-07-01', until: '2026-07-02' } }
    const inputs = {
      ...viewInputs(scope),
      localSavings: captureLocalModelSavings(),
    }
    await expect(runWorkerQuery(runtime, queryOverview(inputs))).resolves.toEqual(OVERVIEW_PAYLOAD)
  })

  it('buildSessionSummariesFromSnapshotResult — every Section payload is a projection of this', () => {
    const { runtime } = openLedgerFixture()
    portRich(runtime)
    expect(buildSessionSummariesFromSnapshotResult(snapshotFor(runtime), { range: RANGE }).summaries).toEqual(SUMMARIES)
  })

  it('queryScope: sessions and turns unchanged, calls narrowed by exactly the nine', () => {
    const { runtime } = openLedgerFixture()
    portRich(runtime)

    const scope = queryScopeFromSnapshotResult(snapshotFor(runtime), { range: RANGE }).scope
    expect(scope.sessions).toEqual(SCOPE_SESSIONS)
    expect(scope.turns).toEqual(SCOPE_TURNS)

    // The call rows are the slice's subject, so they are pinned to the wide
    // read MINUS the declared drop set: every kept value identical, every
    // dropped key gone, and the two query-time fields the seam adds unchanged.
    const wide = readCalls(runtime)
    expect(scope.calls).toHaveLength(wide.length)
    for (const [index, call] of scope.calls.entries()) {
      const reference = wide[index]!
      for (const field of KEPT_CALL_FIELDS) expect(call[field]).toEqual(reference[field])
      expect(call.resolvedModel).toBe(reference.model)
      expect(call.displayCostUSD).toBe(reference.baseCostUSD)
      expect(Object.keys(call).sort()).toEqual([...KEPT_CALL_FIELDS, 'resolvedModel', 'displayCostUSD'].sort())
    }
  })
})

// ── Pre-slice shapes ────────────────────────────────────────────────────────
// Captured from this tree BEFORE `getCallFacts` existed, by running the same
// builders against `richFixture()` and serialising the result. If a narrowing
// ever moved the wire, one of these stops matching — which is the property this
// slice is accountable for.

const SESSION_DETAIL: unknown = {
  sessionId: 'sess-0',
  project: 'demo-project',
  provider: 'opencode',
  title: 'Refactor the auth module',
  firstTimestamp: '2026-07-01T09:00:00.000Z',
  lastTimestamp: '2026-07-01T09:11:00.000Z',
  totalCostUSD: 0.84,
  totalEstimatedCostUSD: 0,
  totalSavingsUSD: 0,
  totalInputTokens: 200,
  totalOutputTokens: 100,
  totalCacheReadTokens: 40,
  totalCacheWriteTokens: 0,
  totalReasoningTokens: 10,
  apiCalls: 2,
  prLinks: ['https://github.com/acme/demo-project/pull/7'],
  modelBreakdown: { 'demo-model': { calls: 2, costUSD: 0.84 } },
  turns: [
    {
      timestamp: '2026-07-01T09:00:00.000Z',
      userMessage: 'Refactor the auth module',
      category: 'Refactoring',
      prRefs: [],
      retries: 0,
      hasEdits: true,
      assistantCalls: [
        {
          provider: 'opencode',
          model: 'demo-model',
          costUSD: 0.42,
          speed: 'standard',
          hasPlanMode: false,
          tools: ['Edit'],
          mcpTools: [],
          skills: [],
          subagentTypes: [],
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            reasoningTokens: 5,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 0,
          },
        },
      ],
    },
    {
      timestamp: '2026-07-01T09:11:00.000Z',
      userMessage: 'Add the endpoint',
      category: 'Feature Dev',
      prRefs: ['https://github.com/acme/demo-project/pull/7'],
      retries: 0,
      hasEdits: true,
      assistantCalls: [
        {
          provider: 'opencode',
          model: 'demo-model',
          costUSD: 0.42,
          speed: 'standard',
          hasPlanMode: false,
          tools: ['Edit'],
          mcpTools: [],
          skills: ['demo-skill'],
          subagentTypes: ['general'],
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            reasoningTokens: 5,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 0,
          },
        },
      ],
    },
  ],
}

const DASHBOARD_VIEWS: unknown = {
  kpis: {
    totalCost: 0.84,
    totalEstimatedCost: 0,
    totalSavings: 0,
    totalProxiedCost: 0,
    totalCalls: 2,
    totalSessions: 1,
    totalProjects: 1,
    totalInputTokens: 200,
    totalOutputTokens: 100,
    totalCacheReadTokens: 40,
    totalCacheWriteTokens: 0,
    totalReasoningTokens: 10,
  },
  costOverTime: [{ date: '2026-07-01', cost: 0.84 }],
  byProvider: [{ name: 'opencode', cost: 0.84, calls: 2, sessions: 1 }],
  byModel: [{ name: 'demo-model', cost: 0.84, calls: 2 }],
  byProject: [{ name: 'demo-project', cost: 0.84, calls: 2 }],
  byCategory: [
    { name: 'Refactoring', cost: 0.42, turns: 1 },
    { name: 'Feature Dev', cost: 0.42, turns: 1 },
  ],
}

const OVERVIEW_PAYLOAD: unknown = {
  kpis: {
    cost: 0.84,
    calls: 2,
    sessions: 1,
    inputTokens: 200,
    outputTokens: 100,
    cacheReadTokens: 40,
    cacheWriteTokens: 0,
    savingsUSD: 0,
    estimatedCostUSD: 0,
    oneShotRate: 1,
    cacheHitPercent: 16.666666666666664,
  },
  daily: [
    { date: '2026-07-01', costUSD: 0.84, calls: 2, sessions: 1 },
    { date: '2026-07-02', costUSD: 0, calls: 0, sessions: 0 },
  ],
  dataStart: '2026-07-01',
  models: [{ name: 'demo-model', cost: 0.84, calls: 2, inputTokens: 200, outputTokens: 100, savingsUSD: 0 }],
  activities: [
    { name: 'Refactoring', cost: 0.42, turns: 1, oneShotRate: 1 },
    { name: 'Feature Dev', cost: 0.42, turns: 1, oneShotRate: 1 },
  ],
  tools: [{ name: 'Edit', calls: 2 }],
  mcpServers: [],
  skills: [{ name: 'demo-skill', turns: 1, cost: 0.42 }],
  subagents: [{ name: 'general', calls: 1, cost: 0.42 }],
  efficiency: {
    score: 75,
    grade: 'B',
    oneShotRate: 1,
    retryTax: { totalUSD: 0, retries: 0, editTurns: 0, byModel: [] },
    routingWaste: { baselineModel: '', baselineCostPerEdit: 0, totalSavingsUSD: 0, byModel: [] },
    pricingCoverage: 1,
  },
  workflow: {
    corrections: 0,
    userTurns: 2,
    correctionRate: 0,
    medianTimeToFirstEditMs: 0,
    topReworkedFiles: [{ path: 'api.ts', sessions: 1, edits: 1 }],
  },
  unpricedModels: [],
  localModelSavings: { totalUSD: 0, calls: 0, byModel: [], byProvider: [] },
}

const SCOPE_SESSIONS: unknown = [
  {
    sourceId: 1,
    sessionId: 'sess-0',
    project: 'demo-project',
    projectPath: '/workspace/demo-project',
    workingDirectory: null,
    canonicalProject: 'demo-project',
    canonicalCwd: '/workspace/demo-project',
    agentType: 'workflow-subagent',
    title: 'Refactor the auth module',
    prLinks: ['https://github.com/acme/demo-project/pull/7'],
    isSidechain: 0,
    parentSessionId: null,
    agentSpawnLinks: {},
    mcpInventory: [],
    ambiguousSpawnAgentIds: [],
    everHadBranch: 0,
  },
]

const SCOPE_TURNS: unknown = [
  {
    sourceId: 1,
    sessionId: 'sess-0',
    turnIndex: 0,
    timestamp: '2026-07-01T09:00:00.000Z',
    userMessage: 'Refactor the auth module',
    gitBranch: null,
    prRefs: [],
    spawnToolUseIds: [],
    category: 'refactoring',
    subCategory: null,
    retries: 0,
    hasEdits: 1,
  },
  {
    sourceId: 1,
    sessionId: 'sess-0',
    turnIndex: 1,
    timestamp: '2026-07-01T09:11:00.000Z',
    userMessage: 'Add the endpoint',
    gitBranch: null,
    prRefs: ['https://github.com/acme/demo-project/pull/7'],
    spawnToolUseIds: [],
    category: 'feature',
    subCategory: 'demo-skill',
    retries: 0,
    hasEdits: 1,
  },
]

const SUMMARIES: unknown = [
  {
    sourceId: 1,
    isSidechain: false,
    sessionId: 'sess-0',
    project: 'demo-project',
    firstTimestamp: '2026-07-01T09:00:00.000Z',
    lastTimestamp: '2026-07-01T09:11:00.000Z',
    totalCostUSD: 0.84,
    totalSavingsUSD: 0,
    totalEstimatedCostUSD: 0,
    totalInputTokens: 200,
    totalOutputTokens: 100,
    totalReasoningTokens: 10,
    totalCacheReadTokens: 40,
    totalCacheWriteTokens: 0,
    apiCalls: 2,
    turns: [
      {
        userMessage: 'Refactor the auth module',
        assistantCalls: [
          {
            provider: 'opencode',
            model: 'demo-model',
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 20,
              cachedInputTokens: 0,
              reasoningTokens: 5,
              webSearchRequests: 0,
            },
            costUSD: 0.42,
            tools: ['Edit'],
            mcpTools: [],
            skills: [],
            subagentTypes: [],
            hasAgentSpawn: false,
            hasPlanMode: false,
            speed: 'standard',
            timestamp: '2026-07-01T09:00:00.000Z',
            bashCommands: [],
            deduplicationKey: 'call-1',
          },
        ],
        timestamp: '2026-07-01T09:00:00.000Z',
        sessionId: 'sess-0',
        category: 'refactoring',
        retries: 0,
        hasEdits: true,
      },
      {
        userMessage: 'Add the endpoint',
        assistantCalls: [
          {
            provider: 'opencode',
            model: 'demo-model',
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 20,
              cachedInputTokens: 0,
              reasoningTokens: 5,
              webSearchRequests: 0,
            },
            costUSD: 0.42,
            tools: ['Edit'],
            mcpTools: [],
            skills: ['demo-skill'],
            subagentTypes: ['general'],
            hasAgentSpawn: false,
            hasPlanMode: false,
            speed: 'standard',
            timestamp: '2026-07-01T09:11:00.000Z',
            bashCommands: ['npm test'],
            deduplicationKey: 'call-2',
            toolSequence: [[{ tool: 'Edit', file: 'src/api.ts' }]],
          },
        ],
        timestamp: '2026-07-01T09:11:00.000Z',
        sessionId: 'sess-0',
        category: 'feature',
        retries: 0,
        hasEdits: true,
        prRefs: ['https://github.com/acme/demo-project/pull/7'],
        subCategory: 'demo-skill',
      },
    ],
    modelBreakdown: {
      'demo-model': {
        calls: 2,
        costUSD: 0.84,
        savingsUSD: 0,
        estimatedCostUSD: 0,
        tokens: {
          inputTokens: 200,
          outputTokens: 100,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 40,
          cachedInputTokens: 0,
          reasoningTokens: 10,
          webSearchRequests: 0,
        },
      },
    },
    toolBreakdown: { Edit: { calls: 2 } },
    mcpBreakdown: {},
    bashBreakdown: { 'npm test': { calls: 1 } },
    categoryBreakdown: {
      refactoring: { turns: 1, costUSD: 0.42, savingsUSD: 0, retries: 0, editTurns: 1, oneShotTurns: 1 },
      feature: { turns: 1, costUSD: 0.42, savingsUSD: 0, retries: 0, editTurns: 1, oneShotTurns: 1 },
    },
    skillBreakdown: { 'demo-skill': { turns: 1, costUSD: 0.42, savingsUSD: 0, editTurns: 1, oneShotTurns: 1 } },
    subagentBreakdown: { general: { calls: 1, costUSD: 0.42, savingsUSD: 0 } },
    title: 'Refactor the auth module',
    agentType: 'workflow-subagent',
    prLinks: ['https://github.com/acme/demo-project/pull/7'],
    projectKey: '/workspace/demo-project',
    projectPath: '/workspace/demo-project',
  },
]
