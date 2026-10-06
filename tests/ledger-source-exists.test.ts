import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'

import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LedgerQueries } from '../src/main/store/ledger-ports.js'
import { openWorkerOwner } from '../src/main/worker-runtime.js'
import { buildFixtureCachedFile, FIXTURE_SOURCE_PATH } from './fixtures/cached-file.js'

const directories: string[] = []

function openOwner() {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-ledger-source-exists-'))
  directories.push(directory)
  return openWorkerOwner(join(directory, 'ledger.db'))
}

function port(owner: ReturnType<typeof openOwner>) {
  owner.ledger.portIn({
    provider: 'opencode',
    envFingerprint: 'source-exists',
    filePath: FIXTURE_SOURCE_PATH,
    repoUrl: 'https://github.com/acme/demo',
    verdict: 'new',
    cachedFile: buildFixtureCachedFile(),
  })
}

function selectExecutions() {
  const statementSql = new WeakMap<StatementSync, string>()
  const statementConnection = new WeakMap<StatementSync, DatabaseSync>()
  const executions: Array<{ sql: string; connection: DatabaseSync; rowCount: number }> = []
  const nativePrepare = DatabaseSync.prototype.prepare
  const nativeAll = StatementSync.prototype.all
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    const statement = Reflect.apply(nativePrepare, this, [sql])
    statementSql.set(statement, sql)
    statementConnection.set(statement, this)
    return statement
  })
  vi.spyOn(StatementSync.prototype, 'all').mockImplementation(function (this: StatementSync, ...parameters: unknown[]) {
    const result = Reflect.apply(nativeAll, this, parameters)
    const sql = statementSql.get(this) ?? ''
    const connection = statementConnection.get(this)
    if (connection && /^\s*SELECT\b/i.test(sql)) executions.push({ sql, connection, rowCount: result.length })
    return result
  })
  return executions
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('LedgerQueries.hasSources', () => {
  it('uses one bounded SELECT on the writer connection when cold and warm, and tracks ingest and clear', async () => {
    const owner = openOwner()
    try {
      const executions = selectExecutions()
      const hasSources = () => owner.runtime.runPromise(Effect.flatMap(LedgerQueries, queries => queries.hasSources()))

      expect(await hasSources()).toBe(false)
      expect(await hasSources()).toBe(false)
      expect(executions).toHaveLength(2)
      expect(executions.map(({ sql }) => sql.trim().replace(/\s+/g, ' '))).toEqual([
        'SELECT 1 FROM ledger_source LIMIT 1',
        'SELECT 1 FROM ledger_source LIMIT 1',
      ])
      expect(executions.every(({ rowCount }) => rowCount <= 1)).toBe(true)
      const writerConnection = executions[0]?.connection
      expect(writerConnection).toBeDefined()
      expect(executions.every(({ connection }) => connection === writerConnection)).toBe(true)

      port(owner)
      const beforeIngestRead = executions.length
      expect(await hasSources()).toBe(true)
      expect(executions.slice(beforeIngestRead)).toHaveLength(1)
      expect(executions.at(-1)?.connection).toBe(writerConnection)

      owner.ledger.clear()
      const beforeClearRead = executions.length
      expect(await hasSources()).toBe(false)
      expect(executions.slice(beforeClearRead)).toHaveLength(1)
      expect(executions.at(-1)?.connection).toBe(writerConnection)
    } finally {
      await Effect.runPromise(owner.runtime.disposeEffect)
    }
  })

  it('does not decode source fields or issue any other reads', async () => {
    const owner = openOwner()
    try {
      port(owner)
      const writer = new DatabaseSync(owner.ledger.dbPath)
      try {
        writer.prepare("UPDATE ledger_source SET fingerprint_size_bytes = 'invalid'").run()
      } finally {
        writer.close()
      }

      const executions = selectExecutions()
      await expect(
        owner.runtime.runPromise(Effect.flatMap(LedgerQueries, queries => queries.hasSources())),
      ).resolves.toBe(true)
      expect(executions).toHaveLength(1)
      expect(executions[0]?.sql.trim().replace(/\s+/g, ' ')).toBe('SELECT 1 FROM ledger_source LIMIT 1')
      expect(executions[0]?.rowCount).toBe(1)
      await expect(
        owner.runtime.runPromise(Effect.flatMap(LedgerQueries, queries => queries.getSources())),
      ).rejects.toMatchObject({ _tag: 'SchemaError' })
    } finally {
      await Effect.runPromise(owner.runtime.disposeEffect)
    }
  })

  it('preserves the typed SQL error channel', async () => {
    const owner = openOwner()
    try {
      const writer = new DatabaseSync(owner.ledger.dbPath)
      try {
        writer.exec('DROP TABLE ledger_source')
      } finally {
        writer.close()
      }

      const exit = await owner.runtime.runPromise(
        Effect.exit(Effect.flatMap(LedgerQueries, queries => queries.hasSources())),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find(Cause.isFailReason)
        expect(failure?.error).toBeInstanceOf(SqlError.SqlError)
      }
    } finally {
      await Effect.runPromise(owner.runtime.disposeEffect)
    }
  })

  it('keeps defects and interruption observable and permits a fake without other query reads', async () => {
    const calls: string[] = []
    const fakeQueries = LedgerQueries.of({
      hasSources: () => Effect.sync(() => (calls.push('hasSources'), false)),
      getSources: () => Effect.die(new Error('unexpected read')),
      getSessions: () => Effect.die(new Error('unexpected read')),
      getTurns: () => Effect.die(new Error('unexpected read')),
      getCalls: () => Effect.die(new Error('unexpected read')),
      getCallFacts: () => Effect.die(new Error('unexpected read')),
      getRequestSnapshotData: () => Effect.die(new Error('unexpected read')),
    })
    const layer = Layer.succeed(LedgerQueries, fakeQueries)

    await expect(
      Effect.runPromise(Effect.flatMap(LedgerQueries, queries => queries.hasSources()).pipe(Effect.provide(layer))),
    ).resolves.toBe(false)
    expect(calls).toEqual(['hasSources'])

    const defectExit = await Effect.runPromise(
      Effect.exit(
        Effect.flatMap(LedgerQueries, queries => queries.hasSources()).pipe(
          Effect.provide(
            Layer.succeed(LedgerQueries, LedgerQueries.of({ ...fakeQueries, hasSources: () => Effect.die('defect') })),
          ),
        ),
      ),
    )
    expect(Exit.isFailure(defectExit)).toBe(true)
    if (Exit.isFailure(defectExit)) expect(Cause.hasDies(defectExit.cause)).toBe(true)

    const interrupted = Effect.flatMap(LedgerQueries, queries => queries.hasSources()).pipe(
      Effect.provide(
        Layer.succeed(LedgerQueries, LedgerQueries.of({ ...fakeQueries, hasSources: () => Effect.never })),
      ),
    )
    const fiber = Effect.runFork(interrupted)
    await Effect.runPromise(Fiber.interrupt(fiber))
    const interruptionExit = await Effect.runPromise(Fiber.await(fiber))
    expect(Exit.isFailure(interruptionExit)).toBe(true)
    if (Exit.isFailure(interruptionExit)) expect(Cause.hasInterruptsOnly(interruptionExit.cause)).toBe(true)
  })
})
