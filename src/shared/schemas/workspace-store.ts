import * as Schema from 'effect/Schema'

import {
  DELEGATION_RESULT_MAX_CHARS,
  delegationIdSchema,
  delegationPendingRequestSchema,
  delegationRecordSchema,
  delegationSettledStatusSchema,
  delegationStatusSchema,
  delegationWakeMessageSchema,
  delegationWakeSchema,
  delegationWakeStateSchema,
} from '@/shared/schemas/delegation.js'
import {
  agentAccessModeSchema,
  agentCapabilitiesSchema,
  agentConfigValuesSchema,
  agentDriverEventSchema,
  agentRequestDecisionSchema,
  agentRequestSchema,
  agentRunSchema,
  agentRunStatusSchema,
} from '@/shared/schemas/execution.js'
import {
  agentRunIdSchema,
  agentSessionIdSchema,
  agentSessionSchema,
  conversationIdSchema,
  projectIdSchema,
  projectSchema,
  taskIdSchema,
  taskSchema,
  workspaceCheckoutIdSchema,
  workspaceCheckoutSchema,
} from '@/shared/schemas/workspace.js'

import { promptAttachmentsSchema } from './prompt-context.js'
import { SIDE_CHAT_BRING_BACK_MAX_CHARS } from './workspace-side-chats.js'

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

export const projectRegistrationReceiptSchema = Schema.Struct({
  commandId: text,
  project: projectSchema,
  mainCheckout: workspaceCheckoutSchema,
  replayed: Schema.Boolean,
  reused: Schema.Boolean,
})
export type ProjectRegistrationReceipt = Schema.Schema.Type<typeof projectRegistrationReceiptSchema>

export const taskCreationReceiptSchema = Schema.Struct({
  commandId: text,
  taskId: taskIdSchema,
  conversationId: conversationIdSchema,
  replayed: Schema.Boolean,
})
export type TaskCreationReceipt = Schema.Schema.Type<typeof taskCreationReceiptSchema>

export const coachChatSchema = Schema.Struct({
  taskId: taskIdSchema,
  conversationId: conversationIdSchema,
})
export type CoachChat = typeof coachChatSchema.Type

export const renameTaskCommandSchema = Schema.Struct({
  commandId: text,
  taskId: taskIdSchema,
  title: text,
  updatedAt: timestamp,
})
export type RenameTaskCommand = Schema.Schema.Type<typeof renameTaskCommandSchema>

export const setTaskArchivedCommandSchema = Schema.Struct({
  commandId: text,
  taskId: taskIdSchema,
  archived: Schema.Boolean,
  updatedAt: timestamp,
})
export type SetTaskArchivedCommand = Schema.Schema.Type<typeof setTaskArchivedCommandSchema>

export const taskMutationReceiptSchema = Schema.Struct({
  commandId: text,
  taskId: taskIdSchema,
  updatedAt: timestamp,
  replayed: Schema.Boolean,
})
export type TaskMutationReceipt = Schema.Schema.Type<typeof taskMutationReceiptSchema>

const projectRegistrationCommandSchema = Schema.Struct({
  // Optional only for existing internal callers; renderer commands always provide an ID.
  commandId: Schema.optional(text),
  project: Schema.Struct({
    id: projectIdSchema,
    name: text,
    repositoryIdentity: optionalText,
    isScratch: Schema.optional(Schema.Boolean),
    isCoach: Schema.optional(Schema.Boolean),
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
  mainCheckout: Schema.Struct({
    id: workspaceCheckoutIdSchema,
    kind: Schema.Literals(['main', 'directory']),
    path: text,
    branch: optionalText,
    createdAt: timestamp,
  }),
}).check(
  Schema.makeFilter(
    ({ project, mainCheckout }) =>
      (project.repositoryIdentity !== undefined) === (mainCheckout.kind === 'main') &&
      (mainCheckout.kind === 'main' || mainCheckout.branch === undefined),
  ),
)
export type RegisterProjectCommand = Schema.Schema.Type<typeof projectRegistrationCommandSchema>

export const initializeProjectGitRequestSchema = Schema.Struct({ commandId: text, projectId: projectIdSchema })
export type InitializeProjectGitRequest = typeof initializeProjectGitRequestSchema.Type

export const convertDirectoryProjectCommandSchema = Schema.TaggedStruct('ConvertDirectoryProject', {
  ...initializeProjectGitRequestSchema.fields,
  // Without Git metadata, only look up the durable receipt for this intent.
  repository: Schema.optional(
    Schema.Struct({ path: text, identity: text, branch: optionalText, updatedAt: timestamp }),
  ),
})
export type ConvertDirectoryProjectCommand = typeof convertDirectoryProjectCommandSchema.Type

// Both operations use the existing project registration exchange with the SQLite worker.
export const registerProjectCommandSchema = Schema.Union([
  projectRegistrationCommandSchema,
  convertDirectoryProjectCommandSchema,
])

/** Registers an additional checkout. The main checkout is registered with its Project. */
export const registerCheckoutCommandSchema = Schema.Struct({
  commandId: text,
  checkout: Schema.Struct({
    id: workspaceCheckoutIdSchema,
    projectId: projectIdSchema,
    kind: Schema.Literals(['worktree', 'directory']),
    scratchConversationId: Schema.optional(conversationIdSchema),
    path: text,
    branch: optionalText,
    createdAt: timestamp,
  }).check(
    Schema.makeFilter(checkout =>
      checkout.kind === 'directory'
        ? checkout.scratchConversationId !== undefined && checkout.branch === undefined
        : checkout.scratchConversationId === undefined,
    ),
  ),
})
export type RegisterCheckoutCommand = Schema.Schema.Type<typeof registerCheckoutCommandSchema>
export const checkoutRegistrationReceiptSchema = Schema.Struct({
  commandId: text,
  checkout: workspaceCheckoutSchema,
  replayed: Schema.Boolean,
})
export type CheckoutRegistrationReceipt = Schema.Schema.Type<typeof checkoutRegistrationReceiptSchema>

export const createTaskCommandSchema = Schema.Struct({
  commandId: Schema.optional(text),
  task: Schema.Struct({
    id: taskIdSchema,
    projectId: projectIdSchema,
    title: text,
    description: Schema.String,
    createdAt: timestamp,
    /** A side chat Task is hidden from Task listings and is owned by its parent Conversation. */
    sideChat: Schema.optional(
      Schema.Struct({
        parentTaskId: taskIdSchema,
        parentConversationId: conversationIdSchema,
      }),
    ),
  }),
  conversation: Schema.Struct({
    id: conversationIdSchema,
    title: optionalText,
    createdAt: timestamp,
    /** Set by side-chat creation to keep the parent's checkout binding. */
    inheritedCheckoutId: Schema.optional(workspaceCheckoutIdSchema),
  }),
})
export type CreateTaskCommand = Schema.Schema.Type<typeof createTaskCommandSchema>

const count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
const positiveCount = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))
export const createDelegationCommandSchema = Schema.Struct({
  commandId: text,
  issuedAt: timestamp,
  parentRunId: agentRunIdSchema,
  parentTaskId: taskIdSchema,
  parentConversationId: conversationIdSchema,
  task: createTaskCommandSchema.fields.task,
  conversation: createTaskCommandSchema.fields.conversation,
  record: delegationRecordSchema,
  limits: Schema.Struct({ maxDepth: positiveCount, maxActivePerParentRun: positiveCount }),
})
export type CreateDelegationCommand = Schema.Schema.Type<typeof createDelegationCommandSchema>
export const delegationReceiptSchema = Schema.Struct({
  commandId: text,
  delegationId: delegationIdSchema,
  replayed: Schema.Boolean,
  acceptedAt: timestamp,
})
export type DelegationReceipt = Schema.Schema.Type<typeof delegationReceiptSchema>
export const settleDelegationCommandSchema = Schema.Struct({
  commandId: text,
  delegationId: delegationIdSchema,
  status: delegationSettledStatusSchema,
  resultText: Schema.NullOr(Schema.String.check(Schema.isMaxLength(DELEGATION_RESULT_MAX_CHARS))),
  resultTruncated: Schema.Boolean,
  occurredAt: timestamp,
})
export type SettleDelegationCommand = Schema.Schema.Type<typeof settleDelegationCommandSchema>
export const setDelegationWakeCommandSchema = Schema.Struct({
  commandId: text,
  delegationId: delegationIdSchema,
  wakeState: delegationWakeStateSchema,
  wake: Schema.optionalKey(delegationWakeSchema),
  occurredAt: timestamp,
})
export type SetDelegationWakeCommand = Schema.Schema.Type<typeof setDelegationWakeCommandSchema>
export const setDelegationPendingRequestCommandSchema = Schema.Struct({
  commandId: text,
  delegationId: delegationIdSchema,
  pendingRequest: Schema.NullOr(delegationPendingRequestSchema),
  occurredAt: timestamp,
})
export type SetDelegationPendingRequestCommand = Schema.Schema.Type<typeof setDelegationPendingRequestCommandSchema>
/** Re-opens a settled Delegation for a follow-up Run that the parent asked for. */
export const reopenDelegationCommandSchema = Schema.Struct({
  commandId: text,
  delegationId: delegationIdSchema,
  parentRunId: agentRunIdSchema,
  childRunId: agentRunIdSchema,
  accessMode: agentAccessModeSchema,
  maxActivePerParentRun: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  occurredAt: timestamp,
})
export type ReopenDelegationCommand = Schema.Schema.Type<typeof reopenDelegationCommandSchema>
export const delegationQuerySchema = Schema.Struct({
  parentRunId: Schema.optional(agentRunIdSchema),
  parentTaskId: Schema.optional(taskIdSchema),
  activeOnly: Schema.optional(Schema.Boolean),
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
  ),
})
export type DelegationQuery = Schema.Schema.Type<typeof delegationQuerySchema>

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
  attachments: Schema.optional(promptAttachmentsSchema),
  modelId: Schema.optional(Schema.NullOr(Schema.String)),
  modeId: Schema.optional(Schema.NullOr(Schema.String)),
  configValues: Schema.optional(agentConfigValuesSchema),
  /** Absent means the store applies the fail-safe default; the persisted intent is always explicit. */
  accessMode: Schema.optional(agentAccessModeSchema),
  nativeSessionId: Schema.optional(Schema.NullOr(Schema.String)),
  retryOfRunId: Schema.optional(Schema.NullOr(agentRunIdSchema)),
  /** Message origin recorded on the user message of this Run. A delegation wake or a delegated child's first message. */
  origin: Schema.optional(Schema.Literals(['user', 'delegation'])),
  delegationId: Schema.optional(delegationIdSchema),
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
  /** Existing durable identity when resuming an already bound native session. */
  agentSessionId: Schema.optional(agentSessionIdSchema),
  driverId: text,
  connectionId: text,
  checkoutId: workspaceCheckoutIdSchema,
  workspacePath: text,
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  prompt: Schema.String,
  attachments: Schema.optional(promptAttachmentsSchema),
  modelId: Schema.optional(Schema.NullOr(Schema.String)),
  modeId: Schema.optional(Schema.NullOr(Schema.String)),
  configValues: Schema.optional(agentConfigValuesSchema),
  accessMode: Schema.optional(agentAccessModeSchema),
  nativeSessionId: Schema.optional(Schema.NullOr(Schema.String)),
})
export type DispatchClaim = Schema.Schema.Type<typeof dispatchClaimSchema>

export const nativeSessionBindingSchema = Schema.Struct({
  ownerEpoch: workerEpochSchema,
  nativeSessionId: text,
  generation: beginRunCommandSchema.fields.generation,
  recordedAt: timestamp,
  capabilities: Schema.optional(agentCapabilitiesSchema),
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
  attachments: Schema.optional(promptAttachmentsSchema),
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
  checkoutId: Schema.optional(workspaceCheckoutIdSchema),
  generation: Schema.optional(beginRunCommandSchema.fields.generation),
  nativeSessionId: Schema.optional(Schema.NullOr(Schema.String)),
  prompt: Schema.String,
  attachments: Schema.optional(promptAttachmentsSchema),
  driverId: Schema.optional(text),
  connectionId: Schema.optional(text),
  modelId: beginRunCommandSchema.fields.modelId,
  modeId: beginRunCommandSchema.fields.modeId,
  configValues: beginRunCommandSchema.fields.configValues,
  accessMode: beginRunCommandSchema.fields.accessMode,
  origin: Schema.optional(Schema.Literals(['user', 'delegation'])),
  delegationId: Schema.optional(delegationIdSchema),
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
  held: Schema.optional(Schema.Boolean),
})
export type QueuedFollowUp = Schema.Schema.Type<typeof queuedFollowUpSchema>

export const queuedFollowUpHeadSchema = Schema.Struct({
  ...queuedFollowUpSchema.fields,
  context: Schema.NullOr(
    Schema.Struct({
      projectId: projectIdSchema,
      checkoutId: workspaceCheckoutIdSchema,
      driverId: text,
      connectionId: text,
      generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
      nativeSessionId: Schema.NullOr(text),
      sessionStatus: Schema.NullOr(agentSessionSchema.fields.status),
      runStatus: agentRunStatusSchema,
    }),
  ),
})
export type QueuedFollowUpHead = Schema.Schema.Type<typeof queuedFollowUpHeadSchema>

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
export const workspaceTaskPageOptionsSchema = Schema.Struct({
  ...workspaceEntityPageOptionsSchema.fields,
  includeArchived: Schema.optional(Schema.Boolean),
  includeDelegated: Schema.optional(Schema.Boolean),
})
export type WorkspaceTaskPageOptions = Schema.Schema.Type<typeof workspaceTaskPageOptionsSchema>
export const workspaceCheckoutPageOptionsSchema = Schema.Struct({
  /** Fetches the named checkout alongside the main checkout, without paging. */
  checkoutId: Schema.optional(workspaceCheckoutIdSchema),
  scratchConversationId: Schema.optional(conversationIdSchema),
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
export const queuedFollowUpHeadPageSchema = Schema.Struct({
  ...readPageFields,
  items: Schema.Array(queuedFollowUpHeadSchema),
})
export type QueuedFollowUpHeadPage = Schema.Schema.Type<typeof queuedFollowUpHeadPageSchema>
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
  held: Schema.Boolean,
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
export const workspaceProjectRuntimeSummarySchema = Schema.Struct({
  attentionCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  workingCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
})
export type WorkspaceProjectRuntimeSummary = Schema.Schema.Type<typeof workspaceProjectRuntimeSummarySchema>
export const workspaceProjectListItemSchema = Schema.Struct({
  ...workspaceProjectReadSchema.fields,
  runtime: Schema.optional(workspaceProjectRuntimeSummarySchema),
})
export type WorkspaceProjectListItem = Schema.Schema.Type<typeof workspaceProjectListItemSchema>
export const workspaceCheckoutReadSchema = Schema.Struct({ ...workspaceCheckoutSchema.fields, ...payloadSummaryFields })
export const workspaceTaskLatestRunSchema = Schema.Struct({
  runId: agentRunIdSchema,
  driverId: Schema.NullOr(text),
  connectionId: Schema.NullOr(text),
  modelId: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  activityAt: timestamp,
})
export const workspaceTaskRuntimeSummarySchema = Schema.Struct({
  lastActivityAt: Schema.optional(timestamp),
  runStatus: Schema.NullOr(agentRunStatusSchema),
  pendingRequestKind: Schema.NullOr(Schema.Literals(['approval', 'question'])),
  latestRun: Schema.NullOr(workspaceTaskLatestRunSchema),
  delegatedFrom: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        delegationId: delegationIdSchema,
        parentTaskId: taskIdSchema,
        status: delegationStatusSchema,
      }),
    ),
  ),
  delegatedChildren: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        total: count,
        active: count,
        attention: count,
        approvals: Schema.optionalKey(count),
        questions: Schema.optionalKey(count),
      }),
    ),
  ),
})
export type WorkspaceTaskRuntimeSummary = Schema.Schema.Type<typeof workspaceTaskRuntimeSummarySchema>
export const workspaceTaskReadSchema = Schema.Struct({ ...taskSchema.fields, ...payloadSummaryFields })
export const workspaceTaskListItemSchema = Schema.Struct({
  ...workspaceTaskReadSchema.fields,
  runtime: workspaceTaskRuntimeSummarySchema,
})

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
    'contextHandoff',
    'sideChatBringBack',
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
  items: Schema.Array(workspaceProjectListItemSchema),
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
  items: Schema.Array(workspaceTaskListItemSchema),
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
  inheritedCheckoutId: Schema.optional(workspaceCheckoutIdSchema),
  forkedFromConversationId: Schema.optional(Schema.NullOr(conversationIdSchema)),
  forkedAtMessageId: optionalText,
})
export type WorkspaceConversationRead = Schema.Schema.Type<typeof workspaceConversationReadSchema>
export const workspaceTaskDetailSchema = Schema.Struct({
  task: workspaceTaskReadSchema,
  conversations: Schema.Array(workspaceConversationReadSchema),
  totalConversations: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  nextAfterConversationId: Schema.NullOr(conversationIdSchema),
  /** The Delegation that started this Task, so a child can open its parent without a list query. */
  delegatedFrom: Schema.optional(workspaceTaskRuntimeSummarySchema.fields.delegatedFrom),
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
  capabilities: Schema.optional(agentCapabilitiesSchema),
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
  attachments: Schema.optional(promptAttachmentsSchema),
  createdAt: timestamp,
  origin: Schema.optional(Schema.Literals(['user', 'delegation'])),
  delegation: Schema.optional(delegationWakeMessageSchema),
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
  nextBeforeSequence: Schema.optional(Schema.NullOr(sequenceCursor)),
  hasMore: Schema.Boolean,
})
export type WorkspaceConversationPage = Schema.Schema.Type<typeof workspaceConversationPageSchema>
export const workspaceConversationPageOptionsSchema = Schema.Struct({
  afterSequence: workspaceEventPageOptionsSchema.fields.afterSequence,
  throughSequence: workspaceEventPageOptionsSchema.fields.throughSequence,
  limit: workspaceEventPageOptionsSchema.fields.limit,
  direction: Schema.optional(Schema.Literal('backward')),
  beforeSequence: Schema.optional(sequenceCursor),
}).check(
  Schema.makeFilter(
    value =>
      (value.throughSequence === undefined || value.afterSequence <= value.throughSequence) &&
      (value.direction === 'backward'
        ? value.afterSequence === 0 &&
          (value.throughSequence === undefined ||
            value.beforeSequence === undefined ||
            value.beforeSequence <= value.throughSequence)
        : value.beforeSequence === undefined),
  ),
)
export type WorkspaceConversationPageOptions = Schema.Schema.Type<typeof workspaceConversationPageOptionsSchema>
export type WorkspaceConversationPageReadOptions = Pick<
  WorkspaceConversationPageOptions,
  'direction' | 'beforeSequence'
>
export const workspaceConversationPageRequestSchema = Schema.Struct({
  conversationId: conversationIdSchema,
  ...workspaceConversationPageOptionsSchema.fields,
}).check(
  Schema.makeFilter(
    value =>
      (value.throughSequence === undefined || value.afterSequence <= value.throughSequence) &&
      (value.direction === 'backward'
        ? value.afterSequence === 0 &&
          (value.throughSequence === undefined ||
            value.beforeSequence === undefined ||
            value.beforeSequence <= value.throughSequence)
        : value.beforeSequence === undefined),
  ),
)
export type WorkspaceConversationPageRequest = Schema.Schema.Type<typeof workspaceConversationPageRequestSchema>

export const workspaceRunContextSchema = Schema.Struct({
  runId: agentRunIdSchema,
  conversationId: conversationIdSchema,
  checkoutId: workspaceCheckoutIdSchema,
  driverId: text,
  connectionId: text,
  modelId: Schema.optional(Schema.NullOr(Schema.String)),
  workspacePath: Schema.optional(text),
  accessMode: Schema.optional(agentAccessModeSchema),
})
export type WorkspaceRunContext = Schema.Schema.Type<typeof workspaceRunContextSchema>
export const conversationHandoffDataSchema = Schema.Struct({
  sourceRunId: agentRunIdSchema,
  sourceConnectionId: text,
  /** Absent on records written before the source was checked; `unavailable` means the connection no longer resolves. */
  sourceConnectionStatus: Schema.optional(Schema.Literals(['available', 'unavailable'])),
  sourceModelId: Schema.optional(Schema.NullOr(Schema.String)),
  targetConnectionId: text,
  targetModelId: Schema.optional(Schema.NullOr(Schema.String)),
  highWatermark: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  truncated: Schema.Boolean,
  /** The character budget the handoff context was sized to, and what that budget was derived from. */
  budgetChars: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  budgetSource: Schema.optional(Schema.Literals(['reported-context-window', 'default'])),
})
export type ConversationHandoffData = Schema.Schema.Type<typeof conversationHandoffDataSchema>
export const recordConversationHandoffCommandSchema = Schema.Struct({
  ownerEpoch: workerEpochSchema,
  occurredAt: timestamp,
  handoff: conversationHandoffDataSchema,
})
export type RecordConversationHandoffCommand = Schema.Schema.Type<typeof recordConversationHandoffCommandSchema>
export const workspaceRunCoverageSchema = Schema.Struct({
  total: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  returned: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  truncated: Schema.Boolean,
})
export type WorkspaceRunCoverage = Schema.Schema.Type<typeof workspaceRunCoverageSchema>
export const workspaceSnapshotSchema = Schema.Struct({
  task: Schema.Struct({
    id: taskIdSchema,
    projectId: projectIdSchema,
    title: text,
    status: Schema.String,
    sideChat: Schema.optional(Schema.Boolean),
  }),
  runs: Schema.Array(agentRunSchema),
  runContexts: Schema.optional(Schema.Array(workspaceRunContextSchema)),
  runCoverage: Schema.optional(workspaceRunCoverageSchema),
  requestResponses: Schema.optional(Schema.Array(requestResponseSnapshotSchema)),
  steerIntents: Schema.optional(Schema.Array(steerIntentSnapshotSchema)),
  queuedFollowUps: Schema.optional(Schema.Array(queuedFollowUpPreviewSchema)),
  requestResponseSummary: Schema.optional(snapshotSectionSummarySchema),
  steerIntentSummary: Schema.optional(snapshotSectionSummarySchema),
  queuedFollowUpSummary: Schema.optional(snapshotSectionSummarySchema),
  highWatermark: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
})
export type WorkspaceSnapshot = Schema.Schema.Type<typeof workspaceSnapshotSchema>

export const sideChatBringBackStatusSchema = Schema.Literals(['pending', 'consumed', 'superseded', 'cancelled'])
export type SideChatBringBackStatus = Schema.Schema.Type<typeof sideChatBringBackStatusSchema>

/** One row per bring-back. At most one row per parent Conversation is `pending`. */
export const sideChatBringBackRecordSchema = Schema.Struct({
  id: text,
  parentTaskId: taskIdSchema,
  parentConversationId: conversationIdSchema,
  sideChatId: text,
  sideTaskId: taskIdSchema,
  sideConversationId: conversationIdSchema,
  sourceRunId: agentRunIdSchema,
  title: Schema.String,
  digest: Schema.String.check(Schema.isMaxLength(SIDE_CHAT_BRING_BACK_MAX_CHARS)),
  truncated: Schema.Boolean,
  status: sideChatBringBackStatusSchema,
  createdAt: timestamp,
  consumedRunId: Schema.NullOr(agentRunIdSchema),
  consumedAt: Schema.NullOr(timestamp),
})
export type SideChatBringBackRecord = Schema.Schema.Type<typeof sideChatBringBackRecordSchema>

export const sideChatBringBackOutcomeSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('recorded'),
    record: sideChatBringBackRecordSchema,
    supersedesId: Schema.NullOr(text),
  }),
  Schema.Struct({ _tag: Schema.Literal('parent-busy') }),
  Schema.Struct({ _tag: Schema.Literal('bring-back-pending'), pendingSideChatId: text }),
])
export type SideChatBringBackOutcome = Schema.Schema.Type<typeof sideChatBringBackOutcomeSchema>

export const consumeSideChatBringBackCommandSchema = Schema.Struct({
  ownerEpoch: workerEpochSchema,
  occurredAt: timestamp,
})
export type ConsumeSideChatBringBackCommand = Schema.Schema.Type<typeof consumeSideChatBringBackCommandSchema>

export const deleteSideChatTaskCommandSchema = Schema.Struct({
  sideChatId: text,
  sideTaskId: taskIdSchema,
  onlyIfUnused: Schema.Boolean,
})
export type DeleteSideChatTaskCommand = Schema.Schema.Type<typeof deleteSideChatTaskCommandSchema>
