import * as Schema from 'effect/Schema'

const nonBlank = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1))
const id = nonBlank
const timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
)
const optionalText = Schema.optional(Schema.String)
const optionalTimestamp = Schema.optional(Schema.NullOr(timestamp))

export const projectIdSchema = id.pipe(Schema.brand('ProjectId'))
export type ProjectId = Schema.Schema.Type<typeof projectIdSchema>

export const workspaceCheckoutIdSchema = id.pipe(Schema.brand('WorkspaceCheckoutId'))
export type WorkspaceCheckoutId = Schema.Schema.Type<typeof workspaceCheckoutIdSchema>

export const taskIdSchema = id.pipe(Schema.brand('TaskId'))
export type TaskId = Schema.Schema.Type<typeof taskIdSchema>

export const conversationIdSchema = id.pipe(Schema.brand('ConversationId'))
export type ConversationId = Schema.Schema.Type<typeof conversationIdSchema>

export const agentSessionIdSchema = id.pipe(Schema.brand('AgentSessionId'))
export type AgentSessionId = Schema.Schema.Type<typeof agentSessionIdSchema>

export const agentRunIdSchema = id.pipe(Schema.brand('AgentRunId'))
export type AgentRunId = Schema.Schema.Type<typeof agentRunIdSchema>

export const projectSchema = Schema.Struct({
  id: projectIdSchema,
  name: nonBlank,
  repositoryIdentity: nonBlank,
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: optionalTimestamp,
})
export type Project = Schema.Schema.Type<typeof projectSchema>

export const workspaceCheckoutSchema = Schema.Struct({
  id: workspaceCheckoutIdSchema,
  projectId: projectIdSchema,
  kind: Schema.Literals(['main', 'worktree', 'directory']),
  path: nonBlank,
  environmentId: optionalText,
  branch: optionalText,
  createdAt: timestamp,
  archivedAt: optionalTimestamp,
})
export type WorkspaceCheckout = Schema.Schema.Type<typeof workspaceCheckoutSchema>

export const taskStatusSchema = Schema.Literals(['open', 'inProgress', 'blocked', 'inReview', 'completed', 'archived'])
export type TaskStatus = Schema.Schema.Type<typeof taskStatusSchema>

export const taskSchema = Schema.Struct({
  id: taskIdSchema,
  projectId: projectIdSchema,
  title: nonBlank,
  description: Schema.String,
  status: taskStatusSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
  completedAt: optionalTimestamp,
  archivedAt: optionalTimestamp,
})
export type Task = Schema.Schema.Type<typeof taskSchema>

export const conversationSchema = Schema.Struct({
  id: conversationIdSchema,
  taskId: taskIdSchema,
  title: optionalText,
  createdAt: timestamp,
  updatedAt: timestamp,
  forkedFromConversationId: Schema.optional(Schema.NullOr(conversationIdSchema)),
  forkedAtMessageId: optionalText,
})
export type Conversation = Schema.Schema.Type<typeof conversationSchema>

export const agentSessionSchema = Schema.Struct({
  id: agentSessionIdSchema,
  taskId: taskIdSchema,
  conversationId: conversationIdSchema,
  checkoutId: workspaceCheckoutIdSchema,
  connectionId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  driverId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  nativeSessionId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  protocolVersion: optionalText,
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  status: Schema.Literals(['active', 'suspended', 'closed', 'unavailable']),
  createdAt: timestamp,
  updatedAt: timestamp,
})
export type AgentSession = Schema.Schema.Type<typeof agentSessionSchema>
