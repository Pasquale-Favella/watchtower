import * as Schema from 'effect/Schema'

import { conversationIdSchema, projectIdSchema, taskIdSchema, workspaceCheckoutIdSchema } from './workspace.js'

export const SIDE_CHAT_CONTEXT_MAX_CHARS = 131072
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
export const createSideChatRequestSchema = Schema.Struct({
  commandId: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(128)),
  parentTaskId: taskIdSchema,
  parentConversationId: conversationIdSchema,
  title: Schema.optional(Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(200))),
  checkoutId: Schema.optional(workspaceCheckoutIdSchema),
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
  request: createSideChatRequestSchema,
})
export type SideChatRecord = Schema.Schema.Type<typeof sideChatRecordSchema>
export const sideChatListSchema = Schema.Struct({ items: Schema.Array(sideChatBindingSchema) })
export class SideChatError extends Schema.TaggedError<SideChatError>()('SideChatError', {
  code: Schema.Literals(['not-found', 'conflict', 'invalid-request', 'unavailable', 'context-unavailable']),
  message: Schema.String,
}) {}
