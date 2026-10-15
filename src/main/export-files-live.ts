import { lstat, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'

import { ExportFileError, type ExportFileErrorReason, ExportFiles } from './application/export-files.js'
import type { ExportFileContent } from './export-calculation.js'

const EXPORT_MARKER_FILE = '.watchtower-export'

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function fileError(reason: ExportFileErrorReason): ExportFileError {
  return new ExportFileError({ reason })
}

function toFileError(error: unknown): ExportFileError {
  return error instanceof ExportFileError ? error : fileError('io-failure')
}

function io<A>(run: () => Promise<A>): Effect.Effect<A, ExportFileError> {
  // Drain one filesystem operation if interrupted; the next composed operation remains interruptible.
  return Effect.uninterruptible(Effect.tryPromise({ try: run, catch: toFileError }))
}

function existingPath(path: string): Effect.Effect<Awaited<ReturnType<typeof lstat>> | null, ExportFileError> {
  return Effect.tryPromise({ try: () => lstat(path), catch: error => error }).pipe(
    Effect.catchIf(isMissing, () => Effect.succeed(null)),
    Effect.mapError(toFileError),
  )
}

const clearMarkedFolder = Effect.fnUntraced(function* (folder: string): Effect.fn.Return<void, ExportFileError> {
  const entries = yield* io(() => readdir(folder))
  for (const entry of entries) {
    const child = resolve(folder, entry)
    if (dirname(child) !== folder) return yield* Effect.fail(fileError('io-failure'))
    yield* io(() => rm(child, { recursive: true, force: true }))
  }
})

const writeCsvExportFilesEffect = Effect.fnUntraced(function* (
  outputPath: string,
  files: readonly ExportFileContent[],
): Effect.fn.Return<string, ExportFileError> {
  let folder = resolve(outputPath)
  if (folder.toLowerCase().endsWith('.csv')) folder = folder.slice(0, -4)

  const current = yield* existingPath(folder)
  if (current?.isSymbolicLink()) return yield* Effect.fail(fileError('io-failure'))
  if (current?.isFile()) return yield* Effect.fail(fileError('csv-file-target'))
  if (current?.isDirectory()) {
    const marker = yield* existingPath(resolve(folder, EXPORT_MARKER_FILE))
    if (!marker?.isFile() || marker.isSymbolicLink()) return yield* Effect.fail(fileError('csv-unmarked-directory'))
    yield* clearMarkedFolder(folder)
  }

  yield* io(() => mkdir(folder, { recursive: true }))
  yield* io(() => writeFile(resolve(folder, EXPORT_MARKER_FILE), '', 'utf-8'))
  for (const file of files) yield* io(() => writeFile(join(folder, file.name), file.contents, 'utf-8'))
  return folder
})

interface OpenExportFile {
  readonly handle: Awaited<ReturnType<typeof open>>
  closed: boolean
}

function closeHandle(resource: OpenExportFile): Effect.Effect<void, ExportFileError> {
  return Effect.suspend(() => {
    if (resource.closed) return Effect.void
    resource.closed = true
    return io(() => resource.handle.close())
  })
}

function readExistingJsonHeader(target: string): Effect.Effect<void, ExportFileError> {
  return Effect.scoped(
    Effect.acquireRelease(
      io(() => open(target, 'r')).pipe(Effect.map(handle => ({ handle, closed: false }))),
      resource => closeHandle(resource).pipe(Effect.orDie),
    ).pipe(
      Effect.flatMap(resource =>
        Effect.uninterruptibleMask(restore =>
          Effect.gen(function* () {
            const result = yield* Effect.exit(restore(readJsonHeaderEffect(resource)))
            const closeResult = yield* Effect.exit(closeHandle(resource))
            if (!Exit.isSuccess(closeResult)) return yield* Effect.failCause(closeResult.cause)
            if (!Exit.isSuccess(result)) return yield* Effect.failCause(result.cause)
          }),
        ),
      ),
    ),
  )
}

const readJsonHeaderEffect = Effect.fnUntraced(function* (
  resource: OpenExportFile,
): Effect.fn.Return<void, ExportFileError> {
  const buffer = Buffer.alloc(4096)
  const { bytesRead } = yield* io(() => resource.handle.read(buffer, 0, buffer.length, 0))
  if (!buffer.toString('utf-8', 0, bytesRead).includes('"schema": "watchtower.export.v')) {
    return yield* Effect.fail(fileError('json-unmarked-file'))
  }
})

const writeJsonExportFileEffect = Effect.fnUntraced(function* (
  outputPath: string,
  contents: string,
): Effect.fn.Return<string, ExportFileError> {
  const target = resolve(outputPath.toLowerCase().endsWith('.json') ? outputPath : `${outputPath}.json`)
  const current = yield* existingPath(target)
  if (current?.isSymbolicLink()) return yield* Effect.fail(fileError('io-failure'))
  if (current?.isFile()) yield* readExistingJsonHeader(target)
  if (current?.isDirectory()) return yield* Effect.fail(fileError('json-directory-target'))
  yield* io(() => mkdir(dirname(target), { recursive: true }))
  yield* io(() => writeFile(target, contents, 'utf-8'))
  return target
})

export const ExportFilesLive = Layer.succeed(
  ExportFiles,
  ExportFiles.of({
    writeCsvFolder: writeCsvExportFilesEffect,
    writeJsonFile: writeJsonExportFileEffect,
  }),
)
