import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'

import type { ExportResult } from '../../../../shared/schemas/export.js'
import { ensureZipSuffix, zipExportFolder } from '../export-zip.js'
import { ExportFileError, exportFileErrorMessage } from '../../../../core/ports/export-files.js'

export interface ExportCsvZipPorts {
  readonly defaultDirectory: string
  readonly showSaveDialog: (defaultPath: string) => Promise<{ readonly canceled: boolean; readonly filePath?: string }>
  readonly requestCsvFolder: (stagingPath: string) => Promise<ExportResult>
}

class ExportCsvZipError extends Schema.TaggedError<ExportCsvZipError>()('ExportCsvZipError', {
  cause: Schema.Defect(),
}) {}

function failedResult(): ExportResult {
  return {
    ok: false,
    error: exportFileErrorMessage(new ExportFileError({ reason: 'io-failure' })),
  }
}

export const exportCsvZip = Effect.fn('exportCsvZip')(
  function* (
    stamp: string,
    ports: ExportCsvZipPorts,
  ): Effect.fn.Return<ExportResult, ExportCsvZipError, FileSystem.FileSystem> {
    const fs = yield* FileSystem.FileSystem
    const picked = yield* Effect.tryPromise({
      try: () => ports.showSaveDialog(join(ports.defaultDirectory, `watchtower-export-${stamp}.zip`)),
      catch: cause => new ExportCsvZipError({ cause }),
    })
    if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true }

    const zipTarget = ensureZipSuffix(picked.filePath)
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const tempParent = yield* fs.makeTempDirectoryScoped({ prefix: `watchtower-export-${stamp}-` })
        const stagingPath = join(tempParent, `watchtower-export-${stamp}`)
        const folderResult = yield* Effect.uninterruptible(
          Effect.tryPromise({
            try: () => ports.requestCsvFolder(stagingPath),
            catch: cause => new ExportCsvZipError({ cause }),
          }),
        )
        if (!folderResult.ok) return folderResult

        return yield* zipExportFolder(stagingPath, zipTarget, `watchtower-export-${stamp}`).pipe(
          Effect.mapError(cause => new ExportCsvZipError({ cause })),
          Effect.map(path => ({ ok: true as const, path })),
        )
      }),
    ).pipe(Effect.mapError(cause => new ExportCsvZipError({ cause })))
  },
  Effect.catchTag('ExportCsvZipError', () => Effect.succeed(failedResult())),
)
