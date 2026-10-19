import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlError from 'effect/sql/SqlError'
import { describe, expect, it, vi } from 'vitest'

import { AssistantSetup } from '../src/main/application/assistant-setup.js'
import { PricingDiagnostics } from '../src/main/application/pricing-diagnostics.js'
import {
  inspectYieldProjects,
  RepositoryInspection,
  RepositoryInspectionError,
} from '../src/main/application/repository-inspection.js'
import { calculateComparePayload } from '../src/main/compare-calculation.js'
import { DbWorkerContext } from '../src/main/db-worker/context.js'
import { calculateModelsPayload } from '../src/main/models-calculation.js'
import { calculateOptimizePayload } from '../src/main/optimize-calculation.js'
import { overviewDateRange, scopeDateRange } from '../src/main/overview-scope.js'
import { captureLocalModelSavings } from '../src/main/pipeline/models.js'
import { calculatePullRequestsPayload } from '../src/main/pull-requests-calculation.js'
import { calculateSessionsView } from '../src/main/sessions-calculation.js'
import { calculateSkillsView } from '../src/main/skills-calculation.js'
import { calculateSpendView } from '../src/main/spend-calculation.js'
import {
  buildSessionSummariesFromSnapshotResult,
  groupSummariesIntoProjects,
} from '../src/main/store/aggregate-calculation.js'
import { type LedgerQuerySnapshot, loadLedgerQuerySnapshotEffect } from '../src/main/store/ledger-query-snapshot.js'
import {
  LedgerConfig,
  LedgerIngest,
  LedgerQueries,
  type LedgerRequestSnapshotData,
} from '../src/main/store/ledger-repository.js'
import { LedgerViewReads } from '../src/main/store/ledger-view-reads.js'
import { buildAnalyticalViewsFromSnapshot, buildDashboardViewsFromSnapshot } from '../src/main/views-calculation.js'
import { openWorkerRuntime, type WorkerRuntime } from '../src/main/worker-runtime.js'
import { calculateYieldPayload } from '../src/main/yield-calculation.js'
import { sessionRowSchema } from '../src/shared/schemas/views.js'
import { DEFAULT_SKILLS_THRESHOLDS } from '../src/shared/skills-defaults.js'
import {
  buildFixtureCachedCall,
  buildFixtureCachedFile,
  buildFixtureCachedTurn,
  FIXTURE_SOURCE_PATH,
} from './fixtures/cached-file.js'
import { viewInputs } from './fixtures/ledger-runtime.js'
import { calculateOverviewFromSnapshot } from './fixtures/pre-native-overview-calculation.js'

interface WorkerOwner {
  dbPath: string
  runtime: WorkerRuntime
}

function removeTemporaryDirectory(directory: string): void {
  const resolvedDirectory = resolve(directory)
  const resolvedParent = dirname(resolvedDirectory)
  const resolvedTempDirectory = resolve(tmpdir())
  const directoryName = basename(resolvedDirectory)
  const prefix = 'watchtower-view-query-'
  if (
    resolvedParent !== resolvedTempDirectory ||
    !directoryName.startsWith(prefix) ||
    directoryName.length <= prefix.length
  ) {
    throw new Error(`Refusing to remove unexpected temporary directory: ${resolvedDirectory}`)
  }
  rmSync(resolvedDirectory, { recursive: true, force: true })
}

async function withWorker(run: (context: DbWorkerContext, owner: WorkerOwner) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-view-query-'))
  const setup = Layer.succeed(
    AssistantSetup,
    AssistantSetup.of({
      getSkillInventory: () => Effect.succeed([]),
      getOptimizeSetup: () =>
        Effect.succeed({
          home: directory,
          mcpConfigs: new Map(),
          envSettings: new Map(),
          agents: [],
          skills: [],
          commands: [],
        }),
    }),
  )
  const repositories = Layer.succeed(
    RepositoryInspection,
    RepositoryInspection.of({
      resolveIdentity: () =>
        Effect.fail(new RepositoryInspectionError({ operation: 'identity', message: 'not a repository' })),
      getMainBranch: () => Effect.succeed('main'),
      getCommitFacts: () => Effect.succeed([]),
    }),
  )
  const dbPath = join(directory, 'ledger.db')
  let runtime: WorkerRuntime | undefined
  let context: DbWorkerContext | undefined
  try {
    runtime = openWorkerRuntime(dbPath, undefined, Layer.mergeAll(setup, repositories))
    const owner = { dbPath, runtime }
    context = new DbWorkerContext({ dbPath, dataDir: directory, cacheDir: join(directory, 'cache') }, () => {}, {
      runtime,
    })
    await run(context, owner)
  } finally {
    vi.restoreAllMocks()
    try {
      if (context) await context.close()
    } finally {
      try {
        if (runtime) await runtime.dispose()
      } finally {
        removeTemporaryDirectory(directory)
      }
    }
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
  'skills:view',
  'optimize:view',
  'optimize:yield',
] as const
type ViewOperation = (typeof operations)[number]
const projectedOperations = new Set<ViewOperation>(['store:views', 'store:analytics'])
const overviewOperations = new Set<ViewOperation>(['overview:query'])
const scope = { period: 'lifetime', range: { since: '2026-07-01', until: '2026-07-02' } } as const

function expectedQueryInputs(owner: WorkerOwner): { snapshot: LedgerQuerySnapshot; now: Date } {
  const { catalogue, proxyPaths } = viewInputs(scope)
  const snapshot = owner.runtime.runSync(loadLedgerQuerySnapshotEffect({ catalogue, proxyPaths }))
  return { snapshot, now: new Date() }
}

async function expectedPayload(operation: ViewOperation, owner: WorkerOwner) {
  const { snapshot, now } = expectedQueryInputs(owner)
  const summaries = buildSessionSummariesFromSnapshotResult(snapshot, {
    range: overviewDateRange(scope, now),
  }).summaries
  const projects = groupSummariesIntoProjects(summaries)
  switch (operation) {
    case 'store:views':
      return buildDashboardViewsFromSnapshot(snapshot)
    case 'store:analytics':
      return buildAnalyticalViewsFromSnapshot(snapshot)
    case 'sessions:view': {
      const result = calculateSessionsView(snapshot, scope, now)
      return Schema.decodeUnknownSync(Schema.mutable(Schema.Array(sessionRowSchema)))(result.rows)
    }
    case 'models:view':
      return calculateModelsPayload(
        summaries,
        { aliases: [...snapshot.aliases], overrides: [...snapshot.overrides] },
        snapshot.catalogue,
      )
    case 'overview:query':
      return calculateOverviewFromSnapshot(snapshot, scope, now, captureLocalModelSavings()).value
    case 'spend:view':
      return calculateSpendView(snapshot, scope, now).value
    case 'compare:view':
      return calculateComparePayload(summaries, snapshot.catalogue)
    case 'pullRequests:view':
      return calculatePullRequestsPayload(summaries, snapshot.catalogue)
    case 'skills:view': {
      const assistantSetup = owner.runtime.runSync(AssistantSetup)
      const workingDirectories = [
        ...new Set(summaries.flatMap(summary => (summary.workingDirectory ? [summary.workingDirectory] : []))),
      ]
      const inventory = await owner.runtime.runPromise(
        assistantSetup.getSkillInventory(workingDirectories, dirname(owner.dbPath)),
      )
      const config = owner.runtime.runSync(LedgerConfig)
      const dismissals = await owner.runtime.runPromise(config.getSkillDismissals())
      return calculateSkillsView(
        summaries,
        inventory,
        overviewDateRange(scope, now),
        DEFAULT_SKILLS_THRESHOLDS,
        dismissals,
      )
    }
    case 'optimize:view': {
      const assistantSetup = owner.runtime.runSync(AssistantSetup)
      const setup =
        projects.length === 0
          ? {
              home: dirname(owner.dbPath),
              mcpConfigs: new Map(),
              envSettings: new Map(),
              agents: [],
              skills: [],
              commands: [],
            }
          : await owner.runtime.runPromise(
              assistantSetup.getOptimizeSetup(
                [...new Set(projects.map(project => project.projectPath || project.project))],
                dirname(owner.dbPath),
              ),
            )
      return calculateOptimizePayload(projects, scope, setup, now)
    }
    case 'optimize:yield': {
      const range = scopeDateRange(scope, now) ?? { start: new Date(0), end: now }
      const groups = await owner.runtime.runPromise(inspectYieldProjects(projects, range))
      return calculateYieldPayload(groups, range)
    }
  }
}

function seedLedger(owner: WorkerOwner): void {
  const cachedFile = buildFixtureCachedFile({
    turns: [
      buildFixtureCachedTurn(0, 'Refactor the auth module', {
        prRefs: ['https://github.com/acme/demo-project/pull/7'],
        calls: [{ ...buildFixtureCachedCall(0), skills: ['demo-skill'] }],
      }),
      buildFixtureCachedTurn(1, 'Continue the skill', {
        calls: [{ ...buildFixtureCachedCall(1), skills: ['demo-skill'] }],
      }),
    ],
  })
  owner.runtime.runSync(
    Effect.flatMap(LedgerIngest, ingest =>
      ingest.portIn({
        provider: 'opencode',
        envFingerprint: 'worker-view-query',
        filePath: FIXTURE_SOURCE_PATH,
        verdict: 'new',
        cachedFile,
      }),
    ),
  )
}

describe('worker view queries', () => {
  it('applies live Skills dismissals through the configuration port', async () => {
    await withWorker(async (context, owner) => {
      seedLedger(owner)
      const thresholds = { frequency: 1, spread: 1 }

      await expect(context.dispatch('skills:view', [scope, thresholds])).resolves.toMatchObject({
        drafts: [{ name: 'demo-skill' }],
      })
      const config = owner.runtime.runSync(LedgerConfig)
      owner.runtime.runSync(config.dismissSkill('skill', 'demo-skill', 'Already covered', '2026-07-01T00:00:00.000Z'))
      await expect(context.dispatch('skills:view', [scope, thresholds])).resolves.toMatchObject({
        drafts: [],
        opportunities: [],
      })
    })
  })

  it('falls back to default Skills thresholds for malformed arguments', async () => {
    await withWorker(async (context, owner) => {
      seedLedger(owner)

      await expect(context.dispatch('skills:view', [scope, { frequency: 0, spread: 0 }])).resolves.toMatchObject({
        drafts: [],
        opportunities: [{ name: 'demo-skill' }],
      })
    })
  })

  it('passes the requested Compare pair through to the application query', async () => {
    await withWorker(async (context, owner) => {
      owner.runtime.runSync(
        Effect.flatMap(LedgerIngest, ingest =>
          ingest.portIn({
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
          }),
        ),
      )
      const pair = { modelA: 'second-model', modelB: 'demo-model' }
      const { snapshot: querySnapshot, now } = expectedQueryInputs(owner)
      const summaries = buildSessionSummariesFromSnapshotResult(querySnapshot, {
        range: overviewDateRange(scope, now),
      }).summaries
      const expected = calculateComparePayload(summaries, querySnapshot.catalogue, pair)
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
      const config = owner.runtime.runSync(LedgerConfig)
      owner.runtime.runSync(config.setModelAlias('demo-model', 'test-unpriced-target-model'))
      const diagnostics = owner.runtime.runSync(PricingDiagnostics)
      const report = vi.spyOn(diagnostics, 'reportUnpricedModels').mockReturnValue(Effect.void)

      await context.dispatch(operation, [scope])

      expect(report).toHaveBeenCalledTimes(1)
      const reported = report.mock.calls[0]?.[0] ?? []
      expect([...reported]).toEqual(['test-unpriced-target-model'])
    })
  })

  it.each(operations)('loads one port read for %s with the expected query shape', async operation => {
    await withWorker(async (context, owner) => {
      seedLedger(owner)
      const expected = await expectedPayload(operation, owner)
      const queries = owner.runtime.runSync(LedgerQueries)
      const snapshot = vi.spyOn(queries, 'getRequestSnapshotData')
      const reads = owner.runtime.runSync(LedgerViewReads)
      const projection = vi.spyOn(reads, 'getViewData')
      const overviewProjection = vi.spyOn(reads, 'getOverviewData')
      const config = owner.runtime.runSync(LedgerConfig)
      const aliases = vi.spyOn(config, 'getModelAliases')
      const overrides = vi.spyOn(config, 'getPriceOverrides')
      const dismissalRead = vi.spyOn(config, 'getSkillDismissals')

      await expect(context.dispatch(operation, [scope])).resolves.toEqual(expected)
      expect(snapshot).toHaveBeenCalledTimes(
        projectedOperations.has(operation) || overviewOperations.has(operation) ? 0 : 1,
      )
      expect(projection).toHaveBeenCalledTimes(projectedOperations.has(operation) ? 1 : 0)
      expect(overviewProjection).toHaveBeenCalledTimes(overviewOperations.has(operation) ? 1 : 0)
      if (!projectedOperations.has(operation)) {
        const expectedRange = overviewDateRange(scope, new Date())
        if (overviewOperations.has(operation)) expect(overviewProjection).toHaveBeenCalledWith(expectedRange)
        else expect(snapshot).toHaveBeenCalledWith(expectedRange)
      }
      expect(aliases).not.toHaveBeenCalled()
      expect(overrides).not.toHaveBeenCalled()
      expect(dismissalRead).toHaveBeenCalledTimes(operation === 'skills:view' ? 1 : 0)
    })
  })

  it.each(operations.filter(operation => !projectedOperations.has(operation)))(
    'keeps the lifetime read unbounded for %s',
    async operation => {
      await withWorker(async (context, owner) => {
        const snapshot = vi.spyOn(owner.runtime.runSync(LedgerQueries), 'getRequestSnapshotData')
        const overview = vi.spyOn(owner.runtime.runSync(LedgerViewReads), 'getOverviewData')

        await context.dispatch(operation, [{ period: 'lifetime' }])

        if (overviewOperations.has(operation)) expect(overview).toHaveBeenCalledExactlyOnceWith(undefined)
        else expect(snapshot).toHaveBeenCalledExactlyOnceWith(undefined)
      })
    },
  )

  it.each(operations)('reflects alias and override changes on the next %s request without a scan', async operation => {
    await withWorker(async (context, owner) => {
      seedLedger(owner)
      const config = owner.runtime.runSync(LedgerConfig)
      owner.runtime.runSync(config.setModelAlias('demo-model', 'first-effective-model'))
      owner.runtime.runSync(
        config.setPriceOverride('first-effective-model', { inputPricePerMillion: 2, outputPricePerMillion: 4 }),
      )
      const first = await context.dispatch(operation, [scope])

      owner.runtime.runSync(config.setModelAlias('demo-model', 'second-effective-model'))
      owner.runtime.runSync(
        config.setPriceOverride('second-effective-model', { inputPricePerMillion: 7, outputPricePerMillion: 14 }),
      )
      const expected = await expectedPayload(operation, owner)

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
      if (overviewOperations.has(operation)) {
        vi.spyOn(owner.runtime.runSync(LedgerViewReads), 'getOverviewData').mockReturnValue(Effect.fail(failure))
      } else if (projectedOperations.has(operation)) {
        vi.spyOn(owner.runtime.runSync(LedgerViewReads), 'getViewData').mockReturnValue(Effect.fail(failure))
      } else {
        vi.spyOn(queries, 'getRequestSnapshotData').mockReturnValue(Effect.fail(failure))
      }

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
      const failure = Schema.decodeUnknownEffect(Schema.Number)('invalid')
      if (overviewOperations.has(operation)) {
        vi.spyOn(owner.runtime.runSync(LedgerViewReads), 'getOverviewData').mockReturnValue(
          failure.pipe(
            Effect.as({
              sessions: [],
              turns: [],
              calls: [],
              aliases: [],
              overrides: [],
              lifetime: { dataStartTimestamp: null, models: [] },
            }),
          ),
        )
      } else if (projectedOperations.has(operation)) {
        vi.spyOn(owner.runtime.runSync(LedgerViewReads), 'getViewData').mockReturnValue(
          failure.pipe(Effect.as({ sessions: [], turns: [], calls: [], aliases: [], overrides: [] })),
        )
      } else {
        vi.spyOn(queries, 'getRequestSnapshotData').mockReturnValue(failure.pipe(Effect.as(empty)))
      }

      await expect(context.dispatch(operation, [scope])).rejects.toMatchObject({ _tag: 'SchemaError' })
    })
  })
})
