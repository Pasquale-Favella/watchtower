import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

export class SaveSkillError extends Schema.TaggedError<SaveSkillError>()('SaveSkillError', {
  message: Schema.String,
}) {}

function saveSkillError(cause: unknown): SaveSkillError {
  return new SaveSkillError({ message: cause instanceof Error ? cause.message : String(cause) })
}

/** Create a skill's parent directory, then write the dialog-approved file. */
export const saveSkill = Effect.fn('saveSkill')(function* (
  targetPath: string,
  content: string,
): Effect.fn.Return<string, SaveSkillError> {
  yield* Effect.tryPromise({
    try: () => mkdir(dirname(targetPath), { recursive: true }),
    catch: saveSkillError,
  })
  yield* Effect.tryPromise({
    try: () => writeFile(targetPath, content, 'utf8'),
    catch: saveSkillError,
  })
  return targetPath
})
