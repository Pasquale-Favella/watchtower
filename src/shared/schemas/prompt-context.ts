import * as Schema from 'effect/Schema'

import { projectIdSchema, workspaceCheckoutIdSchema } from './workspace.js'

export const PROMPT_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024
export const PROMPT_ATTACHMENT_MAX_COUNT = 8
const name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
export const promptAttachmentSchema = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  name,
  mediaType: Schema.String.check(Schema.isMaxLength(128)),
  size: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(PROMPT_ATTACHMENT_MAX_BYTES),
  ),
  source: Schema.Literals(['file', 'reference', 'skill', 'command']),
})
export const promptAttachmentsSchema = Schema.Array(promptAttachmentSchema).check(
  Schema.isMaxLength(PROMPT_ATTACHMENT_MAX_COUNT),
  Schema.makeFilter(
    items =>
      items.reduce((sum, item) => sum + item.size, 0) <= PROMPT_ATTACHMENT_MAX_BYTES || 'Attachments exceed 4 MiB.',
  ),
)
export type PromptAttachment = Schema.Schema.Type<typeof promptAttachmentSchema>

export interface ResolvedPromptAttachment extends PromptAttachment {
  /** UTF-8 for text, base64 for images and PDF. Resolved only in the application process. */
  readonly content: string
  readonly localPath?: string
}

export const importPromptAttachmentSchema = Schema.Struct({
  name,
  mediaType: Schema.String.check(Schema.isMaxLength(128)),
  data: Schema.String.check(
    Schema.isMaxLength(Math.ceil(PROMPT_ATTACHMENT_MAX_BYTES / 3) * 4),
    Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  ),
})

export const promptContextScopeFields = {
  projectId: projectIdSchema,
  checkoutId: Schema.optional(workspaceCheckoutIdSchema),
}
export const searchPromptContextSchema = Schema.Struct({
  ...promptContextScopeFields,
  kind: Schema.Literals(['file', 'command']),
  query: Schema.String.check(Schema.isMaxLength(256)),
})
export const promptContextItemSchema = Schema.Struct({
  path: name,
  label: name,
  kind: Schema.Literals(['file', 'skill', 'command']),
})
export const promptContextSearchResultSchema = Schema.Struct({
  items: Schema.Array(promptContextItemSchema).check(Schema.isMaxLength(30)),
  truncated: Schema.Boolean,
})
export const attachPromptContextSchema = Schema.Struct({
  ...promptContextScopeFields,
  path: name,
  kind: Schema.Literals(['file', 'skill', 'command']),
})
