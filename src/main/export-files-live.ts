import { lstat, mkdir, open, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { ExportFileError, type ExportFileErrorReason, ExportFiles } from './application/export-files.js'
import type { ExportFileContent } from './export-calculation.js'

const EXPORT_MARKER_FILE = '.watchtower-export'

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function existingPath(path: string) {
  return lstat(path).catch(error => (isMissing(error) ? null : Promise.reject(error)))
}

function fileError(reason: ExportFileErrorReason): ExportFileError {
  return new ExportFileError({ reason })
}

function toFileError(error: unknown): ExportFileError {
  return error instanceof ExportFileError ? error : fileError('io-failure')
}

async function clearMarkedFolder(folder: string): Promise<void> {
  const entries = await readdir(folder)
  for (const entry of entries) {
    const child = resolve(folder, entry)
    if (dirname(child) !== folder) return await Promise.reject(fileError('io-failure'))
    await rm(child, { recursive: true, force: true })
  }
}

export async function writeCsvExportFiles(outputPath: string, files: readonly ExportFileContent[]): Promise<string> {
  try {
    let folder = resolve(outputPath)
    if (folder.toLowerCase().endsWith('.csv')) folder = folder.slice(0, -4)

    const current = await existingPath(folder)
    if (current?.isSymbolicLink()) return await Promise.reject(fileError('io-failure'))
    if (current?.isFile()) return await Promise.reject(fileError('csv-file-target'))
    if (current?.isDirectory()) {
      const marker = await existingPath(join(folder, EXPORT_MARKER_FILE))
      if (!marker?.isFile() || marker.isSymbolicLink()) return await Promise.reject(fileError('csv-unmarked-directory'))
      await clearMarkedFolder(folder)
    }

    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, EXPORT_MARKER_FILE), '', 'utf-8')
    for (const file of files) await writeFile(join(folder, file.name), file.contents, 'utf-8')
    return folder
  } catch (error) {
    return await Promise.reject(toFileError(error))
  }
}

export async function writeJsonExportFile(outputPath: string, contents: string): Promise<string> {
  try {
    const target = resolve(outputPath.toLowerCase().endsWith('.json') ? outputPath : `${outputPath}.json`)
    const current = await existingPath(target)
    if (current?.isSymbolicLink()) return await Promise.reject(fileError('io-failure'))
    if (current?.isFile()) {
      const handle = await open(target, 'r')
      try {
        const buffer = Buffer.alloc(4096)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        if (!buffer.toString('utf-8', 0, bytesRead).includes('"schema": "watchtower.export.v')) {
          return await Promise.reject(fileError('json-unmarked-file'))
        }
      } finally {
        await handle.close()
      }
    }
    if (current?.isDirectory()) return await Promise.reject(fileError('json-directory-target'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents, 'utf-8')
    return target
  } catch (error) {
    return await Promise.reject(toFileError(error))
  }
}

export const ExportFilesLive = Layer.succeed(
  ExportFiles,
  ExportFiles.of({
    writeCsvFolder: (outputPath, files) =>
      Effect.tryPromise({
        try: () => writeCsvExportFiles(outputPath, files),
        catch: toFileError,
      }),
    writeJsonFile: (outputPath, contents) =>
      Effect.tryPromise({
        try: () => writeJsonExportFile(outputPath, contents),
        catch: toFileError,
      }),
  }),
)
