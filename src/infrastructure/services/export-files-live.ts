import { lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'

import { ExportFileError, type ExportFileErrorReason, ExportFiles } from '../../core/ports/export-files.js'
import type { ExportFileContent } from '../../core/analytics/projections/export-calculation.js'
import { mapPlatformCloseCause } from '../platform/platform-file-errors.js'

const EXPORT_MARKER_FILE = '.watchtower-export'

/** Excel on Windows decodes BOM-less CSV as ANSI, garbling non-ASCII project
 * paths and shell commands; a UTF-8 BOM makes it pick the right encoding.
 * Applied to .csv files only (JSON parsers and README.txt must stay raw). */
const CSV_UTF8_BOM = String.fromCharCode(0xfeff)

function fileError(reason: ExportFileErrorReason): ExportFileError {
  return new ExportFileError({ reason })
}

function isMissingNative(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isMissingPlatform(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === 'NotFound'
}

function toFileError(): ExportFileError {
  return fileError('io-failure')
}

function io<A, R>(operation: Effect.Effect<A, PlatformError.PlatformError, R>): Effect.Effect<A, ExportFileError, R> {
  // Each native operation drains on interruption; the next composed operation remains interruptible.
  return Effect.uninterruptible(operation).pipe(Effect.mapError(toFileError))
}

/** The portable FileSystem service has no lstat operation; keep no-follow policy at this narrow leaf. */
const isSymbolicLink = Effect.fnUntraced(function* (path: string): Effect.fn.Return<boolean, ExportFileError> {
  return yield* Effect.uninterruptible(
    Effect.tryPromise({
      try: () => lstat(path),
      catch: error => error,
    }),
  ).pipe(
    Effect.map(stats => stats.isSymbolicLink()),
    Effect.catchIf(isMissingNative, () => Effect.succeed(false)),
    Effect.mapError(toFileError),
  )
})

type ExistingInfo = FileSystem.File.Info | { readonly type: 'SymbolicLink' }

function existingInfo(path: string, fs: FileSystem.FileSystem): Effect.Effect<ExistingInfo | null, ExportFileError> {
  return Effect.gen(function* () {
    if (yield* isSymbolicLink(path)) return { type: 'SymbolicLink' }
    return yield* Effect.uninterruptible(fs.stat(path)).pipe(
      Effect.catchIf(isMissingPlatform, () => Effect.succeed(null)),
      Effect.mapError(toFileError),
    )
  })
}

const clearMarkedFolder = Effect.fnUntraced(function* (
  folder: string,
  fs: FileSystem.FileSystem,
): Effect.fn.Return<void, ExportFileError> {
  const entries = yield* io(fs.readDirectory(folder))
  for (const entry of entries) {
    const child = resolve(folder, entry)
    if (dirname(child) !== folder) return yield* Effect.fail(fileError('io-failure'))
    yield* io(fs.remove(child, { recursive: true, force: true }))
  }
})

const writeCsvExportFilesEffect = Effect.fnUntraced(function* (
  outputPath: string,
  files: readonly ExportFileContent[],
  fs: FileSystem.FileSystem,
): Effect.fn.Return<string, ExportFileError> {
  let folder = resolve(outputPath)
  if (folder.toLowerCase().endsWith('.csv')) folder = folder.slice(0, -4)

  const current = yield* existingInfo(folder, fs)
  if (current?.type === 'SymbolicLink') return yield* Effect.fail(fileError('io-failure'))
  if (current?.type === 'File') return yield* Effect.fail(fileError('csv-file-target'))
  if (current?.type === 'Directory') {
    const marker = yield* existingInfo(resolve(folder, EXPORT_MARKER_FILE), fs)
    if (marker?.type !== 'File') return yield* Effect.fail(fileError('csv-unmarked-directory'))
    yield* clearMarkedFolder(folder, fs)
  }

  yield* io(fs.makeDirectory(folder, { recursive: true }))
  yield* io(fs.writeFileString(resolve(folder, EXPORT_MARKER_FILE), ''))
  for (const file of files)
    yield* io(
      fs.writeFileString(
        join(folder, file.name),
        file.name.endsWith('.csv') ? `${CSV_UTF8_BOM}${file.contents}` : file.contents,
      ),
    )
  return folder
})

const readExistingJsonHeader = Effect.fnUntraced(function* (
  target: string,
  fs: FileSystem.FileSystem,
): Effect.fn.Return<void, ExportFileError> {
  let operationExit: Exit.Exit<void, ExportFileError> | undefined
  const buffer = Buffer.alloc(4096)
  const scopeExit = yield* Effect.exit(
    Effect.uninterruptibleMask(restore =>
      Effect.scoped(
        Effect.gen(function* () {
          const opened = yield* Effect.exit(io(fs.open(target, { flag: 'r', noFollow: process.platform !== 'win32' })))
          if (Exit.isFailure(opened)) {
            operationExit = opened
            return
          }
          operationExit = yield* Effect.exit(
            restore(
              io(opened.value.read(buffer)).pipe(
                Effect.flatMap(bytesRead =>
                  buffer.toString('utf-8', 0, bytesRead).includes('"schema": "watchtower.export.v')
                    ? Effect.void
                    : Effect.fail(fileError('json-unmarked-file')),
                ),
              ),
            ),
          )
        }),
      ),
    ),
  )

  if (Exit.isSuccess(scopeExit)) {
    if (operationExit && Exit.isFailure(operationExit)) return yield* Effect.failCause(operationExit.cause)
    return
  }

  const releaseCause = mapPlatformCloseCause(scopeExit.cause, () => fileError('io-failure')) ?? scopeExit.cause
  return yield* Effect.failCause(
    operationExit && Exit.isFailure(operationExit)
      ? Cause.fromReasons([...operationExit.cause.reasons, ...releaseCause.reasons])
      : releaseCause,
  )
})

const writeJsonExportFileEffect = Effect.fnUntraced(function* (
  outputPath: string,
  contents: string,
  fs: FileSystem.FileSystem,
): Effect.fn.Return<string, ExportFileError> {
  const target = resolve(outputPath.toLowerCase().endsWith('.json') ? outputPath : `${outputPath}.json`)
  const current = yield* existingInfo(target, fs)
  if (current?.type === 'SymbolicLink') return yield* Effect.fail(fileError('io-failure'))
  if (current?.type === 'File') yield* readExistingJsonHeader(target, fs)
  if (current?.type === 'Directory') return yield* Effect.fail(fileError('json-directory-target'))
  yield* io(fs.makeDirectory(dirname(target), { recursive: true }))
  yield* io(fs.writeFileString(target, contents))
  return target
})

export const ExportFilesLive = Layer.effect(
  ExportFiles,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return ExportFiles.of({
      writeCsvFolder: (outputPath, files) => writeCsvExportFilesEffect(outputPath, files, fs),
      writeJsonFile: (outputPath, contents) => writeJsonExportFileEffect(outputPath, contents, fs),
    })
  }),
)
