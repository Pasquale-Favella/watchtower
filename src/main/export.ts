import { buildCsvExportFiles, buildJsonExport } from './export-calculation.js'
import { writeCsvExportFiles, writeJsonExportFile } from './export-files-live.js'
import { getActiveCurrency } from './fx.js'
import type { ProjectSummary } from './pipeline/types.js'
import type { LedgerStore } from './store/ledger.js'

export type { ExportResult } from '../shared/schemas/export.js'

/**
 * Compatibility bridge for callers still holding LedgerStore.
 * Removal condition: migrate every remaining production and test caller to
 * queryExport or the pure builders, then delete these wrappers.
 */
export async function exportCsv(projects: ProjectSummary[], outputPath: string, store: LedgerStore): Promise<string> {
  const currency = getActiveCurrency(store)
  const generated = new Date().toISOString()
  return writeCsvExportFiles(outputPath, buildCsvExportFiles(projects, currency, generated))
}

/** Compatibility bridge; see exportCsv for its removal condition. */
export async function exportJson(projects: ProjectSummary[], outputPath: string, store: LedgerStore): Promise<string> {
  const currency = getActiveCurrency(store)
  const generated = new Date().toISOString()
  return writeJsonExportFile(outputPath, buildJsonExport(projects, currency, generated))
}
