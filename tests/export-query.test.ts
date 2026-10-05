import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ExportFileError, ExportFiles } from '../src/main/application/export-files.js'
import { queryExport } from '../src/main/application/export-query.js'
import { PricingDiagnostics } from '../src/main/application/pricing-diagnostics.js'
import { capturePricingCatalogue } from '../src/main/pipeline/pricing-calculation.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import { LedgerConfig, LedgerQueries } from '../src/main/store/ledger-ports.js'
import { buildFixtureCachedFile, FIXTURE_SOURCE_PATH } from './fixtures/cached-file.js'

const directories: string[] = []
const queryInputs = {
  kind: 'json' as const,
  outputPath: '/export/report.json',
  catalogue: capturePricingCatalogue({
    prices: new Map(),
    overrides: new Map(),
    builtinAliases: {},
    userAliases: {},
    tiers: [],
    routedSegments: new Set(),
  }),
  proxyPaths: { paths: [], caseSensitive: false },
}

function makeStore(): LedgerStore {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-export-query-'))
  directories.push(directory)
  return new LedgerStore(join(directory, 'ledger.db'))
}

function setupStore(store: LedgerStore): void {
  store.portIn({
    provider: 'opencode',
    envFingerprint: 'export-query',
    filePath: FIXTURE_SOURCE_PATH,
    verdict: 'new',
    cachedFile: buildFixtureCachedFile(),
  })
  store.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: '2026-07-01T00:00:00.000Z' })
  store.setCurrencyRate({ code: 'JPY', symbol: '¥', rate: 150, updatedAt: '2026-07-01T00:00:00.000Z' })
  store.runRepositorySync(config => config.setDisplayCurrency('EUR'))
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('queryExport', () => {
  it('uses one snapshot and currency read, writes captured values, then sees fresh currency next request', async () => {
    const store = makeStore()
    try {
      setupStore(store)
      const snapshotReads = vi.fn()
      const individualReads = vi.fn()
      const displayReads = vi.fn()
      const rateReads = vi.fn()
      const diagnosticReports: string[][] = []
      const written: string[] = []
      const results = await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(new Date('2026-07-14T12:34:56.000Z').getTime())
          const actualQueries = yield* LedgerQueries
          const actualConfig = yield* LedgerConfig
          const forbiddenRead = () =>
            Effect.sync(() => individualReads()).pipe(Effect.andThen(Effect.die('unexpected individual read')))
          const queries = LedgerQueries.of({
            ...actualQueries,
            getSources: forbiddenRead,
            getSessions: forbiddenRead,
            getTurns: forbiddenRead,
            getCalls: forbiddenRead,
            getCallFacts: forbiddenRead,
            getRequestSnapshotData: () =>
              Effect.sync(() => snapshotReads()).pipe(Effect.andThen(actualQueries.getRequestSnapshotData())),
          })
          const config = LedgerConfig.of({
            ...actualConfig,
            getDisplayCurrency: () =>
              Effect.sync(() => displayReads()).pipe(Effect.andThen(actualConfig.getDisplayCurrency())),
            getCurrencyRate: code =>
              Effect.sync(() => rateReads(code)).pipe(Effect.andThen(actualConfig.getCurrencyRate(code))),
          })
          const files = ExportFiles.of({
            writeCsvFolder: (_path, fileContents) =>
              Effect.gen(function* () {
                yield* TestClock.adjust(1_000)
                written.push(...fileContents.map(file => file.contents))
                return '/export/usage'
              }),
            writeJsonFile: (_path, contents) =>
              Effect.gen(function* () {
                yield* TestClock.adjust(1_000)
                written.push(contents)
                // This write commits after the currency snapshot. The current
                // export remains EUR; the following query must observe JPY.
                yield* actualConfig.setDisplayCurrency('JPY').pipe(Effect.orDie)
                return '/export/report.json'
              }),
          })
          const run = (kind: 'csv' | 'json') =>
            queryExport({ ...queryInputs, kind }).pipe(
              Effect.provideService(LedgerQueries, queries),
              Effect.provideService(LedgerConfig, config),
              Effect.provideService(ExportFiles, files),
              Effect.provideService(
                PricingDiagnostics,
                PricingDiagnostics.of({
                  reportUnpricedModels: models => Effect.sync(() => diagnosticReports.push([...models])),
                }),
              ),
            )
          const first = yield* run('csv')
          const second = yield* run('json')
          const third = yield* run('json')
          return [first, second, third]
        }).pipe(Effect.provide(store.portsLayer), Effect.provide(TestClock.layer())),
      )

      expect(results).toEqual([
        { ok: true, path: '/export/usage' },
        { ok: true, path: '/export/report.json' },
        { ok: true, path: '/export/report.json' },
      ])
      expect(snapshotReads).toHaveBeenCalledTimes(3)
      expect(individualReads).not.toHaveBeenCalled()
      expect(displayReads).toHaveBeenCalledTimes(3)
      expect(rateReads.mock.calls).toEqual([['EUR'], ['EUR'], ['JPY']])
      expect(diagnosticReports).toEqual([[], [], []])
      expect(written).toHaveLength(12)
      expect(written[0]).toContain('Generated: 2026-07-14T12:34:56.000Z')
      expect(written[0]).toContain('Currency:  EUR')
      expect(written.slice(0, 10).join('\n')).toContain('Cost (EUR)')
      expect(written[10]).toContain('"schema": "watchtower.export.v1"')
      expect(written[10]).toContain('"generated": "2026-07-14T12:34:57.000Z"')
      expect(written[10]).toContain('"code": "EUR"')
      expect(written[11]).toContain('"generated": "2026-07-14T12:34:58.000Z"')
      expect(written[11]).toContain('"code": "JPY"')
    } finally {
      store.close()
    }
  })

  it('returns the established no-data envelope without touching the filesystem', async () => {
    const store = makeStore()
    try {
      const output = await Effect.runPromise(
        Effect.gen(function* () {
          const actualConfig = yield* LedgerConfig
          const config = LedgerConfig.of({
            ...actualConfig,
            getDisplayCurrency: () => Effect.die('currency must not be read for an empty export'),
          })
          return yield* queryExport(queryInputs).pipe(
            Effect.provideService(LedgerConfig, config),
            Effect.provideService(
              PricingDiagnostics,
              PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void }),
            ),
            Effect.provideService(
              ExportFiles,
              ExportFiles.of({
                writeCsvFolder: () => Effect.die('unexpected file write'),
                writeJsonFile: () => Effect.die('unexpected file write'),
              }),
            ),
          )
        }).pipe(Effect.provide(store.portsLayer)),
      )
      expect(output).toEqual({ ok: false, error: 'no data to export yet — scan first' })
    } finally {
      store.close()
    }
  })

  it('maps expected filesystem failures to bounded guidance without exposing target paths', async () => {
    const store = makeStore()
    try {
      setupStore(store)
      const output = await Effect.runPromise(
        queryExport({ ...queryInputs, kind: 'csv' }).pipe(
          Effect.provide(store.portsLayer),
          Effect.provideService(PricingDiagnostics, PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void })),
          Effect.provideService(
            ExportFiles,
            ExportFiles.of({
              writeCsvFolder: () => Effect.fail(new ExportFileError({ reason: 'csv-unmarked-directory' })),
              writeJsonFile: () => Effect.die('unused'),
            }),
          ),
        ),
      )
      expect(output).toEqual({
        ok: false,
        error: 'That folder is not a Watchtower export. Choose a new folder path or a previous Watchtower export.',
      })
      expect(JSON.stringify(output)).not.toContain(queryInputs.outputPath)

      const ioOutput = await Effect.runPromise(
        queryExport({ ...queryInputs, kind: 'csv' }).pipe(
          Effect.provide(store.portsLayer),
          Effect.provideService(PricingDiagnostics, PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void })),
          Effect.provideService(
            ExportFiles,
            ExportFiles.of({
              writeCsvFolder: () => Effect.fail(new ExportFileError({ reason: 'io-failure' })),
              writeJsonFile: () => Effect.die('unused'),
            }),
          ),
        ),
      )
      expect(ioOutput).toEqual({
        ok: false,
        error: 'Unable to write the export. Check the destination and try again.',
      })
      expect(JSON.stringify(ioOutput)).not.toContain(queryInputs.outputPath)
    } finally {
      store.close()
    }
  })
})
