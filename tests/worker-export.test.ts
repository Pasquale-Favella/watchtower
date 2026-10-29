import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlError from 'effect/sql/SqlError'
import { describe, expect, it, vi } from 'vitest'

import { ExportFileError, ExportFiles } from '../src/core/ports/export-files.js'
import { PricingDiagnostics } from '../src/core/ports/pricing-diagnostics.js'
import { DbWorkerContext } from '../src/platform/electron/workers/context.js'
import type { ExportFileContent } from '../src/core/analytics/projections/export-calculation.js'
import { FxRates } from '../src/infrastructure/pricing/fx.js'
import {
  LedgerConfig,
  LedgerExportReads,
  LedgerIngest,
  LedgerQueries,
} from '../src/infrastructure/sqlite/ledger-repository.js'
import { openEngineRuntime, type EngineRuntime } from '../src/infrastructure/runtime/engine-runtime.js'
import { buildFixtureCachedFile, FIXTURE_SOURCE_PATH } from './fixtures/cached-file.js'

interface WorkerOwner {
  dbPath: string
  runtime: EngineRuntime
}

function removeTemporaryDirectory(directory: string): void {
  const resolvedDirectory = resolve(directory)
  const resolvedParent = dirname(resolvedDirectory)
  const resolvedTempDirectory = resolve(tmpdir())
  const directoryName = basename(resolvedDirectory)
  const prefix = 'watchtower-worker-export-'
  if (
    resolvedParent !== resolvedTempDirectory ||
    !directoryName.startsWith(prefix) ||
    directoryName.length <= prefix.length
  ) {
    throw new Error(`Refusing to remove unexpected temporary directory: ${resolvedDirectory}`)
  }
  rmSync(resolvedDirectory, { recursive: true, force: true })
}

interface ExportWrite {
  path: string
  files?: readonly ExportFileContent[]
  json?: string
}

async function withWorker(
  run: (context: DbWorkerContext, owner: WorkerOwner, writes: ExportWrite[]) => Promise<void>,
  fileError?: ExportFileError,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-worker-export-'))
  const writes: ExportWrite[] = []
  const files = Layer.succeed(
    ExportFiles,
    ExportFiles.of({
      writeCsvFolder: (path, contents) =>
        fileError
          ? Effect.fail(fileError)
          : Effect.sync(() => {
              writes.push({ path, files: contents })
              return path
            }),
      writeJsonFile: (path, contents) =>
        fileError
          ? Effect.fail(fileError)
          : Effect.sync(() => {
              writes.push({ path, json: contents })
              return path
            }),
    }),
  )
  // Startup FX work uses its own fake; export currency reads still use the
  // real LedgerConfig on the worker's one database connection.
  const fx = FxRates.layerWithRates({
    getDisplayCurrency: () => Effect.succeed('USD'),
    getCurrencyRate: () => Effect.succeed(null),
    setCurrencyRate: () => Effect.void,
    setDisplayCurrency: () => Effect.void,
  })
  const diagnostics = Layer.succeed(
    PricingDiagnostics,
    PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void }),
  )
  const dbPath = join(directory, 'ledger.db')
  let runtime: EngineRuntime | undefined
  let context: DbWorkerContext | undefined
  try {
    runtime = openEngineRuntime(dbPath, undefined, Layer.mergeAll(files, fx, diagnostics))
    const owner = { dbPath, runtime }
    context = new DbWorkerContext({ dbPath, dataDir: directory, cacheDir: join(directory, 'cache') }, () => {}, {
      runtime,
    })
    await run(context, owner, writes)
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

function seedLedger(owner: WorkerOwner): void {
  owner.runtime.runSync(
    Effect.flatMap(LedgerIngest, ingest =>
      ingest.portIn({
        provider: 'opencode',
        envFingerprint: 'worker-export',
        filePath: FIXTURE_SOURCE_PATH,
        verdict: 'new',
        cachedFile: buildFixtureCachedFile(),
      }),
    ),
  )
}

describe('worker export routes', () => {
  for (const kind of ['csv', 'json'] as const) {
    const operation = `export:${kind}` as const

    it(`${operation} uses one sufficient export read and one fresh currency capture`, async () => {
      await withWorker(async (context, owner, writes) => {
        seedLedger(owner)
        const config = owner.runtime.runSync(LedgerConfig)
        const queries = owner.runtime.runSync(LedgerQueries)
        const reads = owner.runtime.runSync(LedgerExportReads)
        await owner.runtime.runPromise(
          config.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: '2026-07-01T00:00:00.000Z' }),
        )
        await owner.runtime.runPromise(
          config.setCurrencyRate({ code: 'JPY', symbol: '¥', rate: 150, updatedAt: '2026-07-01T00:00:00.000Z' }),
        )
        await owner.runtime.runPromise(config.setDisplayCurrency('EUR'))
        const queryReads = [
          vi.spyOn(queries, 'hasSources'),
          vi.spyOn(queries, 'getSources'),
          vi.spyOn(queries, 'getSessions'),
          vi.spyOn(queries, 'getTurns'),
          vi.spyOn(queries, 'getCalls'),
          vi.spyOn(queries, 'getCallFacts'),
          vi.spyOn(queries, 'getRequestSnapshotData'),
        ]
        const aliases = vi.spyOn(config, 'getModelAliases')
        const overrides = vi.spyOn(config, 'getPriceOverrides')
        const exportReads = vi.spyOn(reads, 'getExportData')
        const currencies = vi.spyOn(config, 'getDisplayCurrency')
        const rates = vi.spyOn(config, 'getCurrencyRate')

        await expect(context.dispatch(operation, ['/export/report'])).resolves.toEqual({
          ok: true,
          path: '/export/report',
        })
        await owner.runtime.runPromise(config.setDisplayCurrency('JPY'))
        await expect(context.dispatch(operation, ['/export/next'])).resolves.toEqual({
          ok: true,
          path: '/export/next',
        })

        expect(exportReads).toHaveBeenCalledTimes(2)
        for (const read of queryReads) expect(read).not.toHaveBeenCalled()
        expect(aliases).not.toHaveBeenCalled()
        expect(overrides).not.toHaveBeenCalled()
        expect(currencies).toHaveBeenCalledTimes(2)
        expect(rates.mock.calls).toEqual([['EUR'], ['JPY']])
        expect(writes).toHaveLength(2)
        if (kind === 'csv') {
          expect(writes[0]?.files?.find(file => file.name === 'README.txt')?.contents).toContain('Currency:  EUR')
          expect(writes[1]?.files?.find(file => file.name === 'README.txt')?.contents).toContain('Currency:  JPY')
          expect(writes[0]?.files?.find(file => file.name === 'records.csv')?.contents).toContain('0.38')
          expect(writes[1]?.files?.find(file => file.name === 'records.csv')?.contents).toContain('63')
        } else {
          expect(JSON.parse(writes[0]?.json ?? '')).toMatchObject({
            currency: { code: 'EUR', rate: 0.9 },
            records: [{ cost: 0.38 }],
          })
          expect(JSON.parse(writes[1]?.json ?? '')).toMatchObject({
            currency: { code: 'JPY', rate: 150 },
            records: [{ cost: 63 }],
          })
        }
      })
    })

    it(`${operation} returns no data without reading currency or writing files`, async () => {
      await withWorker(async (context, owner, writes) => {
        const config = owner.runtime.runSync(LedgerConfig)
        const currencyReads = vi.spyOn(config, 'getDisplayCurrency')
        await expect(context.dispatch(operation, ['/export/report'])).resolves.toEqual({
          ok: false,
          error: 'no data to export yet — scan first',
        })
        expect(currencyReads).not.toHaveBeenCalled()
        expect(writes).toEqual([])
      })
    })

    it(`${operation} keeps database and schema failures in the failure channel`, async () => {
      await withWorker(async (context, owner, writes) => {
        const reads = owner.runtime.runSync(LedgerExportReads)
        const exportDataRead = vi.spyOn(reads, 'getExportData')
        const sqlError = new SqlError.SqlError({
          reason: new SqlError.SqlSyntaxError({
            cause: new Error('private database cause'),
            message: 'controlled failure',
          }),
        })
        exportDataRead.mockImplementationOnce(() => Effect.fail(sqlError))
        await expect(context.dispatch(operation, ['/export/report'])).rejects.toMatchObject({ _tag: 'SqlError' })

        exportDataRead.mockImplementationOnce(() =>
          Schema.decodeUnknownEffect(Schema.String)(42).pipe(
            Effect.map(() => ({
              sessions: [],
              turns: [],
              calls: [],
              aliases: [],
              overrides: [],
            })),
          ),
        )
        await expect(context.dispatch(operation, ['/export/report'])).rejects.toMatchObject({ _tag: 'SchemaError' })
        expect(writes).toEqual([])
      })
    })

    it(`${operation} maps expected file errors to bounded user guidance`, async () => {
      await withWorker(
        async (context, owner, writes) => {
          seedLedger(owner)
          await expect(context.dispatch(operation, ['/private/destination'])).resolves.toEqual({
            ok: false,
            error: 'Unable to write the export. Check the destination and try again.',
          })
          expect(writes).toEqual([])
        },
        new ExportFileError({ reason: 'io-failure' }),
      )
    })
  }
})
