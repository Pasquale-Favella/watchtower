import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'

import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { querySessionSearch } from '../src/main/application/session-search-query.js'
import { DbWorkerContext } from '../src/main/db-worker/context.js'
import { captureModelPricingCatalogue } from '../src/main/pipeline/models.js'
import { LedgerSessionReads } from '../src/main/store/ledger-session-reads.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'
import { openWorkerOwner } from './fixtures/worker-owner.js'

const directories: string[] = []

function withWorker(
  run: (context: DbWorkerContext, owner: ReturnType<typeof openWorkerOwner>) => Promise<void>,
  overrides?: Layer.Layer<LedgerSessionReads>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-worker-session-query-'))
  directories.push(directory)
  const dbPath = join(directory, 'ledger.db')
  const owner = openWorkerOwner(dbPath, undefined, overrides)
  const context = new DbWorkerContext(
    { dbPath, dataDir: directory, cacheDir: join(directory, 'cache') },
    () => {},
    owner,
  )
  return run(context, owner).finally(async () => {
    await context.close()
  })
}

function portSession(
  owner: ReturnType<typeof openWorkerOwner>,
  input: {
    env: string
    sessionId: string
    project: string
    workingDirectory: string
    repoUrl: string
    timestamp: string
    userMessage: string
    bashCommands: string[]
    inputTokens: number
    outputTokens: number
    title: string
    model?: string
  },
): void {
  const call = {
    ...buildFixtureCachedCall(0),
    model: input.model ?? 'session-query-model',
    timestamp: input.timestamp,
    usage: {
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      webSearchRequests: 0,
      cacheCreationOneHourTokens: 0,
    },
    bashCommands: input.bashCommands,
    tools: ['Read', 'Edit'],
    deduplicationKey: `${input.env}-call`,
  }
  owner.ledger.portIn({
    provider: 'opencode',
    envFingerprint: input.env,
    filePath: `/fixture/${input.env}.jsonl`,
    project: input.project,
    workingDirectory: input.workingDirectory,
    repoUrl: input.repoUrl,
    verdict: 'new',
    cachedFile: buildFixtureCachedFile({
      canonicalCwd: input.workingDirectory,
      canonicalProjectName: input.project,
      title: input.title,
      turns: [
        buildFixtureCachedTurn(0, input.userMessage, {
          sessionId: input.sessionId,
          timestamp: input.timestamp,
          gitBranch: 'main',
          prRefs: ['https://github.com/acme/watchtower/pull/17'],
          calls: [call],
        }),
      ],
    }),
  })
}

function seedSessions(owner: ReturnType<typeof openWorkerOwner>): void {
  portSession(owner, {
    env: 'alpha',
    sessionId: 'duplicate-session',
    project: 'alpha',
    workingDirectory: '/work/alpha',
    repoUrl: 'https://github.com/acme/alpha',
    timestamp: '2026-07-01T09:00:00.000Z',
    userMessage: 'Needle from the alpha prompt',
    bashCommands: ['needle command from alpha'],
    inputTokens: 100,
    outputTokens: 50,
    title: 'Alpha title',
  })
  portSession(owner, {
    env: 'beta',
    sessionId: 'duplicate-session',
    project: 'beta',
    workingDirectory: '/work/beta',
    repoUrl: 'https://github.com/acme/beta',
    timestamp: '2026-07-01T09:10:00.000Z',
    userMessage: 'Needle from the beta prompt',
    bashCommands: ['needle command from beta'],
    inputTokens: 200,
    outputTokens: 100,
    title: 'Beta title',
  })
  portSession(owner, {
    env: 'gamma',
    sessionId: 'z-command-session',
    project: 'gamma',
    workingDirectory: '/work/gamma',
    repoUrl: 'https://github.com/acme/gamma',
    timestamp: '2026-07-01T09:20:00.000Z',
    userMessage: 'A separate session with no matching message',
    bashCommands: ['rg needle in the worker'],
    inputTokens: 300,
    outputTokens: 150,
    title: 'Gamma title',
  })
  owner.ledger.setPriceOverride('session-query-model', { inputPricePerMillion: 2, outputPricePerMillion: 4 })
}

function corruptOtherSessionTools(owner: ReturnType<typeof openWorkerOwner>): void {
  const writer = new DatabaseSync(owner.ledger.dbPath)
  try {
    writer.prepare("UPDATE ledger_call SET tools_json = 'not-json' WHERE session_id = ?").run('z-command-session')
  } finally {
    writer.close()
  }
}

function spyLegacyFacades(owner: ReturnType<typeof openWorkerOwner>) {
  return [
    vi.spyOn(owner.ledger, 'getSources'),
    vi.spyOn(owner.ledger, 'getSessions'),
    vi.spyOn(owner.ledger, 'getTurns'),
    vi.spyOn(owner.ledger, 'getCallFacts'),
    vi.spyOn(owner.ledger, 'getModelAliases'),
    vi.spyOn(owner.ledger, 'getPriceOverrides'),
  ]
}

const routes = [
  { op: 'store:projects', args: [], portMethod: 'getSessionSummaryData' },
  { op: 'store:sessions', args: [{}], portMethod: 'getSessionSummaryData' },
  { op: 'store:session', args: ['duplicate-session'], portMethod: 'getSessionDetailData' },
  { op: 'store:search', args: ['needle'], portMethod: 'getSessionSearchData' },
] as const

const selectTargets = /\bFROM\s+(?:ledger_source|ledger_session|ledger_turn|ledger_call|model_alias|price_override)\b/i

function watchSelects() {
  const executions: Array<{ sql: string; connection: DatabaseSync }> = []
  const statementSql = new WeakMap<StatementSync, string>()
  const statementConnection = new WeakMap<StatementSync, DatabaseSync>()
  const nativePrepare = DatabaseSync.prototype.prepare
  const nativeAll = StatementSync.prototype.all
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    const statement = Reflect.apply(nativePrepare, this, [sql])
    statementSql.set(statement, sql)
    statementConnection.set(statement, this)
    return statement
  })
  vi.spyOn(StatementSync.prototype, 'all').mockImplementation(function (this: StatementSync, ...parameters: unknown[]) {
    const connection = statementConnection.get(this)
    const sql = statementSql.get(this) ?? ''
    const result = Reflect.apply(nativeAll, this, parameters)
    if (connection && /^\s*SELECT\b/i.test(sql) && selectTargets.test(sql)) executions.push({ sql, connection })
    return result
  })
  return executions
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('worker project and session queries', () => {
  it.each(routes)('$op dispatches one focused read and never calls the ledger facade', async route => {
    await withWorker(async (context, owner) => {
      seedSessions(owner)
      corruptOtherSessionTools(owner)
      const reads = owner.runtime.runSync(LedgerSessionReads)
      const summary = vi.spyOn(reads, 'getSessionSummaryData')
      const detail = vi.spyOn(reads, 'getSessionDetailData')
      const search = vi.spyOn(reads, 'getSessionSearchData')
      const legacy = spyLegacyFacades(owner)

      const result = await context.dispatch(route.op, [...route.args])
      expect(summary).toHaveBeenCalledTimes(route.portMethod === 'getSessionSummaryData' ? 1 : 0)
      expect(detail).toHaveBeenCalledTimes(route.portMethod === 'getSessionDetailData' ? 1 : 0)
      expect(search).toHaveBeenCalledTimes(route.portMethod === 'getSessionSearchData' ? 1 : 0)
      expect(legacy.every(spy => spy.mock.calls.length === 0)).toBe(true)

      if (route.op === 'store:projects') {
        expect(result).toMatchObject([
          {
            project: 'gamma',
            projectPath: '/work/gamma',
            repoUrl: 'https://github.com/acme/gamma',
            calls: 1,
            sessions: 1,
          },
          {
            project: 'beta',
            projectPath: '/work/beta',
            repoUrl: 'https://github.com/acme/beta',
            calls: 1,
            sessions: 1,
          },
          {
            project: 'alpha',
            projectPath: '/work/alpha',
            repoUrl: 'https://github.com/acme/alpha',
            calls: 1,
            sessions: 1,
          },
        ])
      } else if (route.op === 'store:sessions') {
        expect(result).toMatchObject([
          {
            sessionId: 'z-command-session',
            title: 'Gamma title',
            project: 'gamma',
            inputTokens: 300,
            outputTokens: 150,
          },
          { sessionId: 'duplicate-session', title: 'Beta title', project: 'beta', inputTokens: 200, outputTokens: 100 },
          {
            sessionId: 'duplicate-session',
            title: 'Alpha title',
            project: 'alpha',
            inputTokens: 100,
            outputTokens: 50,
          },
        ])
      } else if (route.op === 'store:session') {
        expect(result).toMatchObject({
          sessionId: 'duplicate-session',
          project: 'alpha',
          title: 'Alpha title',
          workingDirectory: '/work/alpha',
          totalInputTokens: 100,
          totalOutputTokens: 50,
          apiCalls: 1,
          turns: [
            {
              userMessage: 'Needle from the alpha prompt',
              gitBranch: 'main',
              prRefs: ['https://github.com/acme/watchtower/pull/17'],
              assistantCalls: [{ tools: ['Read', 'Edit'] }],
            },
          ],
        })
      } else {
        expect(result).toEqual([
          {
            sessionId: 'duplicate-session',
            project: 'alpha',
            provider: 'opencode',
            timestamp: '2026-07-01T09:00:00.000Z',
            kind: 'message',
            snippet: 'Needle from the alpha prompt',
          },
          {
            sessionId: 'z-command-session',
            project: 'gamma',
            provider: 'opencode',
            timestamp: '2026-07-01T09:20:00.000Z',
            kind: 'bash',
            snippet: 'rg needle in the worker',
          },
        ])
      }
    })
  })

  it('executes the expected cold and warm SELECT counts on the same writer connection; blank search reads nothing', async () => {
    await withWorker(async (context, owner) => {
      seedSessions(owner)
      const reads = owner.runtime.runSync(LedgerSessionReads)
      const search = vi.spyOn(reads, 'getSessionSearchData')
      const executions = watchSelects()
      const expectedCounts = [
        ['store:projects', [], 5],
        ['store:sessions', [{}], 5],
        ['store:session', ['duplicate-session'], 6],
        ['store:search', ['needle'], 4],
      ] as const
      let writerConnection: DatabaseSync | undefined

      for (const [op, args, count] of expectedCounts) {
        for (let pass = 0; pass < 2; pass++) {
          const before = executions.length
          await context.dispatch(op, [...args])
          const current = executions.slice(before)
          expect(current).toHaveLength(count)
          expect(new Set(current.map(({ connection }) => connection)).size).toBe(1)
          if (!writerConnection) writerConnection = current[0]?.connection
          expect(current.every(({ connection }) => connection === writerConnection)).toBe(true)
        }
      }

      const beforeBlank = executions.length
      const searchCallsBeforeBlank = search.mock.calls.length
      await expect(context.dispatch('store:search', ['  \t  '])).resolves.toEqual([])
      expect(executions.slice(beforeBlank)).toHaveLength(0)
      expect(search).toHaveBeenCalledTimes(searchCallsBeforeBlank)
    })
  })

  it('uses edited aliases and price overrides on the next summary route request without a scan', async () => {
    await withWorker(async (context, owner) => {
      seedSessions(owner)
      owner.ledger.setModelAlias('session-query-model', 'first-priced-model')
      owner.ledger.setPriceOverride('first-priced-model', { inputPricePerMillion: 2, outputPricePerMillion: 4 })

      const firstProjects = (await context.dispatch('store:projects', [])) as Array<{ project: string; cost: number }>
      const firstSessions = (await context.dispatch('store:sessions', [{}])) as Array<{
        project: string
        models: string[]
        cost: number
      }>
      expect(firstProjects.find(row => row.project === 'alpha')?.cost).toBeCloseTo(0.0004, 12)
      expect(firstSessions.find(row => row.project === 'alpha')).toMatchObject({
        models: ['first-priced-model'],
      })
      expect(firstSessions.find(row => row.project === 'alpha')?.cost).toBeCloseTo(0.0004, 12)

      owner.ledger.setModelAlias('session-query-model', 'second-priced-model')
      owner.ledger.setPriceOverride('second-priced-model', { inputPricePerMillion: 7, outputPricePerMillion: 14 })
      const nextProjects = (await context.dispatch('store:projects', [])) as Array<{ project: string; cost: number }>
      const nextSessions = (await context.dispatch('store:sessions', [{}])) as Array<{
        project: string
        models: string[]
        cost: number
      }>
      expect(nextProjects.find(row => row.project === 'alpha')?.cost).toBeCloseTo(0.0014, 12)
      expect(nextSessions.find(row => row.project === 'alpha')).toMatchObject({
        models: ['second-priced-model'],
      })
      expect(nextSessions.find(row => row.project === 'alpha')?.cost).toBeCloseTo(0.0014, 12)
    })
  })

  it.each(routes)('$op propagates typed SQL and Schema failures from its port', async route => {
    const failure = new SqlError.SqlError({
      reason: new SqlError.SqlSyntaxError({
        cause: new Error('controlled SQL failure'),
        message: 'controlled SQL failure',
      }),
    })
    const failedReads = LedgerSessionReads.of({
      getSessionSummaryData: () => Effect.fail(failure),
      getSessionDetailData: () => Effect.fail(failure),
      getSessionSearchData: () => Effect.fail(failure),
    })
    await withWorker(
      async context => {
        await expect(context.dispatch(route.op, [...route.args])).rejects.toMatchObject({ _tag: 'SqlError' })
      },
      Layer.succeed(LedgerSessionReads, failedReads),
    )

    const schemaFailure = Schema.decodeUnknownEffect(Schema.Never)(null)
    const invalidReads = LedgerSessionReads.of({
      getSessionSummaryData: () => schemaFailure,
      getSessionDetailData: () => schemaFailure,
      getSessionSearchData: () => schemaFailure,
    })
    await withWorker(
      async context => {
        await expect(context.dispatch(route.op, [...route.args])).rejects.toMatchObject({ _tag: 'SchemaError' })
      },
      Layer.succeed(LedgerSessionReads, invalidReads),
    )
  })

  it.each(routes)('$op propagates defects instead of normalizing them to empty data', async route => {
    const defectReads = LedgerSessionReads.of({
      getSessionSummaryData: () => Effect.die(new Error('controlled port defect')),
      getSessionDetailData: () => Effect.die(new Error('controlled port defect')),
      getSessionSearchData: () => Effect.die(new Error('controlled port defect')),
    })
    await withWorker(
      async context => {
        await expect(context.dispatch(route.op, [...route.args])).rejects.toThrow('controlled port defect')
      },
      Layer.succeed(LedgerSessionReads, defectReads),
    )
  })

  it('keeps interruption in the failure cause instead of normalizing it to empty search results', async () => {
    const interruptedReads = LedgerSessionReads.of({
      getSessionSummaryData: () => Effect.never,
      getSessionDetailData: () => Effect.never,
      getSessionSearchData: () => Effect.never,
    })
    await withWorker(
      async (_context, owner) => {
        const fiber = owner.runtime.runFork(
          querySessionSearch({ query: 'needle', catalogue: captureModelPricingCatalogue() }),
        )
        await owner.runtime.runPromise(Fiber.interrupt(fiber))
        const exit = await owner.runtime.runPromise(Fiber.await(fiber))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      },
      Layer.succeed(LedgerSessionReads, interruptedReads),
    )
  })
})
