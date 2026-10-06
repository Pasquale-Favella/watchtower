import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { describe, expect, it, vi } from 'vitest'

import { ExportFileError, ExportFiles } from '../src/main/application/export-files.js'
import { PricingDiagnostics } from '../src/main/application/pricing-diagnostics.js'
import { DbWorkerContext } from '../src/main/db-worker/context.js'
import type { ExportFileContent } from '../src/main/export-calculation.js'
import { FxRates } from '../src/main/fx.js'
import { LedgerConfig, LedgerQueries } from '../src/main/store/ledger-ports.js'
import { buildFixtureCachedFile, FIXTURE_SOURCE_PATH } from './fixtures/cached-file.js'
import { openWorkerOwner } from './fixtures/worker-owner.js'

interface ExportWrite {
  path: string
  files?: readonly ExportFileContent[]
  json?: string
}

async function withWorker(
  run: (context: DbWorkerContext, owner: ReturnType<typeof openWorkerOwner>, writes: ExportWrite[]) => Promise<void>,
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
  const owner = openWorkerOwner(join(directory, 'ledger.db'), undefined, Layer.mergeAll(files, fx, diagnostics))
  const context = new DbWorkerContext(
    { dbPath: owner.ledger.dbPath, dataDir: directory, cacheDir: join(directory, 'cache') },
    () => {},
    owner,
  )
  try {
    await run(context, owner, writes)
  } finally {
    vi.restoreAllMocks()
    await context.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

function seedLedger(owner: ReturnType<typeof openWorkerOwner>): void {
  owner.ledger.portIn({
    provider: 'opencode',
    envFingerprint: 'worker-export',
    filePath: FIXTURE_SOURCE_PATH,
    verdict: 'new',
    cachedFile: buildFixtureCachedFile(),
  })
}

function forbidFacadeReads(owner: ReturnType<typeof openWorkerOwner>): void {
  for (const method of [
    'getSources',
    'getSessions',
    'getTurns',
    'getCalls',
    'getCallFacts',
    'getModelAliases',
    'getPriceOverrides',
    'getDisplayCurrency',
    'getCurrencyRate',
    'runQueriesSync',
    'runRepositorySync',
  ] as const) {
    vi.spyOn(owner.ledger, method).mockImplementation(() => {
      throw new Error(`Export must not call the compatibility facade: ${method}`)
    })
  }
}

describe('worker export routes', () => {
  for (const kind of ['csv', 'json'] as const) {
    const operation = `export:${kind}` as const

    it(`${operation} uses one canonical snapshot and one fresh currency capture`, async () => {
      await withWorker(async (context, owner, writes) => {
        seedLedger(owner)
        const config = owner.runtime.runSync(LedgerConfig)
        const queries = owner.runtime.runSync(LedgerQueries)
        await owner.runtime.runPromise(
          config.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: '2026-07-01T00:00:00.000Z' }),
        )
        await owner.runtime.runPromise(
          config.setCurrencyRate({ code: 'JPY', symbol: '¥', rate: 150, updatedAt: '2026-07-01T00:00:00.000Z' }),
        )
        await owner.runtime.runPromise(config.setDisplayCurrency('EUR'))
        forbidFacadeReads(owner)
        const snapshots = vi.spyOn(queries, 'getRequestSnapshotData')
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

        expect(snapshots).toHaveBeenCalledTimes(2)
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
        const queries = owner.runtime.runSync(LedgerQueries)
        const snapshot = vi.spyOn(queries, 'getRequestSnapshotData')
        const sqlError = new SqlError.SqlError({
          reason: new SqlError.SqlSyntaxError({
            cause: new Error('private database cause'),
            message: 'controlled failure',
          }),
        })
        snapshot.mockImplementationOnce(() => Effect.fail(sqlError))
        await expect(context.dispatch(operation, ['/export/report'])).rejects.toMatchObject({ _tag: 'SqlError' })

        snapshot.mockImplementationOnce(() =>
          Schema.decodeUnknownEffect(Schema.String)(42).pipe(
            Effect.map(() => ({
              sources: [],
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
