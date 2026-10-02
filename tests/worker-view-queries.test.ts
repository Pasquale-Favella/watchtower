import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { describe, expect, it, vi } from 'vitest'

import { PricingDiagnostics } from '../src/main/application/pricing-diagnostics.js'
import { buildCompareViewFromLedger } from '../src/main/compare-view.js'
import { DbWorkerContext } from '../src/main/db-worker/context.js'
import { buildModelsViewFromLedger } from '../src/main/models-view.js'
import { buildOverviewFromLedger } from '../src/main/overview.js'
import { buildPullRequestsViewFromLedger } from '../src/main/pull-requests-view.js'
import { buildSessionsViewFromLedger } from '../src/main/sessions-view.js'
import { buildSpendViewFromLedger } from '../src/main/spend-view.js'
import { LedgerQueries, type LedgerRequestSnapshotData } from '../src/main/store/ledger-ports.js'
import { buildAnalyticalViewsFromLedger, buildDashboardViewsFromLedger } from '../src/main/views.js'
import { openWorkerOwner } from '../src/main/worker-runtime.js'
import {
  buildFixtureCachedCall,
  buildFixtureCachedFile,
  buildFixtureCachedTurn,
  FIXTURE_SOURCE_PATH,
} from './fixtures/cached-file.js'

async function withWorker(
  run: (context: DbWorkerContext, owner: ReturnType<typeof openWorkerOwner>) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-view-query-'))
  const owner = openWorkerOwner(join(directory, 'ledger.db'))
  const context = new DbWorkerContext(
    { dbPath: owner.ledger.dbPath, dataDir: directory, cacheDir: join(directory, 'cache') },
    () => {},
    owner,
  )
  try {
    await run(context, owner)
  } finally {
    vi.restoreAllMocks()
    await context.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

const operations = [
  'store:views',
  'store:analytics',
  'sessions:view',
  'models:view',
  'overview:query',
  'spend:view',
  'compare:view',
  'pullRequests:view',
] as const
type ViewOperation = (typeof operations)[number]
const scope = { period: 'lifetime' } as const

function expectedPayload(operation: ViewOperation, owner: ReturnType<typeof openWorkerOwner>) {
  switch (operation) {
    case 'store:views':
      return buildDashboardViewsFromLedger(owner.ledger)
    case 'store:analytics':
      return buildAnalyticalViewsFromLedger(owner.ledger)
    case 'sessions:view':
      return buildSessionsViewFromLedger(owner.ledger, scope)
    case 'models:view':
      return buildModelsViewFromLedger(owner.ledger, scope, {
        aliases: owner.ledger.getModelAliases(),
        overrides: owner.ledger.getPriceOverrides(),
      })
    case 'overview:query':
      return buildOverviewFromLedger(owner.ledger, scope)
    case 'spend:view':
      return buildSpendViewFromLedger(owner.ledger, scope)
    case 'compare:view':
      return buildCompareViewFromLedger(owner.ledger, scope)
    case 'pullRequests:view':
      return buildPullRequestsViewFromLedger(owner.ledger, scope)
  }
}

function seedLedger(owner: ReturnType<typeof openWorkerOwner>): void {
  const cachedFile = buildFixtureCachedFile({
    turns: [
      buildFixtureCachedTurn(0, 'Refactor the auth module', {
        prRefs: ['https://github.com/acme/demo-project/pull/7'],
      }),
    ],
  })
  owner.ledger.portIn({
    provider: 'opencode',
    envFingerprint: 'worker-view-query',
    filePath: FIXTURE_SOURCE_PATH,
    verdict: 'new',
    cachedFile,
  })
}

describe('worker view queries', () => {
  it('passes the requested Compare pair through to the application query', async () => {
    await withWorker(async (context, owner) => {
      owner.ledger.portIn({
        provider: 'opencode',
        envFingerprint: 'worker-compare-pair',
        filePath: FIXTURE_SOURCE_PATH,
        verdict: 'new',
        cachedFile: buildFixtureCachedFile({
          turns: [
            buildFixtureCachedTurn(0, 'First model'),
            buildFixtureCachedTurn(1, 'Second model', {
              calls: [{ ...buildFixtureCachedCall(1), model: 'second-model' }],
            }),
          ],
        }),
      })
      const pair = { modelA: 'second-model', modelB: 'demo-model' }
      const expected = buildCompareViewFromLedger(owner.ledger, scope, pair)
      const queries = owner.runtime.runSync(LedgerQueries)
      const snapshot = vi.spyOn(queries, 'getRequestSnapshotData')

      await expect(context.dispatch('compare:view', [scope, pair])).resolves.toEqual(expected)
      expect(expected.report?.modelA.model).toBe(pair.modelA)
      expect(expected.report?.modelB.model).toBe(pair.modelB)
      expect(snapshot).toHaveBeenCalledTimes(1)
    })
  })

  it.each(operations)('reports unpriced models through the runtime port for %s', async operation => {
    await withWorker(async (context, owner) => {
      seedLedger(owner)
      owner.ledger.setModelAlias('demo-model', 'test-unpriced-target-model')
      const diagnostics = owner.runtime.runSync(PricingDiagnostics)
      const report = vi.spyOn(diagnostics, 'reportUnpricedModels').mockReturnValue(Effect.void)

      await context.dispatch(operation, [scope])

      expect(report).toHaveBeenCalledTimes(1)
      const reported = report.mock.calls[0]?.[0] ?? []
      expect([...reported]).toEqual(['test-unpriced-target-model'])
    })
  })

  it.each(operations)('loads one port snapshot for %s without running the synchronous facade', async operation => {
    await withWorker(async (context, owner) => {
      seedLedger(owner)
      const expected = expectedPayload(operation, owner)
      const queries = owner.runtime.runSync(LedgerQueries)
      const snapshot = vi.spyOn(queries, 'getRequestSnapshotData')
      const facade = vi.spyOn(owner.ledger, 'runQueriesSync').mockImplementation(() => {
        throw new Error('legacy query facade must not run')
      })
      const repository = vi.spyOn(owner.ledger, 'runRepositorySync').mockImplementation(() => {
        throw new Error('legacy repository facade must not run')
      })
      const aliases = vi.spyOn(owner.ledger, 'getModelAliases').mockImplementation(() => {
        throw new Error('separate alias read must not run')
      })
      const overrides = vi.spyOn(owner.ledger, 'getPriceOverrides').mockImplementation(() => {
        throw new Error('separate override read must not run')
      })

      await expect(context.dispatch(operation, [scope])).resolves.toEqual(expected)
      expect(snapshot).toHaveBeenCalledTimes(1)
      expect(facade).not.toHaveBeenCalled()
      expect(repository).not.toHaveBeenCalled()
      expect(aliases).not.toHaveBeenCalled()
      expect(overrides).not.toHaveBeenCalled()
    })
  })

  it.each(operations)('reflects alias and override changes on the next %s request without a scan', async operation => {
    await withWorker(async (context, owner) => {
      seedLedger(owner)
      owner.ledger.setModelAlias('demo-model', 'first-effective-model')
      owner.ledger.setPriceOverride('first-effective-model', { inputPricePerMillion: 2, outputPricePerMillion: 4 })
      const first = await context.dispatch(operation, [scope])

      owner.ledger.setModelAlias('demo-model', 'second-effective-model')
      owner.ledger.setPriceOverride('second-effective-model', { inputPricePerMillion: 7, outputPricePerMillion: 14 })
      const expected = expectedPayload(operation, owner)

      const next = await context.dispatch(operation, [scope])
      expect(next).toEqual(expected)
      expect(next).not.toEqual(first)
    })
  })

  it.each(operations)('preserves a typed SQL failure from %s', async operation => {
    await withWorker(async (context, owner) => {
      const queries = owner.runtime.runSync(LedgerQueries)
      const failure = new SqlError.SqlError({
        reason: new SqlError.SqlSyntaxError({ cause: new Error('controlled failure'), message: 'controlled failure' }),
      })
      vi.spyOn(queries, 'getRequestSnapshotData').mockReturnValue(Effect.fail(failure))

      await expect(context.dispatch(operation, [scope])).rejects.toMatchObject({ _tag: 'SqlError' })
    })
  })

  it.each(operations)('preserves a typed Schema failure from %s', async operation => {
    await withWorker(async (context, owner) => {
      const queries = owner.runtime.runSync(LedgerQueries)
      const empty: LedgerRequestSnapshotData = {
        sources: [],
        sessions: [],
        turns: [],
        calls: [],
        aliases: [],
        overrides: [],
      }
      vi.spyOn(queries, 'getRequestSnapshotData').mockReturnValue(
        Schema.decodeUnknownEffect(Schema.Number)('invalid').pipe(Effect.as(empty)),
      )

      await expect(context.dispatch(operation, [scope])).rejects.toMatchObject({ _tag: 'SchemaError' })
    })
  })
})
