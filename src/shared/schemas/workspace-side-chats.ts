import * as Schema from 'effect/Schema'

import {
  agentRunIdSchema,
  conversationIdSchema,
  projectIdSchema,
  taskIdSchema,
  workspaceCheckoutIdSchema,
} from './workspace.js'

export const SIDE_CHAT_CONTEXT_MAX_CHARS = 131072
/** Main-thread activity after the snapshot watermark, prepended to the side chat's first Run. */
export const SIDE_CHAT_FORK_DELTA_MAX_CHARS = 8000
export const SIDE_CHAT_BRING_BACK_MAX_CHARS = 131072
export const SIDE_CHAT_LINE_MAX_CHARS = 240

const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
// A side chat shares its parent's checkout, so the request carries no checkout choice.
export const createSideChatRequestSchema = Schema.Struct({
  commandId: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(128)),
  parentTaskId: taskIdSchema,
  parentConversationId: conversationIdSchema,
  title: Schema.optional(Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(200))),
})
export type CreateSideChatRequest = Schema.Schema.Type<typeof createSideChatRequestSchema>

export const sideChatBindingSchema = Schema.Struct({
  id: text,
  commandId: text,
  parentTaskId: taskIdSchema,
  parentConversationId: conversationIdSchema,
  taskId: taskIdSchema,
  conversationId: conversationIdSchema,
  projectId: projectIdSchema,
  checkoutId: workspaceCheckoutIdSchema,
  parentHighWatermark: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  contextTruncated: Schema.Boolean,
  title: Schema.String,
  createdAt: Schema.String,
})
export type SideChatBinding = Schema.Schema.Type<typeof sideChatBindingSchema>

export const sideChatRecordSchema = Schema.Struct({
  binding: sideChatBindingSchema,
  context: Schema.String.check(Schema.isMaxLength(SIDE_CHAT_CONTEXT_MAX_CHARS)),
  // Receipts written before side chats shared their parent's checkout may still carry checkoutId.
  request: Schema.Struct({
    ...createSideChatRequestSchema.fields,
    checkoutId: Schema.optional(workspaceCheckoutIdSchema),
  }),
})
export type SideChatRecord = Schema.Schema.Type<typeof sideChatRecordSchema>

export const sideChatListSchema = Schema.Struct({ items: Schema.Array(sideChatBindingSchema) })

export const sideChatBringBackRequestSchema = Schema.Struct({ id: text })
export type SideChatBringBackRequest = Schema.Schema.Type<typeof sideChatBringBackRequestSchema>

export const sideChatBringBackReceiptSchema = Schema.Struct({
  bringBackId: text,
  sideChatId: text,
  sourceRunId: agentRunIdSchema,
  supersedesBringBackId: Schema.NullOr(text),
  truncated: Schema.Boolean,
  createdAt: Schema.String,
})
export type SideChatBringBackReceipt = Schema.Schema.Type<typeof sideChatBringBackReceiptSchema>

export const sideChatDeleteRequestSchema = Schema.Struct({
  id: text,
  /** Close-time delete: keeps the side chat when it already has Runs. */
  onlyIfUnused: Schema.optional(Schema.Boolean),
})
export type SideChatDeleteRequest = Schema.Schema.Type<typeof sideChatDeleteRequestSchema>

export const sideChatDeleteReceiptSchema = Schema.Struct({ id: text, deleted: Schema.Boolean })
export type SideChatDeleteReceipt = Schema.Schema.Type<typeof sideChatDeleteReceiptSchema>

export class SideChatError extends Schema.TaggedError<SideChatError>()('SideChatError', {
  code: Schema.Literals([
    'not-found',
    'conflict',
    'invalid-request',
    'unavailable',
    'context-unavailable',
    'nested', // a side chat cannot start a side chat
    'parent-busy', // the parent Conversation has an active or queued Run, or a queued follow-up
    'no-finished-reply', // the side chat has no finished Run to bring back
    'bring-back-pending', // another side chat holds the parent's pending bring-back
  ]),
  message: Schema.String,
}) {}
