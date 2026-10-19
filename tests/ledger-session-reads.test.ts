import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'

import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LedgerConfig, LedgerIngest, LedgerQueries } from '../src/main/store/ledger-repository.js'
import { LedgerSessionReads } from '../src/main/store/ledger-session-reads.js'
import { openWorkerRuntime, type WorkerRuntime } from '../src/main/worker-runtime.js'
import { buildFixtureCachedFile, FIXTURE_SOURCE_PATH } from './fixtures/cached-file.js'

const directories: string[] = []
const runtimes: WorkerRuntime[] = []

function removeFixture(directory: string): void {
  const target = resolve(directory)
  assert.equal(dirname(target), resolve(tmpdir()))
  assert.ok(basename(target).startsWith('watchtower-ledger-session-reads-'))
  rmSync(target, { recursive: true, force: true })
}

function openOwner() {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-ledger-session-reads-'))
  directories.push(directory)
  const dbPath = join(directory, 'ledger.db')
  const runtime = openWorkerRuntime(dbPath)
  runtimes.push(runtime)
  return { dbPath, runtime }
}

function read<A>(
  owner: ReturnType<typeof openOwner>,
  op: (reads: LedgerSessionReads['Service']) => Effect.Effect<A, unknown>,
): Promise<A> {
  return owner.runtime.runPromise(Effect.flatMap(LedgerSessionReads, op))
}

function port(owner: ReturnType<typeof openOwner>, envFingerprint: string, repoUrl: string) {
  return owner.runtime.runPromise(
    Effect.flatMap(LedgerIngest, ingest =>
      ingest.portIn({
        provider: 'opencode',
        envFingerprint,
        filePath: `${FIXTURE_SOURCE_PATH}-${envFingerprint}`,
        repoUrl,
        verdict: 'new',
        cachedFile: buildFixtureCachedFile(),
      }),
    ),
  )
}

afterEach(async () => {
  vi.restoreAllMocks()
  try {
    for (const runtime of runtimes.splice(0)) await runtime.dispose()
  } finally {
    for (const directory of directories.splice(0)) removeFixture(directory)
  }
})

describe('purpose-shaped session reads', () => {
  it('preserves canonical numeric-column coercion on the actual SQLite driver', async () => {
    const owner = openOwner()
    await port(owner, 'numeric-coercion', 'https://github.com/acme/demo')
    const writer = new DatabaseSync(owner.dbPath)
    try {
      writer.prepare("UPDATE ledger_call SET input_tokens = ' ', output_tokens = '0x10'").run()
    } finally {
      writer.close()
    }
    const canonical = (
      await owner.runtime.runPromise(Effect.flatMap(LedgerQueries, queries => queries.getCallFacts()))
    )[0]
    expect(canonical).toBeDefined()
    if (!canonical) throw new Error('call facts are missing')
    const summary = await read(owner, reads => reads.getSessionSummaryData())
    expect(canonical.inputTokens).toBe(0)
    expect(canonical.outputTokens).toBe(16)
    expect(summary.calls[0]?.inputTokens).toBe(canonical.inputTokens)
    expect(summary.calls[0]?.outputTokens).toBe(canonical.outputTokens)
  })

  it('reads narrow summary/search facts and full detail rows for every matching source on one connection', async () => {
    const owner = openOwner()
    const statementSql = new WeakMap<StatementSync, string>()
    const statementConnection = new WeakMap<StatementSync, DatabaseSync>()
    const executions: Array<{ sql: string; connection: DatabaseSync }> = []
    const nativePrepare = DatabaseSync.prototype.prepare
    const nativeAll = StatementSync.prototype.all
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
    const execute = vi.spyOn(StatementSync.prototype, 'all')
    prepare.mockImplementation(function (this: DatabaseSync, query: string) {
      const statement = Reflect.apply(nativePrepare, this, [query])
      statementSql.set(statement, query)
      statementConnection.set(statement, this)
      return statement
    })
    execute.mockImplementation(function (this: StatementSync, ...parameters: unknown[]) {
      const result = Reflect.apply(nativeAll, this, parameters)
      const connection = statementConnection.get(this)
      const sql = statementSql.get(this) ?? ''
      if (connection && /^\s*SELECT/i.test(sql)) executions.push({ sql, connection })
      return result
    })

    await port(owner, 'source-a', 'https://github.com/acme/a')
    await port(owner, 'source-b', 'https://github.com/acme/b')
    await owner.runtime.runPromise(
      Effect.flatMap(LedgerConfig, config => config.setModelAlias('demo-model', 'effective-model')),
    )
    await owner.runtime.runPromise(
      Effect.flatMap(LedgerConfig, config =>
        config.setPriceOverride('effective-model', { inputPricePerMillion: 8, outputPricePerMillion: 24 }),
      ),
    )

    // Reverse source-id order without changing table insertion order. Legacy
    // ORDER BY clauses leave ties in their existing row traversal order.
    const reorder = new DatabaseSync(owner.dbPath)
    try {
      reorder.exec('BEGIN IMMEDIATE')
      reorder.exec('PRAGMA defer_foreign_keys = ON')
      reorder.exec('UPDATE ledger_source SET id = 99 WHERE id = 1')
      reorder.exec('UPDATE ledger_session SET source_id = 99 WHERE source_id = 1')
      reorder.exec('UPDATE ledger_turn SET source_id = 99 WHERE source_id = 1')
      reorder.exec('UPDATE ledger_call SET source_id = 99 WHERE source_id = 1')
      reorder.exec('UPDATE ledger_source SET id = 1 WHERE id = 2')
      reorder.exec('UPDATE ledger_session SET source_id = 1 WHERE source_id = 2')
      reorder.exec('UPDATE ledger_turn SET source_id = 1 WHERE source_id = 2')
      reorder.exec('UPDATE ledger_call SET source_id = 1 WHERE source_id = 2')
      reorder.exec('UPDATE ledger_source SET id = 2 WHERE id = 99')
      reorder.exec('UPDATE ledger_session SET source_id = 2 WHERE source_id = 99')
      reorder.exec('UPDATE ledger_turn SET source_id = 2 WHERE source_id = 99')
      reorder.exec('UPDATE ledger_call SET source_id = 2 WHERE source_id = 99')
      reorder.exec('COMMIT')
    } finally {
      reorder.close()
    }
    const [legacySessions, legacyTurns, legacyCalls] = await owner.runtime.runPromise(
      Effect.all([
        Effect.flatMap(LedgerQueries, queries => queries.getSessions()),
        Effect.flatMap(LedgerQueries, queries => queries.getTurns()),
        Effect.flatMap(LedgerQueries, queries => queries.getCallFacts()),
      ]),
    )
    const legacySessionOrder = legacySessions.map(row => row.sourceId)
    const legacyTurnOrder = legacyTurns.map(row => row.sourceId)
    const legacyCallOrder = legacyCalls.map(row => row.sourceId)

    executions.length = 0
    const summary = await read(owner, reads => reads.getSessionSummaryData())
    expect(executions).toHaveLength(5)
    expect(new Set(executions.map(({ connection }) => connection)).size).toBe(1)
    const workerConnection = executions[0]?.connection
    expect(workerConnection).toBeDefined()
    expect(summary.sessions).toHaveLength(2)
    expect(summary.sessions.map(row => row.sourceId)).toEqual(legacySessionOrder)
    expect(summary.sessions.map(({ repoUrl }) => repoUrl)).toEqual([
      'https://github.com/acme/a',
      'https://github.com/acme/b',
    ])
    expect(summary.aliases).toEqual([{ model: 'demo-model', aliasOf: 'effective-model' }])
    expect(summary.overrides).toEqual([
      { model: 'effective-model', inputPricePerMillion: 8, outputPricePerMillion: 24 },
    ])
    const firstCall = summary.calls.at(0)
    expect(firstCall).toBeDefined()
    expect(Object.keys(firstCall ?? {}).sort()).toEqual(
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
      ].sort(),
    )
    const firstSummary = summary.sessions.at(0)
    expect(firstSummary).toBeDefined()
    expect(Object.keys(firstSummary ?? {}).sort()).toEqual(
      [
        'sourceId',
        'sessionId',
        'project',
        'projectPath',
        'workingDirectory',
        'canonicalProject',
        'canonicalCwd',
        'title',
        'sourceProvider',
        'repoUrl',
      ].sort(),
    )
    expect(executions.map(({ sql }) => sql).join('\n')).not.toMatch(
      /user_message|bash_commands_json|tools_json|mcp_inventory_json|pr_links_json/i,
    )

    await owner.runtime.runPromise(
      Effect.flatMap(LedgerConfig, config => config.setModelAlias('demo-model', 'next-effective-model')),
    )
    await owner.runtime.runPromise(
      Effect.flatMap(LedgerConfig, config =>
        config.setPriceOverride('next-effective-model', { inputPricePerMillion: 2, outputPricePerMillion: 6 }),
      ),
    )
    executions.length = 0
    const detail = await read(owner, reads => reads.getSessionDetailData('sess-0'))
    expect(executions).toHaveLength(6)
    expect(new Set(executions.map(({ connection }) => connection)).size).toBe(1)
    expect(executions.every(({ connection }) => connection === workerConnection)).toBe(true)
    expect(detail.sources).toHaveLength(2)
    expect(detail.sessions).toHaveLength(2)
    expect(detail.turns).toHaveLength(2)
    expect(detail.calls).toHaveLength(2)
    expect(detail.sessions.map(row => row.sourceId)).toEqual(legacySessionOrder)
    expect(detail.turns.map(row => row.sourceId)).toEqual(legacyTurnOrder)
    expect(detail.calls.map(row => row.sourceId)).toEqual(legacyCallOrder)
    expect(detail.aliases).toEqual([{ model: 'demo-model', aliasOf: 'next-effective-model' }])
    expect(detail.overrides).toEqual([
      { model: 'effective-model', inputPricePerMillion: 8, outputPricePerMillion: 24 },
      { model: 'next-effective-model', inputPricePerMillion: 2, outputPricePerMillion: 6 },
    ])
    expect(executions.slice(0, 4).every(({ sql }) => /WHERE[^]*session_id\s*=\s*\?/i.test(sql))).toBe(true)
    expect(executions.slice(0, 4).some(({ sql }) => /session_id\s*=\s*\?/i.test(sql))).toBe(true)
    expect(await read(owner, reads => reads.getSessionDetailData('missing-session'))).toMatchObject({
      sources: [],
      sessions: [],
      turns: [],
      calls: [],
    })

    executions.length = 0
    const search = await read(owner, reads => reads.getSessionSearchData())
    expect(executions).toHaveLength(4)
    expect(new Set(executions.map(({ connection }) => connection)).size).toBe(1)
    expect(executions.every(({ connection }) => connection === workerConnection)).toBe(true)
    expect(search.sessions).toHaveLength(2)
    expect(search.turns).toHaveLength(2)
    expect(search.calls).toHaveLength(2)
    expect(Object.keys(search.sessions.at(0) ?? {}).sort()).toEqual(
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
    expect(search.aliases).toEqual([{ model: 'demo-model', aliasOf: 'next-effective-model' }])
    expect(executions.map(({ sql }) => sql).join('\n')).not.toMatch(
      /input_tokens|price_override|tools_json|mcp_tools_json/i,
    )

    executions.length = 0
    const borrowed = await read(owner, reads => reads.getSessionSearchData())
    expect(borrowed.sessions).toHaveLength(2)
    expect(executions).toHaveLength(4)
    expect(executions.every(({ connection }) => connection === workerConnection)).toBe(true)
  })

  it('fails with SchemaError for malformed selected facts, while unrelated JSON is not decoded by summary', async () => {
    const owner = openOwner()
    await port(owner, 'corruption', 'https://github.com/acme/demo')
    const writer = new DatabaseSync(owner.dbPath)
    try {
      writer.prepare("UPDATE ledger_call SET tools_json = 'not-json', bash_commands_json = 'not-json'").run()
    } finally {
      writer.close()
    }

    const summary = await read(owner, reads => reads.getSessionSummaryData())
    expect(summary.calls).toHaveLength(1)

    const search = await owner.runtime.runPromise(
      Effect.exit(Effect.flatMap(LedgerSessionReads, reads => reads.getSessionSearchData())),
    )
    expect(Exit.isFailure(search)).toBe(true)
    if (Exit.isFailure(search)) {
      const failure = search.cause.reasons.find(Cause.isFailReason)
      expect(failure).toBeDefined()
      if (failure) expect(Schema.isSchemaError(failure.error)).toBe(true)
    }

    const detail = await owner.runtime.runPromise(
      Effect.exit(Effect.flatMap(LedgerSessionReads, reads => reads.getSessionDetailData('sess-0'))),
    )
    expect(Exit.isFailure(detail)).toBe(true)
    if (Exit.isFailure(detail)) {
      const failure = detail.cause.reasons.find(Cause.isFailReason)
      expect(failure).toBeDefined()
      if (failure) expect(Schema.isSchemaError(failure.error)).toBe(true)
    }

    const badCost = new DatabaseSync(owner.dbPath)
    try {
      badCost.prepare("UPDATE ledger_call SET speed = 'invalid'").run()
    } finally {
      badCost.close()
    }
    const summaryFailure = await owner.runtime.runPromise(
      Effect.exit(Effect.flatMap(LedgerSessionReads, reads => reads.getSessionSummaryData())),
    )
    expect(Exit.isFailure(summaryFailure)).toBe(true)
    if (Exit.isFailure(summaryFailure)) {
      const failure = summaryFailure.cause.reasons.find(Cause.isFailReason)
      expect(failure).toBeDefined()
      if (failure) expect(Schema.isSchemaError(failure.error)).toBe(true)
    }
  })
})
