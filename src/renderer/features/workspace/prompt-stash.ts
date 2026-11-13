import * as Schema from 'effect/Schema'

import { promptAttachmentsSchema } from '@/shared/schemas/prompt-context.js'

const entrySchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  value: Schema.String,
  attachments: promptAttachmentsSchema,
  createdAt: Schema.Number,
})
const stashSchema = Schema.Array(entrySchema).check(Schema.isMaxLength(10))

export type PromptStashEntry = Schema.Schema.Type<typeof entrySchema>

export function readPromptStash(storage: Pick<Storage, 'getItem'>, key: string): readonly PromptStashEntry[] {
  try {
    const serialized = storage.getItem(key)
    if (!serialized) return []
    const decoded = Schema.decodeUnknownOption(stashSchema)(JSON.parse(serialized))
    return decoded._tag === 'Some' ? decoded.value : []
  } catch {
    return []
  }
}

export function writePromptStash(
  storage: Pick<Storage, 'setItem'>,
  key: string,
  entries: readonly PromptStashEntry[],
): void {
  const valid = Schema.decodeUnknownSync(stashSchema)(entries.slice(-10))
  storage.setItem(key, JSON.stringify(valid))
}
