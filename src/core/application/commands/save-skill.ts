import { dirname } from 'node:path'

import * as Effect from 'effect/Effect'
import * as FileSystem from '../../ports/filesystem.js'
import * as PlatformError from 'effect/PlatformError'
import * as Schema from 'effect/Schema'

export class SaveSkillError extends Schema.TaggedError<SaveSkillError>()('SaveSkillError', {
  message: Schema.String,
}) {}

function saveSkillError(cause: unknown): SaveSkillError {
  const message =
    cause instanceof PlatformError.PlatformError && cause.reason.cause instanceof Error
      ? cause.reason.cause.message
      : cause instanceof Error
        ? cause.message
        : String(cause)
  return new SaveSkillError({ message })
}

/** Create a skill's parent directory, then write the dialog-approved file. */
export const saveSkill = Effect.fn('saveSkill')(function* (
  targetPath: string,
  content: string,
): Effect.fn.Return<string, SaveSkillError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem
  yield* Effect.uninterruptible(fs.makeDirectory(dirname(targetPath), { recursive: true })).pipe(
    Effect.mapError(saveSkillError),
  )
  yield* Effect.uninterruptible(fs.writeFileString(targetPath, content, { flag: 'w' })).pipe(
    Effect.mapError(saveSkillError),
  )
  return targetPath
})
