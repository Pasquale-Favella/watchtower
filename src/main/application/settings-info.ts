import { Effect, Result, Schema } from 'effect'
import type { Dirent, Stats } from 'fs'
import { readdir, stat } from 'fs/promises'
import { join } from 'path'

import { getClaudeConfigDirsEffect } from '../pipeline/providers/claude.js'

export interface SettingsInfo {
  dataDir: string
  dbSize: number
  dataDirSize: number
  cacheDir: string
  cacheSize: number
  claudeConfigDirs?: string[]
}

export class SettingsInfoIoError extends Schema.TaggedError<SettingsInfoIoError>()('SettingsInfoIoError', {
  path: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface SettingsInfoFileSystem {
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>
  stat(path: string): Promise<Stats>
}

export interface SettingsInfoDependencies {
  readonly fileSystem?: SettingsInfoFileSystem
  readonly getClaudeConfigDirs?: () => Effect.Effect<string[], Error>
}

const nativeFileSystem: SettingsInfoFileSystem = { readdir, stat }

function readdirEffect(path: string, fileSystem: SettingsInfoFileSystem): Effect.Effect<Dirent[], SettingsInfoIoError> {
  return Effect.uninterruptible(
    Effect.tryPromise({
      try: () => fileSystem.readdir(path, { withFileTypes: true }),
      catch: cause => new SettingsInfoIoError({ path, cause }),
    }),
  )
}

function statEffect(path: string, fileSystem: SettingsInfoFileSystem): Effect.Effect<Stats, SettingsInfoIoError> {
  return Effect.uninterruptible(
    Effect.tryPromise({
      try: () => fileSystem.stat(path),
      catch: cause => new SettingsInfoIoError({ path, cause }),
    }),
  )
}

const dirSizeEffect = Effect.fnUntraced(function* (
  path: string,
  fileSystem: SettingsInfoFileSystem,
): Effect.fn.Return<number> {
  const entries = yield* Effect.result(readdirEffect(path, fileSystem))
  if (Result.isFailure(entries)) return 0

  let total = 0
  for (const entry of entries.success) {
    const full = join(path, entry.name)
    if (entry.isDirectory()) {
      total += yield* dirSizeEffect(full, fileSystem)
    } else if (entry.isFile()) {
      const result = yield* Effect.result(statEffect(full, fileSystem))
      if (Result.isFailure(result)) return total
      total += result.success.size
    }
  }
  return total
})

export const settingsInfoEffect = Effect.fnUntraced(function* (
  dataDir: string,
  cacheDir: string,
  dependencies: SettingsInfoDependencies = {},
): Effect.fn.Return<SettingsInfo> {
  const fileSystem = dependencies.fileSystem ?? nativeFileSystem
  const claudeDirs = yield* Effect.result((dependencies.getClaudeConfigDirs ?? (() => getClaudeConfigDirsEffect()))())
  const dbStat = yield* Effect.result(statEffect(join(dataDir, 'ledger.db'), fileSystem))
  const dataDirSize = yield* dirSizeEffect(dataDir, fileSystem)
  const cacheSize = yield* dirSizeEffect(cacheDir, fileSystem)

  return {
    dataDir,
    dbSize: Result.isSuccess(dbStat) ? dbStat.success.size : 0,
    dataDirSize,
    cacheDir,
    cacheSize,
    ...(claudeDirs._tag === 'Success' ? { claudeConfigDirs: claudeDirs.success } : {}),
  }
})
