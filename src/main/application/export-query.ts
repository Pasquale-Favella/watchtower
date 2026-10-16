import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import { type ExportResult, exportResultSchema } from '../../shared/schemas/export.js'
import type { ActiveCurrency } from '../../shared/schemas/fx.js'
import { buildCsvExportFilesFromRows, buildJsonExportFromRows } from '../export-calculation.js'
import { buildExportRows, calculateExportData } from '../export-rows-calculation.js'
import { activeFromCachedRate, isValidCurrencyCode, USD_CURRENCY } from '../fx-calculation.js'
import type { PricingCatalogue } from '../pipeline/pricing-calculation.js'
import type { ProxyPathConfig } from '../pipeline/proxy-paths.js'
import { LedgerExportReads } from '../store/ledger-export-reads.js'
import { LedgerConfig } from '../store/ledger-ports.js'
import { exportFileErrorMessage, ExportFiles } from './export-files.js'
import { PricingDiagnostics } from './pricing-diagnostics.js'

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
  LedgerExportReads | LedgerConfig | PricingDiagnostics | ExportFiles
> {
  const generated = DateTime.toDateUtc(yield* DateTime.now).toISOString()
  const reads = yield* LedgerExportReads
  const data = yield* reads.getExportData()
  const calculation = calculateExportData(data, input.catalogue)
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(calculation.unpricedModels)

  if (calculation.sessionCount === 0) {
    return yield* Schema.decodeUnknownEffect(exportResultSchema)({
      ok: false,
      error: 'no data to export yet — scan first',
    })
  }

  const currency = yield* captureActiveCurrency()
  const rows = buildExportRows(calculation.data, currency)
  const files = yield* ExportFiles
  const writing =
    input.kind === 'csv'
      ? files.writeCsvFolder(input.outputPath, buildCsvExportFilesFromRows(rows, currency, generated))
      : files.writeJsonFile(input.outputPath, buildJsonExportFromRows(rows, currency, generated))
  return yield* writing.pipe(
    Effect.map(path => ({ ok: true as const, path })),
    Effect.catchTag('ExportFileError', error =>
      Effect.succeed({ ok: false as const, error: exportFileErrorMessage(error) }),
    ),
    Effect.flatMap(result => Schema.decodeUnknownEffect(exportResultSchema)(result)),
  )
})
