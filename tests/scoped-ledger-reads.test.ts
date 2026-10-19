import { DatabaseSync } from 'node:sqlite'

import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import { calculateComparePayload } from '../src/main/compare-calculation.js'
import { calculateModelsPayload } from '../src/main/models-calculation.js'
import { overviewDateRange } from '../src/main/overview-scope.js'
import { captureModelPricingCatalogue, captureProxyPaths } from '../src/main/pipeline/models.js'
import { calculatePullRequestsPayload } from '../src/main/pull-requests-calculation.js'
import { calculateSessionsView } from '../src/main/sessions-calculation.js'
import { calculateSpendView } from '../src/main/spend-calculation.js'
import { buildSessionSummariesFromSnapshotResult } from '../src/main/store/aggregate-calculation.js'
import { queryScopeFromSnapshotResult } from '../src/main/store/aggregate-calculation.js'
import { LedgerConfig, LedgerIngest, LedgerQueries } from '../src/main/store/ledger-ports.js'
import { loadLedgerQuerySnapshotEffect } from '../src/main/store/ledger-query-snapshot.js'
import { selectScopedSessionRows } from '../src/main/store/scoped-snapshot-sql.js'
import type { OverviewScope } from '../src/shared/schemas/overview.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, FIXTURE_SOURCE_PATH } from './fixtures/cached-file.js'
import { openLedgerFixture } from './fixtures/ledger-runtime.js'

function cachedFileAt(timestamp: string, model = 'demo-model') {
  const file = buildFixtureCachedFile()
  return {
    ...file,
    turns: file.turns.map(turn => ({
      ...turn,
      timestamp,
      sessionId: 'reused-session-id',
      calls: turn.calls.map(call => ({ ...call, timestamp, model })),
    })),
  }
}

describe('range scoped snapshot reads', () => {
  it('prunes unrelated rows while preserving duplicate source identities, boundaries, full turns, and lifetime diagnostics', () => {
    const { dbPath, runtime } = openLedgerFixture()
    const port = (path: string, timestamp: string, model = 'demo-model') =>
      runtime.runSync(
        Effect.flatMap(LedgerIngest, ingest =>
          ingest.portIn({
            provider: 'opencode',
            envFingerprint: 'scoped-read',
            filePath: path,
            verdict: 'new',
            cachedFile: cachedFileAt(timestamp, model),
          }),
        ),
      )

    port(FIXTURE_SOURCE_PATH, '2026-08-25T00:00:00.000Z')
    port('/Users/demo/.local/share/opencode/other/reused-session.jsonl', '2026-08-31T23:59:59.999Z')
    port('/Users/demo/.local/share/opencode/outside/reused-session.jsonl', '2026-08-20T12:00:00.000Z', 'outside-model')
    runtime.runSync(Effect.flatMap(LedgerConfig, config => config.setModelAlias('outside-model', 'unpriced-effective')))

    const writer = new DatabaseSync(dbPath)
    try {
      writer.prepare("UPDATE ledger_call SET tools_json = 'not-json' WHERE model = 'outside-model'").run()
      const plan = writer
        .prepare(
          `EXPLAIN QUERY PLAN ${selectScopedSessionRows(
            ['source_id', 'session_id', 'turn_index', 'call_index'],
            'ledger_call',
          )} ORDER BY facts.session_id, facts.turn_index, facts.call_index, __rowid`,
        )
        .all('2026-08-24T00:00:00.000Z', '2026-09-01T23:59:59.999Z') as Array<{ detail: string }>
      const planDetails = plan.map(row => row.detail)
      expect(planDetails.some(detail => detail.includes('idx_ledger_call_timestamp'))).toBe(true)
      expect(planDetails.some(detail => detail.includes('SEARCH facts USING INDEX'))).toBe(true)
      expect(planDetails.some(detail => detail.includes('SCAN facts'))).toBe(false)
    } finally {
      writer.close()
    }

    const range = { start: new Date('2026-08-25T00:00:00.000Z'), end: new Date('2026-08-31T23:59:59.999Z') }
    const rangeSnapshot = runtime.runSync(
      loadLedgerQuerySnapshotEffect(
        { catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() },
        range,
      ),
    )

    expect(rangeSnapshot.sessions).toHaveLength(2)
    expect(rangeSnapshot.calls).toHaveLength(2)
    expect(new Set(rangeSnapshot.sessions.map(session => session.sourceId)).size).toBe(2)
    expect(rangeSnapshot.sessions.every(session => session.sessionId === 'reused-session-id')).toBe(true)
    expect(rangeSnapshot.lifetimeModels?.map(row => row.model)).toEqual(['demo-model', 'demo-model', 'outside-model'])

    const result = queryScopeFromSnapshotResult(rangeSnapshot, { range })
    expect(result.unpricedModels).toContain('unpriced-effective')
  })

  it('keeps lifetime snapshot reads unfiltered', () => {
    const { runtime } = openLedgerFixture()
    runtime.runSync(
      Effect.flatMap(LedgerIngest, ingest =>
        ingest.portIn({
          provider: 'opencode',
          envFingerprint: 'lifetime-read',
          filePath: FIXTURE_SOURCE_PATH,
          verdict: 'new',
          cachedFile: cachedFileAt('2026-08-25T00:00:00.000Z'),
        }),
      ),
    )
    const full = runtime.runSync(Effect.flatMap(LedgerQueries, queries => queries.getRequestSnapshotData()))
    expect(full.calls).toHaveLength(1)
    expect(full.lifetimeModels).toBeUndefined()
  })

  it('matches unfiltered calculation payloads for rich sessions across range boundaries', () => {
    const { runtime } = openLedgerFixture()
    const scope = { period: '30days' as const, range: { since: '2026-08-25', until: '2026-08-31' } }
    const now = new Date('2026-08-31T23:59:59.999Z')
    const range = overviewDateRange(scope, now)
    const at = (ms: number) => new Date(ms).toISOString()
    const start = range.start.getTime()
    const end = range.end.getTime()
    const call = (index: number, timestamp: string, model = 'demo-model') => ({
      ...buildFixtureCachedCall(index),
      timestamp,
      model,
      deduplicationKey: `rich-${index}`,
    })
    const turns = [
      {
        timestamp: at(start - 60_000),
        sessionId: 'rich-session',
        userMessage: 'Start work on PR',
        prRefs: ['https://github.com/acme/app/pull/7'],
        calls: [call(0, at(start - 60_000)), call(1, at(start))],
      },
      {
        timestamp: at(start),
        sessionId: 'rich-session',
        userMessage: 'Continue work',
        calls: [call(2, at(start), 'raw-demo-model'), call(3, at(start + 30_000), 'raw-demo-model')],
      },
      {
        timestamp: at(end),
        sessionId: 'rich-session',
        userMessage: 'Finish work',
        calls: [call(4, at(end)), call(5, at(end + 60_000))],
      },
      {
        timestamp: at(end + 60_000),
        sessionId: 'rich-session',
        userMessage: 'Outside by first call',
        calls: [call(6, at(end + 60_000)), call(7, at(end))],
      },
    ]
    runtime.runSync(
      Effect.flatMap(LedgerIngest, ingest =>
        ingest.portIn({
          provider: 'opencode',
          envFingerprint: 'rich-range-parity',
          filePath: FIXTURE_SOURCE_PATH,
          verdict: 'new',
          cachedFile: buildFixtureCachedFile({ turns }),
        }),
      ),
    )
    runtime.runSync(
      Effect.flatMap(LedgerConfig, config => config.setModelAlias('raw-demo-model', 'effective-demo-model')),
    )
    runtime.runSync(
      Effect.flatMap(LedgerConfig, config =>
        config.setPriceOverride('effective-demo-model', { inputPricePerMillion: 0, outputPricePerMillion: 0 }),
      ),
    )

    const inputs = { catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() }
    const full = runtime.runSync(loadLedgerQuerySnapshotEffect(inputs))
    const scoped = runtime.runSync(loadLedgerQuerySnapshotEffect(inputs, range))
    expect(scoped.calls).toHaveLength(full.calls.length)
    expect(scoped.turns).toHaveLength(full.turns.length)

    const scopes: OverviewScope[] = [scope, { ...scope, provider: 'opencode' }, { ...scope, provider: 'claude' }]
    for (const scopedScope of scopes) {
      const fullSessions = calculateSessionsView(full, scopedScope, now)
      const scopedSessions = calculateSessionsView(scoped, scopedScope, now)
      expect(scopedSessions).toEqual(fullSessions)

      const config = { aliases: [...scoped.aliases], overrides: [...scoped.overrides] }
      const fullAggregates = buildSessionSummariesFromSnapshotResult(full, { range, provider: scopedScope.provider })
      const scopedAggregates = buildSessionSummariesFromSnapshotResult(scoped, {
        range,
        provider: scopedScope.provider,
      })
      expect(scopedAggregates).toEqual(fullAggregates)
      expect(calculateModelsPayload(scopedAggregates.summaries, config, scoped.catalogue)).toEqual(
        calculateModelsPayload(fullAggregates.summaries, config, full.catalogue),
      )
      expect(calculateComparePayload(scopedAggregates.summaries, scoped.catalogue)).toEqual(
        calculateComparePayload(fullAggregates.summaries, full.catalogue),
      )
      expect(calculatePullRequestsPayload(scopedAggregates.summaries, scoped.catalogue)).toEqual(
        calculatePullRequestsPayload(fullAggregates.summaries, full.catalogue),
      )
      expect(calculateSpendView(scoped, scopedScope, now)).toEqual(calculateSpendView(full, scopedScope, now))
    }
  })
})
