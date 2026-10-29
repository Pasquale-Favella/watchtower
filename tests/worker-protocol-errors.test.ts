import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SqlError from 'effect/sql/SqlError'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CurrencyCommandValidationError } from '../src/core/application/commands/currency-commands.js'
import { LedgerConfigValidationError } from '../src/core/application/commands/ledger-config-commands.js'
import { workerRpcError } from '../src/platform/electron/workers/rpc-errors.js'
import { openWorkerRpcTransport, type WorkerRpcClient } from '../src/platform/electron/workers/rpc-transport.js'
import { ScanAbortedError } from '../src/core/ingestion/reconciliation/scan-control.js'
import { UnsupportedLedgerSchemaVersion } from '../src/infrastructure/sqlite/ledger-initialization.js'
import { LedgerIngest, LedgerQueries } from '../src/core/ports/repository.js'
import { openEngineRuntime } from '../src/infrastructure/runtime/engine-runtime.js'
import { type WorkerEvent, WorkerRpcError } from '../src/shared/rpc/worker.js'
import { buildFixtureCachedFile, FIXTURE_SOURCE_PATH } from './fixtures/cached-file.js'

const genericMessage = 'The database worker operation failed.'
let tempRoot = ''
let workerPath = ''

beforeAll(async () => {
  tempRoot = await mkdtemp(join(process.cwd(), 'node_modules', '.watchtower-worker-error-test-'))
  workerPath = join(tempRoot, 'db-worker.mjs')
  await build({
    entryPoints: [fileURLToPath(new URL('../src/platform/electron/workers/entry.ts', import.meta.url))],
    outfile: workerPath,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  })
})

afterAll(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
})

async function seedLedger(directory: string): Promise<string> {
  const dbPath = join(directory, 'ledger.db')
  const runtime = openEngineRuntime(dbPath)
  try {
    await runtime.runPromise(
      Effect.flatMap(LedgerIngest, ingest =>
        ingest.portIn({
          provider: 'opencode',
          envFingerprint: 'worker-protocol-errors',
          filePath: FIXTURE_SOURCE_PATH,
          verdict: 'new',
          cachedFile: buildFixtureCachedFile(),
        }),
      ),
    )
  } finally {
    await runtime.dispose()
  }
  return dbPath
}

async function rejectedSnapshot(dbPath: string): Promise<unknown> {
  const runtime = openEngineRuntime(dbPath)
  try {
    return await runtime.runPromise(Effect.flatMap(LedgerQueries, queries => queries.getRequestSnapshotData())).then(
      () => undefined,
      error => error,
    )
  } finally {
    await runtime.dispose()
  }
}

async function withProductionWorker<A>(
  dbPath: string,
  run: (client: WorkerRpcClient, events: WorkerEvent[]) => Promise<A>,
): Promise<A> {
  const token = Math.random().toString(16).slice(2)
  const worker = new Worker(workerPath, {
    workerData: { dbPath, dataDir: join(tempRoot, `data-${token}`), cacheDir: join(tempRoot, `cache-${token}`) },
  })
  const events: WorkerEvent[] = []
  const transport = await openWorkerRpcTransport(worker, {
    onEvent: event => events.push(event),
    onFailure: () => {},
  })
  try {
    await transport.ready
    return await run(transport.client, events)
  } finally {
    if (worker.threadId !== -1) await Effect.runPromise(transport.client['worker:shutdown'](undefined)).catch(() => {})
    await transport.close()
    if (worker.threadId !== -1) await worker.terminate()
  }
}

function sqlFailure(reason: SqlError.SqlErrorReason): SqlError.SqlError {
  return new SqlError.SqlError({ reason })
}

describe('typed worker RPC error mapping', () => {
  it('maps actual Effect.runPromise SQL and Schema rejections from corrupted SQLite data', async () => {
    const schemaDir = await mkdtemp(join(tempRoot, 'row-schema-'))
    const schemaPath = await seedLedger(schemaDir)
    const schemaWriter = new DatabaseSync(schemaPath)
    schemaWriter.exec("UPDATE ledger_call SET speed = 'hyperdrive' WHERE call_index = 0")
    schemaWriter.close()

    const schemaFailure = await rejectedSnapshot(schemaPath)
    expect(Schema.isSchemaError(schemaFailure)).toBe(true)
    expect(workerRpcError(schemaFailure, 'query-failed').code).toBe('invalid-stored-data')
    expect(workerRpcError(schemaFailure, 'query-failed').message).toBe(genericMessage)
    expect(JSON.stringify(workerRpcError(schemaFailure, 'query-failed'))).not.toContain('hyperdrive')

    const sqlDir = await mkdtemp(join(tempRoot, 'missing-table-'))
    const sqlPath = await seedLedger(sqlDir)
    const sqlWriter = new DatabaseSync(sqlPath)
    sqlWriter.exec('DROP TABLE ledger_turn')
    sqlWriter.close()

    const sqlFailure = await rejectedSnapshot(sqlPath)
    expect(SqlError.isSqlError(sqlFailure)).toBe(true)
    expect(workerRpcError(sqlFailure, 'query-failed').code).toBe('database-operation-failed')
  })

  it('sends real SQLite and invalid-row failures through the native RPC boundary with prior safe logs', async () => {
    const schemaDir = await mkdtemp(join(tempRoot, 'rpc-row-schema-'))
    const schemaPath = await seedLedger(schemaDir)
    const schemaWriter = new DatabaseSync(schemaPath)
    schemaWriter.exec("UPDATE ledger_call SET speed = 'hyperdrive' WHERE call_index = 0")
    schemaWriter.close()

    const schemaResult = await withProductionWorker(schemaPath, async (client, events) => {
      const outcome = await Effect.runPromise(client['store:views'](undefined)).then(
        value => ({ value }),
        error => ({ error, eventsAtRejection: [...events] }),
      )
      return { outcome, events: [...events] }
    })
    expect('error' in schemaResult.outcome).toBe(true)
    if ('error' in schemaResult.outcome) {
      expect(schemaResult.outcome.error).toBeInstanceOf(WorkerRpcError)
      expect(schemaResult.outcome.error).toMatchObject({
        _tag: 'WorkerRpcError',
        code: 'invalid-stored-data',
        eventSequence: expect.any(Number),
      })
      expect(schemaResult.outcome.eventsAtRejection.filter(isQueryErrorLog)).toHaveLength(1)
      expect(schemaResult.outcome.error.eventSequence).toBeGreaterThan(0)
    }
    const schemaLogs = schemaResult.events.filter(isQueryErrorLog)
    expect(schemaLogs).toHaveLength(1)
    expect(schemaLogs[0]).toMatchObject({
      event: 'oplog',
      level: 'error',
      logEvent: 'ledger.query.error',
      fields: { op: 'ledger.query', code: 'schema' },
    })
    expect(JSON.stringify(schemaLogs)).not.toMatch(/hyperdrive|ledger_call|ledger\.db|C:\\|\/Users\//i)

    const sqlDir = await mkdtemp(join(tempRoot, 'rpc-missing-table-'))
    const sqlPath = await seedLedger(sqlDir)
    const sqlWriter = new DatabaseSync(sqlPath)
    sqlWriter.exec('DROP TABLE ledger_turn')
    sqlWriter.close()

    const sqlResult = await withProductionWorker(sqlPath, async (client, events) => {
      const outcome = await Effect.runPromise(client['store:views'](undefined)).then(
        value => ({ value }),
        error => ({ error, eventsAtRejection: [...events] }),
      )
      return { outcome, events: [...events] }
    })
    expect('error' in sqlResult.outcome).toBe(true)
    if ('error' in sqlResult.outcome) {
      expect(sqlResult.outcome.error).toBeInstanceOf(WorkerRpcError)
      expect(sqlResult.outcome.error).toMatchObject({
        _tag: 'WorkerRpcError',
        code: 'database-operation-failed',
        eventSequence: expect.any(Number),
      })
      expect(sqlResult.outcome.eventsAtRejection.filter(isQueryErrorLog)).toHaveLength(1)
    }
    const sqlLogs = sqlResult.events.filter(isQueryErrorLog)
    expect(sqlLogs).toHaveLength(1)
    expect(sqlLogs[0]).toMatchObject({
      event: 'oplog',
      level: 'error',
      logEvent: 'ledger.query.error',
      fields: { op: 'ledger.query', code: 'effect-sql-sql' },
    })
    expect(JSON.stringify(sqlLogs)).not.toMatch(/ledger_turn|ledger\.db|C:\\|\/Users\//i)
  }, 30_000)

  it('maps known SQL failure reasons to safe intent codes', () => {
    const cases = [
      [new SqlError.ConnectionError({ cause: new Error('C:\\private\\ledger.db') }), 'database-unavailable'],
      [new SqlError.AuthenticationError({ cause: new Error('secret token') }), 'database-access-denied'],
      [new SqlError.AuthorizationError({ cause: new Error('private access detail') }), 'database-access-denied'],
      [new SqlError.SqlSyntaxError({ cause: new Error('SELECT * FROM private_table') }), 'database-query-invalid'],
      [new SqlError.UnknownError({ cause: new Error('SQL and path') }), 'database-operation-failed'],
    ] as const

    for (const [reason, code] of cases) {
      const result = workerRpcError(sqlFailure(reason), 'query-failed')
      expect(result.code).toBe(code)
      expect(result.message).toBe(genericMessage)
      expect(JSON.stringify(result)).not.toMatch(/private|secret|SELECT|ledger\.db/i)
    }
  })

  it('maps stored-data, schema-version, and command validation failures safely', () => {
    const schemaFailure = Schema.decodeUnknownResult(Schema.Number)('not a number')
    if (schemaFailure._tag !== 'Failure') throw new Error('expected schema decoding to fail')

    expect(workerRpcError(schemaFailure.failure, 'query-failed').code).toBe('invalid-stored-data')
    expect(
      workerRpcError(
        new UnsupportedLedgerSchemaVersion({
          version: 99,
          latestSupported: 4,
          message: 'private database path C:\\users\\person\\ledger.db',
        }),
        'initialization-failed',
      ).code,
    ).toBe('unsupported-schema-version')
    expect(
      workerRpcError(
        new LedgerConfigValidationError({ message: 'prices must be non-negative numbers' }),
        'command-failed',
      ).code,
    ).toBe('invalid-request')
    expect(
      workerRpcError(
        new CurrencyCommandValidationError({ message: 'invalid ISO 4217 currency code' }),
        'command-failed',
      ).code,
    ).toBe('invalid-request')
  })

  it('maps scan cancellation, Effect interruption, and shutdown without exposing details', () => {
    expect(workerRpcError(new ScanAbortedError({ message: 'scan aborted' }), 'query-failed').code).toBe('cancelled')
    expect(workerRpcError(Cause.interrupt(7), 'query-failed').code).toBe('cancelled')
    expect(workerRpcError(new Error('db-worker is shutting down'), 'command-failed').code).toBe('shutting-down')
  })

  it('uses the caller fallback for unknown failures and defects without leaking causes', () => {
    const privateError = new Error('private ledger row C:\\users\\person\\ledger.db')
    const mappedError = workerRpcError(privateError, 'initialization-failed')
    const mappedDefect = workerRpcError(Cause.die(new Error('private defect and SQL')), 'query-failed')

    expect(mappedError).toMatchObject({ code: 'initialization-failed', message: genericMessage })
    expect(mappedDefect).toMatchObject({ code: 'query-failed', message: genericMessage })
    expect(JSON.stringify([mappedError, mappedDefect])).not.toMatch(/private|ledger\.db|SQL/i)
    expect(workerRpcError(new Error('scan aborted'), 'query-failed').code).toBe('cancelled')

    const alreadyTyped = new WorkerRpcError({
      code: 'invalid-stored-data',
      message: genericMessage,
      eventSequence: 12,
    })
    expect(workerRpcError(alreadyTyped, 'query-failed')).toBe(alreadyTyped)
    expect(workerRpcError(Cause.fail(alreadyTyped), 'query-failed')).toBe(alreadyTyped)
  })
})

function isQueryErrorLog(event: WorkerEvent): event is Extract<WorkerEvent, { readonly event: 'oplog' }> {
  return event.event === 'oplog' && event.level === 'error' && event.logEvent === 'ledger.query.error'
}
