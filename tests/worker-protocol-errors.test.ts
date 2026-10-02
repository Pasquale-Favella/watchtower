import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'

import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'

import type { DbWorkerData } from '../src/main/db-worker/protocol.js'
import { workerProtocolError } from '../src/main/db-worker/protocol-errors.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import { UnsupportedLedgerSchemaVersion } from '../src/main/store/ledger-initialization.js'
import { LedgerQueries } from '../src/main/store/ledger-ports.js'
import { buildFixtureCachedFile, FIXTURE_SOURCE_PATH } from './fixtures/cached-file.js'

const directories: string[] = []
const workerReadySchema = Schema.Struct({ event: Schema.Literal('ready') })
const workerInitErrorSchema = Schema.Struct({ event: Schema.Literal('init-error'), error: Schema.String })
const workerBootSchema = Schema.Union([workerReadySchema, workerInitErrorSchema])
const workerFailureResponseSchema = Schema.Struct({
  id: Schema.Number,
  ok: Schema.Literal(false),
  error: Schema.String,
})

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-worker-protocol-'))
  directories.push(directory)
  return directory
}

function seedLedger(directory: string): string {
  const dbPath = join(directory, 'ledger.db')
  const store = new LedgerStore(dbPath)
  store.portIn({
    provider: 'opencode',
    envFingerprint: 'worker-protocol-errors',
    filePath: FIXTURE_SOURCE_PATH,
    verdict: 'new',
    cachedFile: buildFixtureCachedFile(),
  })
  store.close()
  return dbPath
}

async function rejectedSnapshot(dbPath: string): Promise<unknown> {
  const store = new LedgerStore(dbPath)
  try {
    return await Effect.runPromise(
      Effect.flatMap(LedgerQueries, queries => queries.getRequestSnapshotData()).pipe(Effect.provide(store.portsLayer)),
    ).then(
      () => undefined,
      error => error,
    )
  } finally {
    store.close()
  }
}

function waitForWorkerMessage<A>(
  worker: Worker,
  decode: (raw: unknown) => Result.Result<A, unknown>,
  accept: (value: A) => boolean,
  timeoutMessage: string,
): Promise<A> {
  return new Promise((resolve, reject) => {
    const finish = (complete: () => void) => {
      clearTimeout(timer)
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
      complete()
    }
    const onMessage = (raw: unknown) => {
      const result = decode(raw)
      if (Result.isSuccess(result) && accept(result.success)) finish(() => resolve(result.success))
    }
    const onError = (error: Error) => finish(() => reject(error))
    const onExit = (code: number) => finish(() => reject(new Error(`worker exited before responding (${code})`)))
    const timer = setTimeout(() => finish(() => reject(new Error(timeoutMessage))), 10_000)
    worker.on('message', onMessage)
    worker.on('error', onError)
    worker.on('exit', onExit)
  })
}

async function runRealWorker(dbPath: string, op = 'store:views'): Promise<unknown> {
  const directory = join(process.cwd(), 'node_modules', '.cache')
  mkdirSync(directory, { recursive: true })
  const workerDirectory = mkdtempSync(join(directory, 'watchtower-worker-protocol-entry-'))
  directories.push(workerDirectory)
  const workerPath = join(workerDirectory, 'db-worker.mjs')
  await build({
    absWorkingDir: process.cwd(),
    entryPoints: [join(process.cwd(), 'src/main/db-worker/entry.ts')],
    outfile: workerPath,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
  })

  const init: DbWorkerData = {
    dbPath,
    dataDir: join(workerDirectory, 'data'),
    cacheDir: join(workerDirectory, 'cache'),
  }
  const worker = new Worker(workerPath, { workerData: init })
  try {
    const bootMessage = await waitForWorkerMessage(
      worker,
      Schema.decodeUnknownResult(workerBootSchema),
      () => true,
      'worker ready timeout',
    )
    if (bootMessage.event === 'init-error') throw new Error(`worker boot failed: ${bootMessage.error}`)

    worker.postMessage({ id: 1, op, args: [] })
    return await waitForWorkerMessage(
      worker,
      raw => Schema.decodeUnknownResult(workerFailureResponseSchema)(raw),
      response => response.id === 1,
      'worker response timeout',
    )
  } finally {
    await worker.terminate()
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('worker protocol error mapping', () => {
  it('maps actual Effect.runPromise SQL and Schema rejections to bounded categories', async () => {
    const schemaDirectory = tempDirectory()
    const schemaPath = seedLedger(schemaDirectory)
    const schemaWriter = new DatabaseSync(schemaPath)
    schemaWriter.exec("UPDATE ledger_call SET speed = 'hyperdrive' WHERE call_index = 0")
    schemaWriter.close()

    const schemaFailure = await rejectedSnapshot(schemaPath)
    expect(Schema.isSchemaError(schemaFailure)).toBe(true)
    expect(workerProtocolError(schemaFailure)).toBe('Stored ledger data is invalid.')
    expect(workerProtocolError(schemaFailure)).not.toContain('hyperdrive')

    const sqlDirectory = tempDirectory()
    const sqlPath = seedLedger(sqlDirectory)
    const sqlWriter = new DatabaseSync(sqlPath)
    sqlWriter.exec('DROP TABLE ledger_turn')
    sqlWriter.close()

    const sqlFailure = await rejectedSnapshot(sqlPath)
    expect(SqlError.isSqlError(sqlFailure)).toBe(true)
    expect(workerProtocolError(sqlFailure)).toBe('The ledger database operation failed.')
  })

  it('sends real SQLite and row-schema failures as failed worker responses', async () => {
    const schemaDirectory = tempDirectory()
    const schemaPath = seedLedger(schemaDirectory)
    const schemaWriter = new DatabaseSync(schemaPath)
    schemaWriter.exec("UPDATE ledger_call SET speed = 'hyperdrive' WHERE call_index = 0")
    schemaWriter.close()

    const schemaResponse = await runRealWorker(schemaPath)
    expect(schemaResponse).toEqual({ id: 1, ok: false, error: 'Stored ledger data is invalid.' })

    const sqlDirectory = tempDirectory()
    const sqlPath = seedLedger(sqlDirectory)
    const sqlWriter = new DatabaseSync(sqlPath)
    sqlWriter.exec('DROP TABLE ledger_turn')
    sqlWriter.close()

    const sqlResponse = await runRealWorker(sqlPath)
    expect(sqlResponse).toEqual({ id: 1, ok: false, error: 'The ledger database operation failed.' })
  })

  it('preserves known validation text and maps defects and interruption causes safely', () => {
    expect(workerProtocolError(new Error('invalid ISO 4217 currency code'))).toBe('invalid ISO 4217 currency code')
    expect(
      workerProtocolError(
        new UnsupportedLedgerSchemaVersion({ version: 999, latestSupported: 4, message: 'db path and version 999' }),
      ),
    ).toBe('The ledger database schema version is not supported.')
    expect(workerProtocolError(new Error('private ledger row and /Users/person/path'))).toBe(
      'The database operation failed.',
    )
    expect(workerProtocolError(Cause.die(new Error('private defect')))).toBe(
      'An unexpected database worker failure occurred.',
    )
    expect(workerProtocolError(Cause.interrupt(7))).toBe('The database operation was interrupted.')
  })
})
