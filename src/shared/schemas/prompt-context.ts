import * as Schema from 'effect/Schema'

import { conversationIdSchema, projectIdSchema, taskIdSchema, workspaceCheckoutIdSchema } from './workspace.js'

export const PROMPT_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024
export const PROMPT_ATTACHMENT_MAX_COUNT = 8
export const WORKSPACE_PROMPT_MAX_LENGTH = 120_000
export const PROMPT_CONTEXT_SEARCH_MAX_RESULTS = 2048
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
  /** Captured invocation name for checkout-local aliases and nested commands. */
  token: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))),
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
  projectId: Schema.optional(projectIdSchema),
  checkoutId: Schema.optional(workspaceCheckoutIdSchema),
  connectionId: Schema.optional(Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(128))),
  excludeTaskId: Schema.optional(taskIdSchema),
  excludeConversationId: Schema.optional(conversationIdSchema),
  kind: Schema.Literals(['file', 'command', 'pullRequest']),
  query: Schema.String.check(Schema.isMaxLength(256)),
})
export const promptContextItemSchema = Schema.Struct({
  path: name,
  label: name,
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  kind: Schema.Literals(['file', 'skill', 'command', 'providerSkill', 'providerCommand', 'model', 'conversation', 'pullRequest']),
})
export const promptContextSearchResultSchema = Schema.Struct({
  items: Schema.Array(promptContextItemSchema).check(Schema.isMaxLength(PROMPT_CONTEXT_SEARCH_MAX_RESULTS)),
  truncated: Schema.Boolean,
})
export type PromptContextSearchResult = {
  items: Array<Schema.Schema.Type<typeof promptContextItemSchema>>
  truncated: boolean
}
export const attachPromptContextSchema = Schema.Struct({
  projectId: Schema.optional(projectIdSchema),
  checkoutId: Schema.optional(workspaceCheckoutIdSchema),
  path: name,
  kind: Schema.Literals(['file', 'skill', 'command']),
})

export const resolvePromptReferenceSchema = Schema.Struct({
  projectId: Schema.optional(projectIdSchema),
  checkoutId: Schema.optional(workspaceCheckoutIdSchema),
  kind: Schema.Literals(['conversation', 'pullRequest']),
  path: name,
})
export const resolvedPromptReferenceSchema = Schema.Struct({ text: Schema.String.check(Schema.isMaxLength(4096)) })

export const promptConversationSearchSchema = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(256)),
  excludeConversationId: Schema.optional(conversationIdSchema),
})
export const promptConversationMatchSchema = Schema.Struct({
  conversationId: conversationIdSchema,
  taskId: taskIdSchema,
  title: Schema.String.check(Schema.isMaxLength(512)),
})
export const promptConversationMatchesSchema = Schema.Array(promptConversationMatchSchema).check(Schema.isMaxLength(8))
