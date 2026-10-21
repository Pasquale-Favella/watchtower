import { basename, dirname, join, sep } from 'node:path'

import AdmZip from 'adm-zip'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'

export class ExportZipError extends Schema.TaggedError<ExportZipError>()('ExportZipError', {
  cause: Schema.Defect(),
}) {}

const zipError = (cause: unknown): ExportZipError => new ExportZipError({ cause })

/** Formats a local-time timestamp slug for export filenames. */
export function exportStamp(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${day}-${time}`
}

/** Ensures a native save-dialog path ends in .zip. */
export function ensureZipSuffix(target: string): string {
  return target.toLowerCase().endsWith('.zip') ? target : `${target}.zip`
}

/** Atomically archives staging under one top-level folder. */
export const zipExportFolder = Effect.fn('zipExportFolder')(function* (
  staging: string,
  zipTarget: string,
  topName: string,
): Effect.fn.Return<string, ExportZipError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem
  const names = yield* fs.readDirectory(staging, { recursive: true }).pipe(Effect.mapError(zipError))
  const zip = new AdmZip()
  for (const name of names) {
    const path = join(staging, name)
    const info = yield* fs.stat(path).pipe(Effect.mapError(zipError))
    if (info.type !== 'File') continue
    const contents = yield* fs.readFile(path).pipe(Effect.mapError(zipError))
    zip.addFile(`${topName}/${name.split(sep).join('/')}`, Buffer.from(contents))
  }
  const bytes = yield* Effect.try({
    try: () => zip.toBuffer(),
    catch: zipError,
  })
  const targetDirectory = dirname(zipTarget)

  yield* fs.makeDirectory(targetDirectory, { recursive: true }).pipe(Effect.mapError(zipError))

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const temporaryTarget = yield* fs.makeTempFileScoped({
        directory: targetDirectory,
        prefix: `${basename(zipTarget)}.`,
        suffix: '.tmp',
      })
      yield* fs.writeFile(temporaryTarget, bytes)
      yield* fs.rename(temporaryTarget, zipTarget)
      return zipTarget
    }),
  ).pipe(Effect.mapError(zipError))
})
