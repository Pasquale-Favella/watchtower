import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { ExportFileContent } from '../export-calculation.js'

const exportFileErrorReasonSchema = Schema.Literals([
  'csv-file-target',
  'csv-unmarked-directory',
  'json-directory-target',
  'json-unmarked-file',
  'io-failure',
])

export type ExportFileErrorReason = Schema.Schema.Type<typeof exportFileErrorReasonSchema>

export class ExportFileError extends Schema.TaggedError<ExportFileError>()('ExportFileError', {
  reason: exportFileErrorReasonSchema,
}) {}

export interface ExportFilesPort {
  writeCsvFolder(outputPath: string, files: readonly ExportFileContent[]): Effect.Effect<string, ExportFileError>
  writeJsonFile(outputPath: string, contents: string): Effect.Effect<string, ExportFileError>
}

export class ExportFiles extends Context.Service<ExportFiles, ExportFilesPort>()(
  'watchtower/application/ExportFiles',
) {}

export function exportFileErrorMessage(error: ExportFileError): string {
  switch (error.reason) {
    case 'csv-file-target':
      return 'CSV export needs a folder destination. Choose a folder path.'
    case 'csv-unmarked-directory':
      return 'That folder is not a Watchtower export. Choose a new folder path or a previous Watchtower export.'
    case 'json-directory-target':
      return 'JSON export needs a file destination. Choose a file path.'
    case 'json-unmarked-file':
      return 'That file is not a Watchtower export. Choose a new file or a previous Watchtower export.'
    case 'io-failure':
      return 'Unable to write the export. Check the destination and try again.'
  }
}
