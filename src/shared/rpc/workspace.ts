import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import * as PromptContext from '@/shared/schemas/prompt-context.js'
import { agentRunIdSchema, conversationIdSchema, projectIdSchema, taskIdSchema } from '@/shared/schemas/workspace.js'
import * as Connections from '@/shared/schemas/workspace-connections.js'
import {
  browseWorkspaceDirectoriesSchema,
  cloneWorkspaceProjectSchema,
  createWorkspaceProjectSchema,
  githubRepositorySchema,
  ProjectSetupError,
  registerWorkspaceProjectSchema,
  remoteRepositorySchema,
  remoteSourceReadinessSchema,
  workspaceDirectoryListingSchema,
  workspaceProjectRegistrationSchema,
} from '@/shared/schemas/workspace-projects.js'
import * as Store from '@/shared/schemas/workspace-store.js'

export const WORKSPACE_RPC_PROTOCOL_VERSION = 1
const beginRunFields = Store.beginRunCommandSchema.fields
const commandId = beginRunFields.commandId.check(Schema.isMaxLength(128))

export class WorkspaceRpcError extends Schema.TaggedError<WorkspaceRpcError>()('WorkspaceRpcError', {
  code: Schema.Literals([
    'unavailable',
    'not-found',
    'conflict',
    'stale',
    'invalid-request',
    'failed',
    'stream-overflow',
    'cleanup-unconfirmed',
    'unsupported-access-mode',
  ]),
  message: Schema.Literals([
    'Workspace is unavailable.',
    'Workspace record was not found.',
    'Workspace command conflicts with existing state.',
    'Workspace command is stale.',
    'Workspace request is invalid.',
    'Workspace operation failed.',
    'Workspace stream exceeded its limit. Resume from the last received sequence.',
    'Native connection cleanup could not be confirmed.',
    'The selected access mode is not available for this agent connection.',
  ]),
}) {}

export const workspaceStatusSchema = Schema.Struct({
  protocolVersion: Schema.Literal(WORKSPACE_RPC_PROTOCOL_VERSION),
  state: Schema.Literals(['not-started', 'opening', 'ready', 'replacing', 'unavailable', 'stopped']),
  ownerEpoch: Schema.NullOr(Store.workerEpochSchema),
  highWatermark: Store.workspaceEventPageSchema.fields.highWatermark,
})

/** Snapshot pages share one throughSequence; Events pages advance to later fixed watermarks.
 * Persist the last applied event sequence, then resubscribe after it on disconnect/overflow.
 * Payload summaries retain the store's payloadRef; resolve them before treating content as complete.
 */
export const workspaceEventFrameSchema = Schema.Struct({
  protocolVersion: Schema.Literal(WORKSPACE_RPC_PROTOCOL_VERSION),
  _tag: Schema.Literals(['Snapshot', 'Events']),
  throughSequence: Store.workspaceEventPageSchema.fields.highWatermark,
  page: Store.workspaceEventPageSchema,
})
export type WorkspaceEventFrame = Schema.Schema.Type<typeof workspaceEventFrameSchema>

export const workspaceStartRunRequestSchema = Schema.Struct({
  commandId,
  taskId: beginRunFields.taskId,
  conversationId: beginRunFields.conversationId,
  checkoutId: beginRunFields.checkoutId,
  generation: beginRunFields.generation,
  driverId: beginRunFields.driverId,
  connectionId: beginRunFields.connectionId,
  prompt: beginRunFields.prompt,
  attachments: beginRunFields.attachments,
  modelId: beginRunFields.modelId,
  modeId: beginRunFields.modeId,
  accessMode: beginRunFields.accessMode,
  nativeSessionId: beginRunFields.nativeSessionId,
  retryOfRunId: beginRunFields.retryOfRunId,
})

const error = WorkspaceRpcError
/** Project setup reports its own fixed-message codes so the user learns which step failed. */
const setupError = Schema.Union([WorkspaceRpcError, ProjectSetupError])
/** Command IDs bind durable client intent, not regenerated server timestamps/epochs/Run IDs.
 * Start/respond/steer/enqueue/promote return the original store receipt on replay.
 * Registration/task creation return durable receipts. Registration reuses an active repository's
 * original Project/main checkout without renaming or relocating it; reused is independent of replayed.
 * A different canonical main path for the same repository conflicts instead of silently relocating it.
 * Interrupt is a no-op while already pending; a failed native interrupt may be retried.
 * Cancellation reports removed for both cancelled and already removed/promoted entries; it never stops a promoted Run.
 */
export const WorkspaceRpcGroup = RpcGroup.make(
  Rpc.make('workspace:importAttachment', {
    payload: PromptContext.importPromptAttachmentSchema,
    success: PromptContext.promptAttachmentSchema,
    error,
  }),
  Rpc.make('workspace:previewAttachment', {
    payload: PromptContext.promptAttachmentSchema,
    success: Schema.NullOr(Schema.String),
    error,
  }),
  Rpc.make('workspace:searchPromptContext', {
    payload: PromptContext.searchPromptContextSchema,
    success: PromptContext.promptContextSearchResultSchema,
    error,
  }),
  Rpc.make('workspace:attachPromptContext', {
    payload: PromptContext.attachPromptContextSchema,
    success: PromptContext.promptAttachmentSchema,
    error,
  }),
  Rpc.make('workspace:status', { success: workspaceStatusSchema, error }),
  Rpc.make('workspace:listConnections', {
    payload: Schema.Struct({}),
    success: Connections.workspaceConnectionListSchema,
    error,
  }),
  Rpc.make('workspace:ensureScratchProject', {
    payload: Schema.Struct({}),
    success: workspaceProjectRegistrationSchema,
    error,
  }),
  Rpc.make('workspace:chooseProjectDirectory', {
    payload: Schema.Struct({}),
    success: Schema.NullOr(Schema.String),
    error,
  }),
  Rpc.make('workspace:browseDirectories', {
    payload: browseWorkspaceDirectoriesSchema,
    success: workspaceDirectoryListingSchema,
    error,
  }),
  Rpc.make('workspace:remoteSourceReadiness', {
    payload: Schema.Struct({}),
    success: remoteSourceReadinessSchema,
    error,
  }),
  Rpc.make('workspace:lookupGitHubRepository', {
    payload: Schema.Struct({ repository: githubRepositorySchema }),
    success: remoteRepositorySchema,
    error: setupError,
  }),
  Rpc.make('workspace:createProject', {
    payload: Schema.Struct({
      commandId,
      path: createWorkspaceProjectSchema.fields.path,
      name: createWorkspaceProjectSchema.fields.name,
      publish: createWorkspaceProjectSchema.fields.publish,
    }),
    success: workspaceProjectRegistrationSchema,
    error: setupError,
  }),
  Rpc.make('workspace:cloneProject', {
    payload: Schema.Struct({
      commandId,
      path: cloneWorkspaceProjectSchema.fields.path,
      name: cloneWorkspaceProjectSchema.fields.name,
      source: cloneWorkspaceProjectSchema.fields.source,
    }),
    success: workspaceProjectRegistrationSchema,
    error: setupError,
  }),
  Rpc.make('workspace:inspectConnection', {
    payload: Schema.Struct({ connectionId: Connections.workspaceConnectionSchema.fields.connectionId }),
    success: Connections.workspaceConnectionInspectionSchema,
    error,
  }),
  Rpc.make('workspace:registerProject', {
    payload: Schema.Struct({
      commandId,
      path: registerWorkspaceProjectSchema.fields.path,
      name: registerWorkspaceProjectSchema.fields.name,
    }),
    success: workspaceProjectRegistrationSchema,
    error,
  }),
  Rpc.make('workspace:createTask', {
    payload: Schema.Struct({
      commandId,
      projectId: projectIdSchema,
      title: Store.createTaskCommandSchema.fields.task.fields.title,
      description: Store.createTaskCommandSchema.fields.task.fields.description,
    }),
    success: Schema.Struct({
      commandId,
      taskId: taskIdSchema,
      conversationId: conversationIdSchema,
      replayed: Schema.Boolean,
    }),
    error,
  }),
  Rpc.make('workspace:listProjects', {
    payload: Schema.Struct({ options: Schema.optional(Store.workspaceEntityPageOptionsSchema) }),
    success: Store.workspaceProjectReadPageSchema,
    error,
  }),
  Rpc.make('workspace:getProject', {
    payload: Schema.Struct({
      projectId: projectIdSchema,
      options: Schema.optional(Store.workspaceCheckoutPageOptionsSchema),
    }),
    success: Store.workspaceProjectDetailSchema,
    error,
  }),
  Rpc.make('workspace:listTasks', {
    payload: Schema.Struct({
      projectId: projectIdSchema,
      options: Schema.optional(Store.workspaceEntityPageOptionsSchema),
    }),
    success: Store.workspaceTaskReadPageSchema,
    error,
  }),
  Rpc.make('workspace:readTaskDetail', {
    payload: Schema.Struct({ taskId: taskIdSchema, options: Schema.optional(Store.workspaceEntityPageOptionsSchema) }),
    success: Store.workspaceTaskDetailSchema,
    error,
  }),
  Rpc.make('workspace:readTaskSnapshot', {
    payload: Schema.Struct({
      taskId: taskIdSchema,
      runLimit: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(500)),
    }),
    success: Store.workspaceSnapshotSchema,
    error,
  }),
  Rpc.make('workspace:listNativeAgentSessions', {
    payload: Schema.Struct({ taskId: taskIdSchema, options: Schema.optional(Store.workspaceEntityPageOptionsSchema) }),
    success: Store.workspaceNativeAgentSessionPageSchema,
    error,
  }),
  Rpc.make('workspace:readConversationPage', {
    payload: Store.workspaceConversationPageRequestSchema,
    success: Store.workspaceConversationPageSchema,
    error,
  }),
  Rpc.make('workspace:listPendingRuntimeRequests', {
    payload: Schema.Struct({ taskId: taskIdSchema, ...Store.workspacePendingRuntimeRequestPageOptionsSchema.fields }),
    success: Store.workspacePendingRuntimeRequestPageSchema,
    error,
  }),
  Rpc.make('workspace:readWorkspacePayload', {
    payload: Store.workspacePayloadPageOptionsSchema,
    success: Store.workspacePayloadPageSchema,
    error,
  }),
  Rpc.make('workspace:listQueuedFollowUps', {
    payload: Schema.Struct({
      conversationId: conversationIdSchema,
      options: Schema.optional(Store.workspaceReadPageOptionsSchema),
    }),
    success: Store.queuedFollowUpPageSchema,
    error,
  }),
  Rpc.make('workspace:listRequestResponses', {
    payload: Schema.Struct({ taskId: taskIdSchema, options: Schema.optional(Store.workspaceReadPageOptionsSchema) }),
    success: Store.requestResponsePageSchema,
    error,
  }),
  Rpc.make('workspace:listSteerIntents', {
    payload: Schema.Struct({ taskId: taskIdSchema, options: Schema.optional(Store.workspaceReadPageOptionsSchema) }),
    success: Store.steerIntentPageSchema,
    error,
  }),
  Rpc.make('workspace:startRun', {
    payload: workspaceStartRunRequestSchema,
    success: Store.commandReceiptSchema,
    error,
  }),
  Rpc.make('workspace:interrupt', {
    payload: Schema.Struct({ commandId, runId: agentRunIdSchema }),
    success: Schema.Struct({ commandId, runId: agentRunIdSchema, outcome: Schema.Literal('interruptRequested') }),
    error,
  }),
  Rpc.make('workspace:respond', {
    payload: Schema.Struct({
      commandId,
      runId: agentRunIdSchema,
      generation: Store.recordRequestResponseCommandSchema.fields.generation,
      requestId: Store.recordRequestResponseCommandSchema.fields.requestId,
      decision: Store.recordRequestResponseCommandSchema.fields.decision,
    }),
    success: Store.commandReceiptSchema,
    error,
  }),
  Rpc.make('workspace:steer', {
    payload: Schema.Struct({
      commandId,
      runId: agentRunIdSchema,
      generation: Store.recordSteerCommandSchema.fields.generation,
      expectedNativeTurnId: Store.recordSteerCommandSchema.fields.expectedNativeTurnId,
      message: Store.recordSteerCommandSchema.fields.message,
      attachments: Store.recordSteerCommandSchema.fields.attachments,
    }),
    success: Store.commandReceiptSchema,
    error,
  }),
  Rpc.make('workspace:enqueueFollowUp', {
    payload: Schema.Struct({
      commandId,
      taskId: taskIdSchema,
      conversationId: conversationIdSchema,
      prompt: Store.enqueueFollowUpCommandSchema.fields.prompt,
      attachments: Store.enqueueFollowUpCommandSchema.fields.attachments,
      driverId: Store.enqueueFollowUpCommandSchema.fields.driverId,
      connectionId: Store.enqueueFollowUpCommandSchema.fields.connectionId,
      modelId: Store.enqueueFollowUpCommandSchema.fields.modelId,
      modeId: Store.enqueueFollowUpCommandSchema.fields.modeId,
      accessMode: Store.enqueueFollowUpCommandSchema.fields.accessMode,
    }),
    success: Store.followUpReceiptSchema,
    error,
  }),
  Rpc.make('workspace:cancelQueuedFollowUp', {
    payload: Schema.Struct({ commandId, conversationId: conversationIdSchema, targetCommandId: commandId }),
    success: Schema.Struct({
      commandId,
      targetCommandId: commandId,
      outcome: Schema.Literal('removed'),
    }),
    error,
  }),
  Rpc.make('workspace:promoteQueuedFollowUp', {
    payload: workspaceStartRunRequestSchema,
    success: Schema.NullOr(Store.promotedFollowUpSchema),
    error,
  }),
  Rpc.make('workspace:events', {
    payload: Schema.Struct({ afterSequence: Store.workspaceEventPageOptionsSchema.fields.afterSequence }),
    success: workspaceEventFrameSchema,
    error,
    stream: true,
  }),
)
