import { DatabaseSync, StatementSync } from 'node:sqlite'

import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createPricingConfigLookup } from '../src/main/pipeline/pricing-calculation.js'
import { LedgerConfig, LedgerIngest } from '../src/main/store/ledger-ports.js'
import { LedgerViewReads } from '../src/main/store/ledger-view-reads.js'
import type { OverviewReadData } from '../src/main/store/overview-read-projections.js'
import type { LedgerViewData } from '../src/main/store/view-read-projections.js'
import {
  buildFixtureCachedCall,
  buildFixtureCachedFile,
  buildFixtureCachedTurn,
  FIXTURE_SOURCE_PATH,
} from './fixtures/cached-file.js'
import { openLedgerFixture } from './fixtures/ledger-runtime.js'

type TestRuntime = ReturnType<typeof openLedgerFixture>['runtime']

function readViewData(runtime: TestRuntime): Promise<LedgerViewData> {
  return runtime.runPromise(Effect.flatMap(LedgerViewReads, reads => reads.getViewData()))
}

function readOverviewData(runtime: TestRuntime): Promise<OverviewReadData> {
  return runtime.runPromise(Effect.flatMap(LedgerViewReads, reads => reads.getOverviewData()))
}

function expectSchemaFailure<A, E>(exit: Exit.Exit<A, E>): void {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    const failure = exit.cause.reasons.find(Cause.isFailReason)
    expect(failure).toBeDefined()
    if (failure) expect(Schema.isSchemaError(failure.error)).toBe(true)
  }
}

function expectSqlFailure<A, E>(exit: Exit.Exit<A, E>): void {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    const failure = exit.cause.reasons.find(Cause.isFailReason)
    expect(failure).toBeDefined()
    if (failure) expect(SqlError.isSqlError(failure.error)).toBe(true)
  }
}

function port(
  runtime: TestRuntime,
  envFingerprint: string,
  provider = 'opencode',
  cachedFile = buildFixtureCachedFile(),
): void {
  runtime.runSync(
    Effect.flatMap(LedgerIngest, ingest =>
      ingest.portIn({
        provider,
        envFingerprint,
        filePath: `${FIXTURE_SOURCE_PATH}-${envFingerprint}`,
        verdict: 'new',
        cachedFile,
      }),
    ),
  )
}

function setModelAlias(runtime: TestRuntime, model: string, aliasOf: string): void {
  runtime.runSync(Effect.flatMap(LedgerConfig, config => config.setModelAlias(model, aliasOf)))
}

function setPriceOverride(
  runtime: TestRuntime,
  model: string,
  inputPricePerMillion: number,
  outputPricePerMillion: number,
): void {
  runtime.runSync(
    Effect.flatMap(LedgerConfig, config =>
      config.setPriceOverride(model, { inputPricePerMillion, outputPricePerMillion }),
    ),
  )
}

afterEach(() => vi.restoreAllMocks())

describe('purpose-shaped dashboard and analytics reads', () => {
  it('loads five minimal Overview reads on the existing connection with current pricing', async () => {
    const { runtime } = openLedgerFixture()
    const sqlByStatement = new WeakMap<StatementSync, string>()
    const connectionByStatement = new WeakMap<StatementSync, DatabaseSync>()
    const executions: Array<{ sql: string; connection: DatabaseSync }> = []
    const transactionEvents: string[] = []
    const nativePrepare = DatabaseSync.prototype.prepare
    const nativeAll = StatementSync.prototype.all
    const nativeRun = StatementSync.prototype.run
    vi.spyOn(StatementSync.prototype, 'run').mockImplementation(function (
      this: StatementSync,
      ...parameters: unknown[]
    ) {
      const normalized = (sqlByStatement.get(this) ?? '').trim().toUpperCase()
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(normalized)) transactionEvents.push(normalized)
      return Reflect.apply(nativeRun, this, parameters)
    })
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      const statement = Reflect.apply(nativePrepare, this, [sql])
      sqlByStatement.set(statement, sql)
      connectionByStatement.set(statement, this)
      return statement
    })
    vi.spyOn(StatementSync.prototype, 'all').mockImplementation(function (
      this: StatementSync,
      ...parameters: unknown[]
    ) {
      const rows = Reflect.apply(nativeAll, this, parameters)
      const connection = connectionByStatement.get(this)
      if (connection) {
        executions.push({ sql: sqlByStatement.get(this) ?? '', connection })
        transactionEvents.push('SELECT')
      }
      return rows
    })

    port(runtime, 'overview-read')
    setModelAlias(runtime, 'demo-model', 'overview-target')
    setPriceOverride(runtime, 'overview-target', 0, 24)
    const start = executions.length
    transactionEvents.length = 0
    const data = await readOverviewData(runtime)
    const reads = executions.slice(start)

    expect(reads).toHaveLength(5)
    expect(reads.every(({ sql }) => /^\s*SELECT/i.test(sql))).toBe(true)
    expect(new Set(reads.map(({ connection }) => connection)).size).toBe(1)
    expect(transactionEvents).toEqual(['BEGIN IMMEDIATE', 'SELECT', 'SELECT', 'SELECT', 'SELECT', 'SELECT', 'COMMIT'])
    expect(Object.keys(data.sessions[0] ?? {}).sort()).toEqual(['sessionId', 'sourceId', 'sourceProvider'].sort())
    expect(Object.keys(data.turns[0] ?? {}).sort()).toEqual(
      [
        'category',
        'hasEdits',
        'retries',
        'sessionId',
        'sourceId',
        'subCategory',
        'timestamp',
        'turnIndex',
        'userMessage',
      ].sort(),
    )
    expect(Object.keys(data.calls[0] ?? {}).sort()).toEqual(
      [
        'sourceId',
        'sessionId',
        'turnIndex',
        'callIndex',
        'provider',
        'model',
        'timestamp',
        'speed',
        'baseCostUSD',
        'isEstimated',
        'savingsUSD',
        'savingsBaselineModel',
        'inputTokens',
        'outputTokens',
        'cacheCreationInputTokens',
        'cacheReadInputTokens',
        'cachedInputTokens',
        'webSearchRequests',
        'tools',
        'mcpTools',
        'subagentTypes',
        'toolSequence',
      ].sort(),
    )
    expect(data.calls[0]?.toolSequence).toEqual([])
    expect(data.aliases).toEqual([{ model: 'demo-model', aliasOf: 'overview-target' }])
    expect(data.overrides).toEqual([{ model: 'overview-target', inputPricePerMillion: 0, outputPricePerMillion: 24 }])
    expect(reads.map(({ sql }) => sql).join('\n')).not.toMatch(
      /reasoning_tokens|git_branch|pr_refs_json|spawn_tool_use_ids_json|mcp_inventory_json|agent_spawn_links_json|ambiguous_spawn_agent_ids_json|loc_added|interrupted|call_key/i,
    )
  })

  it('selects five narrow reads on one connection and sees current pricing config', async () => {
    const { runtime } = openLedgerFixture()
    const sqlByStatement = new WeakMap<StatementSync, string>()
    const connectionByStatement = new WeakMap<StatementSync, DatabaseSync>()
    const executions: Array<{ sql: string; connection: DatabaseSync }> = []
    const nativePrepare = DatabaseSync.prototype.prepare
    const nativeAll = StatementSync.prototype.all
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      const statement = Reflect.apply(nativePrepare, this, [sql])
      sqlByStatement.set(statement, sql)
      connectionByStatement.set(statement, this)
      return statement
    })
    vi.spyOn(StatementSync.prototype, 'all').mockImplementation(function (
      this: StatementSync,
      ...parameters: unknown[]
    ) {
      const rows = Reflect.apply(nativeAll, this, parameters)
      const connection = connectionByStatement.get(this)
      if (connection) executions.push({ sql: sqlByStatement.get(this) ?? '', connection })
      return rows
    })

    port(runtime, 'view-read')
    executions.length = 0
    const cold = await readViewData(runtime)
    expect(executions).toHaveLength(5)
    expect(executions.every(({ sql }) => /^\s*SELECT/i.test(sql))).toBe(true)
    const workerConnection = executions[0]?.connection
    expect(workerConnection).toBeDefined()
    expect(new Set(executions.map(({ connection }) => connection)).size).toBe(1)
    expect(Object.keys(cold.sessions[0] ?? {}).sort()).toEqual(
      [
        'sourceId',
        'sessionId',
        'project',
        'projectPath',
        'workingDirectory',
        'canonicalProject',
        'canonicalCwd',
        'sourceProvider',
      ].sort(),
    )
    expect(Object.keys(cold.turns[0] ?? {}).sort()).toEqual(
      ['sourceId', 'sessionId', 'turnIndex', 'timestamp', 'category', 'subCategory'].sort(),
    )
    expect(Object.keys(cold.calls[0] ?? {}).sort()).toEqual(
      [
        'sourceId',
        'sessionId',
        'turnIndex',
        'callIndex',
        'provider',
        'model',
        'timestamp',
        'speed',
        'baseCostUSD',
        'savingsUSD',
        'isEstimated',
        'inputTokens',
        'outputTokens',
        'cacheCreationInputTokens',
        'cacheReadInputTokens',
        'cachedInputTokens',
        'webSearchRequests',
        'reasoningTokens',
        'subagentTypes',
      ].sort(),
    )
    expect(cold.aliases).toEqual([])
    expect(cold.overrides).toEqual([])
    expect(executions.map(({ sql }) => sql).join('\n')).not.toMatch(
      /user_message|git_branch|pr_refs_json|spawn_tool_use_ids_json|tools_json|mcp_tools_json|skills_json|bash_commands_json|tool_sequence_json|mcp_inventory_json|title|repo_url/i,
    )

    setModelAlias(runtime, 'demo-model', 'effective-model')
    setPriceOverride(runtime, 'effective-model', 0, 24)
    executions.length = 0
    const warm = await readViewData(runtime)
    expect(executions).toHaveLength(5)
    expect(new Set(executions.map(({ connection }) => connection)).size).toBe(1)
    expect(executions.every(({ connection }) => connection === workerConnection)).toBe(true)
    expect(warm.aliases).toEqual([{ model: 'demo-model', aliasOf: 'effective-model' }])
    expect(warm.overrides).toEqual([{ model: 'effective-model', inputPricePerMillion: 0, outputPricePerMillion: 24 }])
    expect(Object.keys(warm.aliases[0] ?? {}).sort()).toEqual(['aliasOf', 'model'])
    expect(Object.keys(warm.overrides[0] ?? {}).sort()).toEqual([
      'inputPricePerMillion',
      'model',
      'outputPricePerMillion',
    ])
    expect(warm.calls[0]?.subagentTypes).toEqual([])
  })

  it('preserves alias and override row traversal for normalized-key collisions', async () => {
    const { runtime } = openLedgerFixture()
    port(runtime, 'view-config-order')
    setModelAlias(runtime, 'Vendor/Model-X', 'exact-alias')
    setModelAlias(runtime, 'model-x', 'normalized-alias')
    setPriceOverride(runtime, 'Vendor/Model-X', 2, 20)
    setPriceOverride(runtime, 'model-x', 3, 30)

    const configuredAliases = runtime.runSync(Effect.flatMap(LedgerConfig, config => config.getModelAliases()))
    const configuredOverrides = runtime.runSync(Effect.flatMap(LedgerConfig, config => config.getPriceOverrides()))
    const view = await readViewData(runtime)
    expect(view.aliases).toEqual(configuredAliases)
    expect(view.overrides).toEqual(configuredOverrides)

    const pricing = createPricingConfigLookup(view.aliases, view.overrides)
    expect(pricing.resolveAlias('Vendor/Model-X')).toBe('exact-alias')
    expect(pricing.resolveAlias('VENDOR/MODEL-X')).toBe(configuredAliases.at(-1)?.aliasOf)
    expect(pricing.findOverride('Vendor/Model-X')).toEqual({
      inputPricePerMillion: 2,
      outputPricePerMillion: 20,
    })
    expect(pricing.findOverride('VENDOR/MODEL-X')).toEqual({
      inputPricePerMillion: configuredOverrides.at(-1)?.inputPricePerMillion,
      outputPricePerMillion: configuredOverrides.at(-1)?.outputPricePerMillion,
    })
  })

  it('coerces numeric columns like the canonical ledger schema', async () => {
    const { runtime, dbPath } = openLedgerFixture()
    port(runtime, 'view-numbers')
    setPriceOverride(runtime, 'demo-model', 1, 2)
    const writer = new DatabaseSync(dbPath)
    try {
      writer.prepare("UPDATE ledger_call SET input_tokens = ' ', output_tokens = '0x10'").run()
    } finally {
      writer.close()
    }

    const view = await readViewData(runtime)
    expect(view.calls[0]?.inputTokens).toBe(0)
    expect(view.calls[0]?.outputTokens).toBe(16)
    expect(view.overrides[0]?.inputPricePerMillion).toBe(1)
    expect(view.overrides[0]?.outputPricePerMillion).toBe(2)
  })

  it('rejects nonnumeric price overrides through the canonical strict schema', async () => {
    const { runtime, dbPath } = openLedgerFixture()
    port(runtime, 'view-strict-overrides')
    setPriceOverride(runtime, 'demo-model', 1, 2)
    const writer = new DatabaseSync(dbPath)
    try {
      writer.prepare("UPDATE price_override SET input_price_per_million = ' ', output_price_per_million = '0x10'").run()
    } finally {
      writer.close()
    }

    const exits = await runtime.runPromise(
      Effect.gen(function* () {
        const config = yield* LedgerConfig
        const reads = yield* LedgerViewReads
        return [
          yield* Effect.exit(Effect.asVoid(config.getPriceOverrides())),
          yield* Effect.exit(Effect.asVoid(reads.getViewData())),
          yield* Effect.exit(Effect.asVoid(reads.getOverviewData())),
        ]
      }),
    )
    for (const exit of exits) {
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find(Cause.isFailReason)
        expect(failure).toBeDefined()
        if (failure) expect(Schema.isSchemaError(failure.error)).toBe(true)
      }
    }
  })

  it('keeps duplicate public session IDs distinct and preserves insertion order', async () => {
    const { runtime } = openLedgerFixture()
    port(runtime, 'first-source', 'opencode')
    port(runtime, 'second-source', 'claude')

    const view = await readViewData(runtime)
    expect(view.sessions).toHaveLength(2)
    expect(view.sessions.map(row => row.sessionId)).toEqual(['sess-0', 'sess-0'])
    const sourceIds = view.sessions.map(row => row.sourceId)
    expect(new Set(sourceIds).size).toBe(2)
    expect(view.sessions.map(row => row.sourceProvider)).toEqual(['opencode', 'claude'])
    expect(view.turns.map(row => row.sourceId)).toEqual(sourceIds)
    expect(view.calls.map(row => row.sourceId)).toEqual(sourceIds)
    expect(view.turns.map(row => [row.sessionId, row.turnIndex])).toEqual([
      ['sess-0', 0],
      ['sess-0', 0],
    ])
  })

  it('orders turns and calls by turn index when timestamps tie', async () => {
    const { runtime, dbPath } = openLedgerFixture()
    const timestamp = '2026-07-01T09:00:00.000Z'
    const cachedFile = buildFixtureCachedFile({
      turns: [
        buildFixtureCachedTurn(0, 'first inserted', {
          timestamp,
          calls: [{ ...buildFixtureCachedCall(0), timestamp }],
        }),
        buildFixtureCachedTurn(1, 'second inserted', {
          timestamp,
          calls: [{ ...buildFixtureCachedCall(1), timestamp }],
        }),
      ],
    })
    port(runtime, 'view-turn-order', 'opencode', cachedFile)

    const writer = new DatabaseSync(dbPath)
    try {
      writer.exec('BEGIN IMMEDIATE')
      writer.exec("UPDATE ledger_turn SET turn_index = 10 WHERE session_id = 'sess-0' AND turn_index = 0")
      writer.exec("UPDATE ledger_call SET turn_index = 10 WHERE session_id = 'sess-0' AND turn_index = 0")
      writer.exec("UPDATE ledger_turn SET turn_index = 1 WHERE session_id = 'sess-0' AND turn_index = 1")
      writer.exec("UPDATE ledger_call SET turn_index = 1 WHERE session_id = 'sess-0' AND turn_index = 1")
      writer.exec('COMMIT')
    } finally {
      writer.close()
    }

    const view = await readViewData(runtime)
    expect(view.turns.map(row => row.turnIndex)).toEqual([1, 10])
    expect(view.turns[0]?.timestamp).toBe(view.turns[1]?.timestamp)
    expect(view.calls.map(row => row.turnIndex)).toEqual([1, 10])
  })

  it('returns typed schema and SQL errors while ignoring unselected malformed JSON', async () => {
    const { runtime, dbPath } = openLedgerFixture()
    port(runtime, 'view-schema-errors')
    const writer = new DatabaseSync(dbPath)
    try {
      writer
        .prepare(
          "UPDATE ledger_call SET tools_json = 'not-json', mcp_tools_json = 'not-json', skills_json = 'not-json', bash_commands_json = 'not-json', tool_sequence_json = 'not-json'",
        )
        .run()
    } finally {
      writer.close()
    }
    expect((await readViewData(runtime)).calls).toHaveLength(1)
    const schemaTransactionEvents: string[] = []
    const schemaSqlByStatement = new WeakMap<StatementSync, string>()
    const nativePrepare = DatabaseSync.prototype.prepare
    const nativeRun = StatementSync.prototype.run
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      const statement = Reflect.apply(nativePrepare, this, [sql])
      schemaSqlByStatement.set(statement, sql)
      return statement
    })
    vi.spyOn(StatementSync.prototype, 'run').mockImplementation(function (
      this: StatementSync,
      ...parameters: unknown[]
    ) {
      const normalized = (schemaSqlByStatement.get(this) ?? '').trim().toUpperCase()
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(normalized)) schemaTransactionEvents.push(normalized)
      return Reflect.apply(nativeRun, this, parameters)
    })
    const malformedOverviewJson = await runtime.runPromise(
      Effect.exit(Effect.flatMap(LedgerViewReads, reads => reads.getOverviewData())),
    )
    expectSchemaFailure(malformedOverviewJson)
    expect(schemaTransactionEvents).toEqual(['BEGIN IMMEDIATE', 'COMMIT'])

    const badJsonWriter = new DatabaseSync(dbPath)
    try {
      badJsonWriter.prepare("UPDATE ledger_call SET subagent_types_json = 'not-json'").run()
    } finally {
      badJsonWriter.close()
    }
    const schemaExits = await runtime.runPromise(
      Effect.gen(function* () {
        const reads = yield* LedgerViewReads
        return { view: yield* Effect.exit(reads.getViewData()), overview: yield* Effect.exit(reads.getOverviewData()) }
      }),
    )
    expectSchemaFailure(schemaExits.view)
    expectSchemaFailure(schemaExits.overview)

    const dropWriter = new DatabaseSync(dbPath)
    try {
      dropWriter.exec('DROP TABLE ledger_call')
    } finally {
      dropWriter.close()
    }
    const sqlExits = await runtime.runPromise(
      Effect.gen(function* () {
        const reads = yield* LedgerViewReads
        return { view: yield* Effect.exit(reads.getViewData()), overview: yield* Effect.exit(reads.getOverviewData()) }
      }),
    )
    expectSqlFailure(sqlExits.view)
    expectSqlFailure(sqlExits.overview)
  })
})
