import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import { type ExportResult, exportResultSchema } from '../../shared/schemas/export.js'
import type { ActiveCurrency } from '../../shared/schemas/fx.js'
import { buildCsvExportFiles, buildJsonExport } from '../export-calculation.js'
import { activeFromCachedRate, isValidCurrencyCode, USD_CURRENCY } from '../fx-calculation.js'
import type { PricingCatalogue } from '../pipeline/pricing-calculation.js'
import type { ProxyPathConfig } from '../pipeline/proxy-paths.js'
import { buildSessionSummariesFromSnapshotResult, groupSummariesIntoProjects } from '../store/aggregate-calculation.js'
import type { LedgerQueries } from '../store/ledger-ports.js'
import { LedgerConfig } from '../store/ledger-ports.js'
import { loadLedgerQuerySnapshotEffect } from '../store/ledger-query-snapshot.js'
import { exportFileErrorMessage, ExportFiles } from './export-files.js'
import { PricingDiagnostics } from './pricing-diagnostics.js'

const ALL_TIME_RANGE = { start: new Date(-8640000000000000), end: new Date(8640000000000000) } as const

export type ExportQueryInputs = {
  readonly kind: 'csv' | 'json'
  readonly outputPath: string
  readonly catalogue: PricingCatalogue
  readonly proxyPaths: ProxyPathConfig
}

const captureActiveCurrency = Effect.fnUntraced(function* (): Effect.fn.Return<
  ActiveCurrency,
  SqlError | Schema.SchemaError,
  LedgerConfig
> {
  const config = yield* LedgerConfig
  const storedCode = yield* config.getDisplayCurrency()
  const code = isValidCurrencyCode(storedCode) ? storedCode : 'USD'
  if (code === 'USD') return { ...USD_CURRENCY }
  const cached = yield* config.getCurrencyRate(code)
  return activeFromCachedRate(code, cached)
})

export const queryExport = Effect.fn('queryExport')(function* (
  input: ExportQueryInputs,
): Effect.fn.Return<
  ExportResult,
  SqlError | Schema.SchemaError,
  LedgerQueries | LedgerConfig | PricingDiagnostics | ExportFiles
> {
  const generated = DateTime.toDateUtc(yield* DateTime.now).toISOString()
  const snapshot = yield* loadLedgerQuerySnapshotEffect({ catalogue: input.catalogue, proxyPaths: input.proxyPaths })
  const aggregation = buildSessionSummariesFromSnapshotResult(snapshot, { range: ALL_TIME_RANGE })
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(aggregation.unpricedModels)

  const projects = groupSummariesIntoProjects(aggregation.summaries)
  if (projects.length === 0) {
    return yield* Schema.decodeUnknownEffect(exportResultSchema)({
      ok: false,
      error: 'no data to export yet — scan first',
    })
  }

  const currency = yield* captureActiveCurrency()
  const files = yield* ExportFiles
  const writing =
    input.kind === 'csv'
      ? files.writeCsvFolder(input.outputPath, buildCsvExportFiles(projects, currency, generated))
      : files.writeJsonFile(input.outputPath, buildJsonExport(projects, currency, generated))
  return yield* writing.pipe(
    Effect.map(path => ({ ok: true as const, path })),
    Effect.catchTag('ExportFileError', error =>
      Effect.succeed({ ok: false as const, error: exportFileErrorMessage(error) }),
    ),
    Effect.flatMap(result => Schema.decodeUnknownEffect(exportResultSchema)(result)),
  )
})
