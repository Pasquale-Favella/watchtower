import * as Schema from 'effect/Schema'

import { agentDriverEventSchema, agentRunSchema } from '@/shared/schemas/execution.js'
import {
  agentRunIdSchema,
  conversationIdSchema,
  projectIdSchema,
  taskIdSchema,
  workspaceCheckoutIdSchema,
} from '@/shared/schemas/workspace.js'

const text = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1))
const timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
)
const optionalText = Schema.optional(Schema.String)

export const workspaceStoreErrorCodeSchema = Schema.Literals([
  'not-found',
  'membership-conflict',
  'command-conflict',
  'admission-conflict',
  'stale-epoch',
  'invalid-transition',
  'invalid-data',
  'database-unavailable',
])
export type WorkspaceStoreErrorCode = Schema.Schema.Type<typeof workspaceStoreErrorCodeSchema>

export class WorkspaceStoreError extends Schema.TaggedError<WorkspaceStoreError>()('WorkspaceStoreError', {
  code: workspaceStoreErrorCodeSchema,
  message: Schema.String,
}) {}

export const registerProjectCommandSchema = Schema.Struct({
  project: Schema.Struct({
    id: projectIdSchema,
    name: text,
    repositoryIdentity: text,
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
  mainCheckout: Schema.Struct({
    id: workspaceCheckoutIdSchema,
    kind: Schema.Literal('main'),
    path: text,
    createdAt: timestamp,
  }),
})
export type RegisterProjectCommand = Schema.Schema.Type<typeof registerProjectCommandSchema>

export const createTaskCommandSchema = Schema.Struct({
  task: Schema.Struct({
    id: taskIdSchema,
    projectId: projectIdSchema,
    title: text,
    description: Schema.String,
    createdAt: timestamp,
  }),
  conversation: Schema.Struct({
    id: conversationIdSchema,
    title: optionalText,
    createdAt: timestamp,
  }),
})
export type CreateTaskCommand = Schema.Schema.Type<typeof createTaskCommandSchema>

export const beginRunCommandSchema = Schema.Struct({
  commandId: text,
  issuedAt: timestamp,
  runId: agentRunIdSchema,
  taskId: taskIdSchema,
  conversationId: conversationIdSchema,
  checkoutId: workspaceCheckoutIdSchema,
  provisionalAgentSessionId: text,
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  driverId: text,
  connectionId: text,
  prompt: Schema.String,
  modelId: Schema.optional(Schema.NullOr(Schema.String)),
  modeId: Schema.optional(Schema.NullOr(Schema.String)),
  nativeSessionId: Schema.optional(Schema.NullOr(Schema.String)),
  retryOfRunId: Schema.optional(Schema.NullOr(agentRunIdSchema)),
})
export type BeginRunCommand = Schema.Schema.Type<typeof beginRunCommandSchema>

export const workerEpochSchema = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))

export const commandReceiptSchema = Schema.Struct({
  commandId: text,
  runId: agentRunIdSchema,
  acceptedAt: timestamp,
  replayed: Schema.Boolean,
})
export type CommandReceipt = Schema.Schema.Type<typeof commandReceiptSchema>

export const dispatchClaimSchema = Schema.Struct({
  runId: agentRunIdSchema,
  projectId: projectIdSchema,
  taskId: taskIdSchema,
  conversationId: conversationIdSchema,
  ownerEpoch: workerEpochSchema,
  provisionalAgentSessionId: text,
  driverId: text,
  connectionId: text,
  checkoutId: workspaceCheckoutIdSchema,
  workspacePath: text,
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  prompt: Schema.String,
  modelId: Schema.optional(Schema.NullOr(Schema.String)),
  modeId: Schema.optional(Schema.NullOr(Schema.String)),
  nativeSessionId: Schema.optional(Schema.NullOr(Schema.String)),
})
export type DispatchClaim = Schema.Schema.Type<typeof dispatchClaimSchema>

export const recordDriverEventCommandSchema = Schema.Struct({
  ownerEpoch: workerEpochSchema,
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  eventId: text,
  occurredAt: timestamp,
  event: agentDriverEventSchema,
})
export type RecordDriverEventCommand = Schema.Schema.Type<typeof recordDriverEventCommandSchema>

export const dispatchFailureCommandSchema = Schema.Struct({
  ownerEpoch: workerEpochSchema,
  occurredAt: timestamp,
  outcome: Schema.Literals(['failed', 'uncertain']),
  reason: Schema.Literals([
    'launch-failed',
    'dispatch-uncertain',
    'event-stream-ended',
    'event-stream-failed',
    'shutdown',
  ]),
})
export type DispatchFailureCommand = Schema.Schema.Type<typeof dispatchFailureCommandSchema>

export const workspaceExecutionEventSchema = Schema.Struct({
  sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literals([
    'runQueued',
    'dispatchClaimed',
    'runStarted',
    'runUncertain',
    'runRecoveryRequired',
    'runFailed',
    'runInterruptRequested',
    'driverEvent',
  ]),
  runId: agentRunIdSchema,
  taskId: taskIdSchema,
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  occurredAt: timestamp,
  data: Schema.Record(Schema.String, Schema.Unknown),
})
export type WorkspaceExecutionEvent = Schema.Schema.Type<typeof workspaceExecutionEventSchema>

export const workspaceEventPageSchema = Schema.Struct({
  events: Schema.Array(workspaceExecutionEventSchema),
  highWatermark: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
})
export type WorkspaceEventPage = Schema.Schema.Type<typeof workspaceEventPageSchema>

export const workspaceSnapshotSchema = Schema.Struct({
  task: Schema.Struct({ id: taskIdSchema, projectId: projectIdSchema, title: text, status: Schema.String }),
  runs: Schema.Array(agentRunSchema),
  highWatermark: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
})
export type WorkspaceSnapshot = Schema.Schema.Type<typeof workspaceSnapshotSchema>
