import { DatabaseSync, StatementSync } from 'node:sqlite'

import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { LedgerExportData } from '../src/main/store/export-read-projections.js'
import { LedgerExportReads } from '../src/main/store/ledger-export-reads.js'
import { LedgerConfig, LedgerIngest } from '../src/main/store/ledger-ports.js'
import {
  buildFixtureCachedCall,
  buildFixtureCachedFile,
  buildFixtureCachedTurn,
  FIXTURE_SOURCE_PATH,
} from './fixtures/cached-file.js'
import { openLedgerFixture } from './fixtures/ledger-runtime.js'

type TestRuntime = ReturnType<typeof openLedgerFixture>['runtime']

function readExportData(runtime: TestRuntime): Promise<LedgerExportData> {
  return runtime.runPromise(Effect.flatMap(LedgerExportReads, reads => reads.getExportData()))
}

function port(
  runtime: TestRuntime,
  envFingerprint: string,
  provider = 'opencode',
  cachedFile = buildFixtureCachedFile(),
  repoUrl?: string,
): void {
  runtime.runSync(
    Effect.flatMap(LedgerIngest, ingest =>
      ingest.portIn({
        provider,
        envFingerprint,
        filePath: `${FIXTURE_SOURCE_PATH}-${envFingerprint}`,
        repoUrl,
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

describe('purpose-shaped export reads', () => {
  it('selects five narrow reads on one connection for cold and warm calls', async () => {
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

    port(runtime, 'export-read', 'opencode', buildFixtureCachedFile(), 'https://github.com/acme/demo')
    executions.length = 0
    const cold = await readExportData(runtime)
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
        'repoUrl',
      ].sort(),
    )
    expect(Object.keys(cold.turns[0] ?? {}).sort()).toEqual(
      ['sourceId', 'sessionId', 'turnIndex', 'timestamp', 'category'].sort(),
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
        'inputTokens',
        'outputTokens',
        'cacheCreationInputTokens',
        'cacheReadInputTokens',
        'cachedInputTokens',
        'webSearchRequests',
        'reasoningTokens',
        'tools',
        'mcpTools',
        'bashCommands',
      ].sort(),
    )
    expect(cold.sessions[0]).toMatchObject({ sourceProvider: 'opencode', repoUrl: 'https://github.com/acme/demo' })
    expect(executions[0]?.sql).toMatch(/LEFT JOIN ledger_source AS source ON source\.id = s\.source_id/i)
    expect(executions[0]?.sql).toMatch(
      /COALESCE\(source\.provider, 'unknown'\) AS sourceProvider, source\.repo_url AS repoUrl/i,
    )
    expect(cold.aliases).toEqual([])
    expect(cold.overrides).toEqual([])
    expect(executions.map(({ sql }) => sql).join('\n')).not.toMatch(
      /user_message|git_branch|pr_refs_json|spawn_tool_use_ids_json|skills_json|subagent_types_json|tool_sequence_json|mcp_inventory_json|title|is_estimated|loc_added/i,
    )

    setModelAlias(runtime, 'demo-model', 'effective-model')
    setPriceOverride(runtime, 'effective-model', 0, 24)
    executions.length = 0
    const warm = await readExportData(runtime)
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
    expect(warm.calls[0]?.tools).toEqual(['Edit'])
  })

  it('preserves alias and override traversal for normalized-key collisions', async () => {
    const { runtime } = openLedgerFixture()
    port(runtime, 'export-config-order')
    setModelAlias(runtime, 'Vendor/Model-X', 'exact-alias')
    setModelAlias(runtime, 'model-x', 'normalized-alias')
    setPriceOverride(runtime, 'Vendor/Model-X', 2, 20)
    setPriceOverride(runtime, 'model-x', 3, 30)

    const configuredAliases = runtime.runSync(Effect.flatMap(LedgerConfig, config => config.getModelAliases()))
    const configuredOverrides = runtime.runSync(Effect.flatMap(LedgerConfig, config => config.getPriceOverrides()))
    const exported = await readExportData(runtime)
    expect(exported.aliases).toEqual(configuredAliases)
    expect(exported.overrides).toEqual(configuredOverrides)
    expect(exported.aliases).toHaveLength(2)
  })

  it('coerces numeric columns like canonical ledger schemas', async () => {
    const { runtime, dbPath } = openLedgerFixture()
    port(runtime, 'export-numbers')
    setPriceOverride(runtime, 'demo-model', 1, 2)
    const writer = new DatabaseSync(dbPath)
    try {
      writer.prepare("UPDATE ledger_call SET input_tokens = ' ', output_tokens = '0x10'").run()
    } finally {
      writer.close()
    }

    const exported = await readExportData(runtime)
    expect(exported.calls[0]?.inputTokens).toBe(0)
    expect(exported.calls[0]?.outputTokens).toBe(16)
    expect(exported.overrides[0]?.inputPricePerMillion).toBe(1)
    expect(exported.overrides[0]?.outputPricePerMillion).toBe(2)
  })

  it('rejects malformed overrides through the canonical strict schema', async () => {
    const { runtime, dbPath } = openLedgerFixture()
    port(runtime, 'export-strict-overrides')
    setPriceOverride(runtime, 'demo-model', 1, 2)
    const writer = new DatabaseSync(dbPath)
    try {
      writer.prepare("UPDATE price_override SET input_price_per_million = ' ', output_price_per_million = '0x10'").run()
    } finally {
      writer.close()
    }

    const exit = await runtime.runPromise(
      Effect.exit(Effect.flatMap(LedgerExportReads, reads => reads.getExportData())),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const failure = exit.cause.reasons.find(Cause.isFailReason)
      expect(failure).toBeDefined()
      if (failure) expect(Schema.isSchemaError(failure.error)).toBe(true)
    }
  })

  it('keeps duplicate public session IDs distinct and joins each source identity', async () => {
    const { runtime } = openLedgerFixture()
    port(runtime, 'first-source', 'opencode', buildFixtureCachedFile(), 'https://github.com/acme/first')
    port(runtime, 'second-source', 'claude', buildFixtureCachedFile(), 'https://github.com/acme/second')

    const exported = await readExportData(runtime)
    expect(exported.sessions).toHaveLength(2)
    expect(exported.sessions.map(row => row.sessionId)).toEqual(['sess-0', 'sess-0'])
    const sourceIds = exported.sessions.map(row => row.sourceId)
    expect(new Set(sourceIds).size).toBe(2)
    expect(exported.sessions.map(row => row.sourceProvider)).toEqual(['opencode', 'claude'])
    expect(exported.sessions.map(row => row.repoUrl)).toEqual([
      'https://github.com/acme/first',
      'https://github.com/acme/second',
    ])
    expect(exported.turns.map(row => row.sourceId)).toEqual(sourceIds)
    expect(exported.calls.map(row => row.sourceId)).toEqual(sourceIds)
  })

  it('orders turns and calls by indexes when timestamps tie', async () => {
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
    port(runtime, 'export-turn-order', 'opencode', cachedFile)

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

    const exported = await readExportData(runtime)
    expect(exported.turns.map(row => row.turnIndex)).toEqual([1, 10])
    expect(exported.turns[0]?.timestamp).toBe(exported.turns[1]?.timestamp)
    expect(exported.calls.map(row => row.turnIndex)).toEqual([1, 10])
  })

  it('decodes only selected JSON, and returns typed SchemaError and SqlError failures', async () => {
    const { runtime, dbPath } = openLedgerFixture()
    port(runtime, 'export-schema-errors')
    const writer = new DatabaseSync(dbPath)
    try {
      writer
        .prepare(
          "UPDATE ledger_call SET subagent_types_json = 'not-json', skills_json = 'not-json', tool_sequence_json = 'not-json'",
        )
        .run()
    } finally {
      writer.close()
    }
    expect((await readExportData(runtime)).calls).toHaveLength(1)

    const badJsonWriter = new DatabaseSync(dbPath)
    try {
      badJsonWriter.prepare("UPDATE ledger_call SET tools_json = 'not-json'").run()
    } finally {
      badJsonWriter.close()
    }
    const schemaExit = await runtime.runPromise(
      Effect.exit(Effect.flatMap(LedgerExportReads, reads => reads.getExportData())),
    )
    expect(Exit.isFailure(schemaExit)).toBe(true)
    if (Exit.isFailure(schemaExit)) {
      const failure = schemaExit.cause.reasons.find(Cause.isFailReason)
      expect(failure).toBeDefined()
      if (failure) expect(Schema.isSchemaError(failure.error)).toBe(true)
    }

    const dropWriter = new DatabaseSync(dbPath)
    try {
      dropWriter.exec('DROP TABLE ledger_call')
    } finally {
      dropWriter.close()
    }
    const sqlExit = await runtime.runPromise(
      Effect.exit(Effect.flatMap(LedgerExportReads, reads => reads.getExportData())),
    )
    expect(Exit.isFailure(sqlExit)).toBe(true)
    if (Exit.isFailure(sqlExit)) {
      const failure = sqlExit.cause.reasons.find(Cause.isFailReason)
      expect(failure).toBeDefined()
      if (failure) expect(SqlError.isSqlError(failure.error)).toBe(true)
    }
  })

  it.each(['tools_json', 'mcp_tools_json', 'bash_commands_json'])('rejects non-string entries in %s', async column => {
    const { runtime, dbPath } = openLedgerFixture()
    port(runtime, `export-invalid-${column}`)
    const writer = new DatabaseSync(dbPath)
    try {
      writer.prepare(`UPDATE ledger_call SET ${column} = '[42]'`).run()
    } finally {
      writer.close()
    }
    await expect(readExportData(runtime)).rejects.toMatchObject({ _tag: 'SchemaError' })
  })

  it('keeps the unknown-provider fallback for facts with a missing source', async () => {
    const { runtime, dbPath } = openLedgerFixture()
    port(runtime, 'export-missing-source')
    const writer = new DatabaseSync(dbPath)
    try {
      writer.exec('PRAGMA foreign_keys = OFF')
      writer.exec('DELETE FROM ledger_source')
    } finally {
      writer.close()
    }

    const exported = await readExportData(runtime)
    expect(exported.sessions).toHaveLength(1)
    expect(exported.sessions[0]?.sourceProvider).toBe('unknown')
    expect(exported.sessions[0]?.repoUrl).toBeNull()
  })
})
