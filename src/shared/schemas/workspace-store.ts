import * as Schema from 'effect/Schema'

import {
  agentDriverEventSchema,
  agentRequestDecisionSchema,
  agentRequestSchema,
  agentRunSchema,
} from '@/shared/schemas/execution.js'
import {
  agentRunIdSchema,
  agentSessionIdSchema,
  conversationIdSchema,
  projectIdSchema,
  projectSchema,
  taskIdSchema,
  taskSchema,
  workspaceCheckoutIdSchema,
  workspaceCheckoutSchema,
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
  'stale-request',
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

export const workerEpochSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)

export const ownerEpochAcquisitionSchema = Schema.Struct({
  ownerEpoch: workerEpochSchema,
  recoveredCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
})
export type OwnerEpochAcquisition = Schema.Schema.Type<typeof ownerEpochAcquisitionSchema>

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

export const nativeSessionBindingSchema = Schema.Struct({
  ownerEpoch: workerEpochSchema,
  nativeSessionId: text,
  generation: beginRunCommandSchema.fields.generation,
  recordedAt: timestamp,
})
export type NativeSessionBinding = Schema.Schema.Type<typeof nativeSessionBindingSchema>

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

export const deliveryOutcomeSchema = Schema.Struct({
  outcome: Schema.Literals(['accepted', 'failed', 'uncertain']),
  nativeConfirmation: Schema.optional(Schema.Literals(['confirmed', 'unconfirmed'])),
  nativeRequestId: Schema.optional(text),
})
export type WorkspaceDeliveryOutcome = Schema.Schema.Type<typeof deliveryOutcomeSchema>

export const settleDeliveryCommandSchema = Schema.Struct({
  ...deliveryOutcomeSchema.fields,
  ownerEpoch: workerEpochSchema,
  occurredAt: timestamp,
})
export type SettleDeliveryCommand = Schema.Schema.Type<typeof settleDeliveryCommandSchema>

export const recordRequestResponseCommandSchema = Schema.Struct({
  commandId: text,
  issuedAt: timestamp,
  runId: agentRunIdSchema,
  ownerEpoch: workerEpochSchema,
  generation: beginRunCommandSchema.fields.generation,
  requestId: text,
  decision: agentRequestDecisionSchema,
})
export type RecordRequestResponseCommand = Schema.Schema.Type<typeof recordRequestResponseCommandSchema>

export const requestResponseIntentSchema = Schema.Struct({
  ...recordRequestResponseCommandSchema.fields,
  state: Schema.Literals(['pending', 'accepted', 'failed', 'uncertain', 'resolved']),
  delivery: Schema.optional(deliveryOutcomeSchema),
  recoveryReason: Schema.optional(Schema.Literal('worker-replaced')),
})
export type RequestResponseIntent = Schema.Schema.Type<typeof requestResponseIntentSchema>

export const recordSteerCommandSchema = Schema.Struct({
  commandId: text,
  issuedAt: timestamp,
  runId: agentRunIdSchema,
  ownerEpoch: workerEpochSchema,
  generation: beginRunCommandSchema.fields.generation,
  expectedNativeTurnId: Schema.optional(text),
  message: text,
})
export type RecordSteerCommand = Schema.Schema.Type<typeof recordSteerCommandSchema>

export const steerIntentSchema = Schema.Struct({
  ...recordSteerCommandSchema.fields,
  state: Schema.Literals(['pending', 'accepted', 'failed', 'uncertain']),
  delivery: Schema.optional(deliveryOutcomeSchema),
  recoveryReason: Schema.optional(Schema.Literal('worker-replaced')),
})
export type SteerIntent = Schema.Schema.Type<typeof steerIntentSchema>

export const enqueueFollowUpCommandSchema = Schema.Struct({
  commandId: text,
  issuedAt: timestamp,
  taskId: taskIdSchema,
  conversationId: conversationIdSchema,
  prompt: Schema.String,
  driverId: Schema.optional(text),
  connectionId: Schema.optional(text),
  modelId: beginRunCommandSchema.fields.modelId,
  modeId: beginRunCommandSchema.fields.modeId,
})
export type EnqueueFollowUpCommand = Schema.Schema.Type<typeof enqueueFollowUpCommandSchema>

export const followUpReceiptSchema = Schema.Struct({
  commandId: text,
  conversationId: conversationIdSchema,
  acceptedAt: timestamp,
  replayed: Schema.Boolean,
})
export type FollowUpReceipt = Schema.Schema.Type<typeof followUpReceiptSchema>

export const queuedFollowUpSchema = Schema.Struct({
  ...enqueueFollowUpCommandSchema.fields,
  position: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
})
export type QueuedFollowUp = Schema.Schema.Type<typeof queuedFollowUpSchema>

export const WORKSPACE_STORE_COMMAND_BYTE_CAPACITY = 1024 * 1024
export const workspaceReadPageOptionsSchema = Schema.Struct({
  afterPosition: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50)),
  ),
})
export type WorkspaceReadPageOptions = Schema.Schema.Type<typeof workspaceReadPageOptionsSchema>
export const workspaceEntityPageOptionsSchema = Schema.Struct({
  afterId: Schema.optional(text),
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50)),
  ),
})
export type WorkspaceEntityPageOptions = Schema.Schema.Type<typeof workspaceEntityPageOptionsSchema>
export const workspaceCheckoutPageOptionsSchema = Schema.Struct({
  afterCheckoutId: Schema.optional(text),
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50)),
  ),
})
export type WorkspaceCheckoutPageOptions = Schema.Schema.Type<typeof workspaceCheckoutPageOptionsSchema>

const readPageFields = {
  total: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  truncated: Schema.Boolean,
  nextAfterPosition: Schema.NullOr(queuedFollowUpSchema.fields.position),
}
export const queuedFollowUpPageSchema = Schema.Struct({ ...readPageFields, items: Schema.Array(queuedFollowUpSchema) })
export type QueuedFollowUpPage = Schema.Schema.Type<typeof queuedFollowUpPageSchema>
export const requestResponseHistoryItemSchema = Schema.Struct({
  ...requestResponseIntentSchema.fields,
  position: queuedFollowUpSchema.fields.position,
})
export const requestResponsePageSchema = Schema.Struct({
  ...readPageFields,
  items: Schema.Array(requestResponseHistoryItemSchema),
})
export type RequestResponsePage = Schema.Schema.Type<typeof requestResponsePageSchema>
export const steerHistoryItemSchema = Schema.Struct({
  ...steerIntentSchema.fields,
  position: queuedFollowUpSchema.fields.position,
})
export const steerIntentPageSchema = Schema.Struct({ ...readPageFields, items: Schema.Array(steerHistoryItemSchema) })
export type SteerIntentPage = Schema.Schema.Type<typeof steerIntentPageSchema>

export const queuedFollowUpPreviewSchema = Schema.Struct({
  commandId: text,
  taskId: taskIdSchema,
  conversationId: conversationIdSchema,
  issuedAt: timestamp,
  position: queuedFollowUpSchema.fields.position,
  promptByteLength: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  promptPreview: Schema.String,
})
const snapshotSectionSummarySchema = Schema.Struct({
  total: readPageFields.total,
  truncated: Schema.Boolean,
  pendingCount: Schema.optional(readPageFields.total),
  uncertainCount: Schema.optional(readPageFields.total),
})
export const requestResponseSnapshotSchema = Schema.Struct({
  ...requestResponseIntentSchema.fields,
  decision: Schema.optional(agentRequestDecisionSchema),
  decisionKind: Schema.optional(Schema.String),
  payloadTruncated: Schema.optional(Schema.Boolean),
})
export const steerIntentSnapshotSchema = Schema.Struct({
  ...steerIntentSchema.fields,
  message: Schema.optional(Schema.String),
  messagePreview: Schema.optional(Schema.String),
  payloadTruncated: Schema.optional(Schema.Boolean),
})

export const promotedFollowUpSchema = Schema.Struct({
  followUp: queuedFollowUpSchema,
  receipt: commandReceiptSchema,
})
export type PromotedFollowUp = Schema.Schema.Type<typeof promotedFollowUpSchema>

export const WORKSPACE_STORE_READ_BYTE_CAPACITY = 3 * 1024 * 1024
export const workspacePayloadReferenceSchema = Schema.Struct({
  kind: Schema.Literals(['project', 'checkout', 'task', 'conversation', 'agentSession', 'event', 'message']),
  id: text,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
})
export type WorkspacePayloadReference = Schema.Schema.Type<typeof workspacePayloadReferenceSchema>
const payloadSummaryFields = {
  payloadTruncated: Schema.optional(Schema.Literal(true)),
  payloadRef: Schema.optional(workspacePayloadReferenceSchema),
}
export const workspacePayloadPageOptionsSchema = Schema.Struct({
  reference: workspacePayloadReferenceSchema,
  afterOffset: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  limit: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(65536)),
})
export const workspacePayloadPageSchema = Schema.Struct({
  json: Schema.String,
  total: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  nextAfterOffset: Schema.NullOr(workspacePayloadPageOptionsSchema.fields.afterOffset),
  truncated: Schema.Boolean,
})
export type WorkspacePayloadPage = Schema.Schema.Type<typeof workspacePayloadPageSchema>
export const workspaceProjectReadSchema = Schema.Struct({ ...projectSchema.fields, ...payloadSummaryFields })
export const workspaceCheckoutReadSchema = Schema.Struct({ ...workspaceCheckoutSchema.fields, ...payloadSummaryFields })
export const workspaceTaskReadSchema = Schema.Struct({ ...taskSchema.fields, ...payloadSummaryFields })

export const workspaceExecutionEventSchema = Schema.Struct({
  ...payloadSummaryFields,
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
    'requestResponseRecorded',
    'requestResponseSettled',
    'steerRecorded',
    'steerSettled',
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
  nextAfterSequence: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  hasMore: Schema.Boolean,
})
export type WorkspaceEventPage = Schema.Schema.Type<typeof workspaceEventPageSchema>
const sequenceCursor = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
export const workspaceEventPageOptionsSchema = Schema.Struct({
  afterSequence: sequenceCursor,
  throughSequence: Schema.optional(sequenceCursor),
  limit: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(500)),
}).check(
  Schema.makeFilter(value => value.throughSequence === undefined || value.afterSequence <= value.throughSequence),
)
export type WorkspaceEventPageOptions = Schema.Schema.Type<typeof workspaceEventPageOptionsSchema>
export const workspacePendingRuntimeRequestPageOptionsSchema = Schema.Struct({
  afterSequence: sequenceCursor,
  limit: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50)),
})

export const workspaceProjectReadPageSchema = Schema.Struct({
  items: Schema.Array(workspaceProjectReadSchema),
  total: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  nextAfterId: Schema.NullOr(projectIdSchema),
})
export type WorkspaceProjectReadPage = Schema.Schema.Type<typeof workspaceProjectReadPageSchema>

export const workspaceProjectDetailSchema = Schema.Struct({
  project: workspaceProjectReadSchema,
  mainCheckout: workspaceCheckoutReadSchema,
  otherCheckouts: Schema.Array(workspaceCheckoutReadSchema),
  totalOtherCheckouts: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  nextAfterCheckoutId: Schema.NullOr(workspaceCheckoutIdSchema),
})
export type WorkspaceProjectDetail = Schema.Schema.Type<typeof workspaceProjectDetailSchema>

export const workspaceTaskReadPageSchema = Schema.Struct({
  items: Schema.Array(workspaceTaskReadSchema),
  total: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  nextAfterId: Schema.NullOr(taskIdSchema),
})
export type WorkspaceTaskReadPage = Schema.Schema.Type<typeof workspaceTaskReadPageSchema>

export const workspaceConversationReadSchema = Schema.Struct({
  ...payloadSummaryFields,
  id: conversationIdSchema,
  taskId: taskIdSchema,
  title: optionalText,
  createdAt: timestamp,
  forkedFromConversationId: Schema.optional(Schema.NullOr(conversationIdSchema)),
  forkedAtMessageId: optionalText,
})
export type WorkspaceConversationRead = Schema.Schema.Type<typeof workspaceConversationReadSchema>
export const workspaceTaskDetailSchema = Schema.Struct({
  task: workspaceTaskReadSchema,
  conversations: Schema.Array(workspaceConversationReadSchema),
  totalConversations: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  nextAfterConversationId: Schema.NullOr(conversationIdSchema),
})
export type WorkspaceTaskDetail = Schema.Schema.Type<typeof workspaceTaskDetailSchema>

export const workspaceNativeAgentSessionSchema = Schema.Struct({
  ...payloadSummaryFields,
  id: agentSessionIdSchema,
  taskId: taskIdSchema,
  conversationId: conversationIdSchema,
  checkoutId: workspaceCheckoutIdSchema,
  driverId: text,
  connectionId: text,
  nativeSessionId: text,
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  status: Schema.Literals(['active', 'suspended', 'closed', 'unavailable']),
})
export type WorkspaceNativeAgentSession = Schema.Schema.Type<typeof workspaceNativeAgentSessionSchema>
export const workspaceNativeAgentSessionPageSchema = Schema.Struct({
  items: Schema.Array(workspaceNativeAgentSessionSchema),
  total: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  nextAfterId: Schema.NullOr(agentSessionIdSchema),
  truncated: Schema.Boolean,
})
export type WorkspaceNativeAgentSessionPage = Schema.Schema.Type<typeof workspaceNativeAgentSessionPageSchema>

export const workspacePendingRuntimeRequestSchema = Schema.Struct({
  ...payloadSummaryFields,
  runId: agentRunIdSchema,
  taskId: taskIdSchema,
  sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  request: agentRequestSchema,
})
export type WorkspacePendingRuntimeRequest = Schema.Schema.Type<typeof workspacePendingRuntimeRequestSchema>

export const workspacePendingRuntimeRequestPageSchema = Schema.Struct({
  items: Schema.Array(workspacePendingRuntimeRequestSchema),
  total: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  nextAfterSequence: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  hasMore: Schema.Boolean,
})
export type WorkspacePendingRuntimeRequestPage = Schema.Schema.Type<typeof workspacePendingRuntimeRequestPageSchema>

export const workspaceConversationMessageSchema = Schema.Struct({
  ...payloadSummaryFields,
  id: text,
  content: Schema.String,
  createdAt: timestamp,
})
export const workspaceConversationPageItemSchema = Schema.Struct({
  event: workspaceExecutionEventSchema,
  userMessage: Schema.optional(workspaceConversationMessageSchema),
})
export type WorkspaceConversationPageItem = Schema.Schema.Type<typeof workspaceConversationPageItemSchema>
export const workspaceConversationPageSchema = Schema.Struct({
  items: Schema.Array(workspaceConversationPageItemSchema),
  highWatermark: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  nextAfterSequence: Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  hasMore: Schema.Boolean,
})
export type WorkspaceConversationPage = Schema.Schema.Type<typeof workspaceConversationPageSchema>
export const workspaceConversationPageOptionsSchema = workspaceEventPageOptionsSchema

export const workspaceSnapshotSchema = Schema.Struct({
  task: Schema.Struct({ id: taskIdSchema, projectId: projectIdSchema, title: text, status: Schema.String }),
  runs: Schema.Array(agentRunSchema),
  requestResponses: Schema.optional(Schema.Array(requestResponseSnapshotSchema)),
  steerIntents: Schema.optional(Schema.Array(steerIntentSnapshotSchema)),
  queuedFollowUps: Schema.optional(Schema.Array(queuedFollowUpPreviewSchema)),
  requestResponseSummary: Schema.optional(snapshotSectionSummarySchema),
  steerIntentSummary: Schema.optional(snapshotSectionSummarySchema),
  queuedFollowUpSummary: Schema.optional(snapshotSectionSummarySchema),
  highWatermark: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
})
export type WorkspaceSnapshot = Schema.Schema.Type<typeof workspaceSnapshotSchema>
