import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import type * as Schema from 'effect/Schema'

import type { DelegationList, DelegationRecord } from '@/shared/schemas/delegation.js'
import type {
  promptConversationMatchesSchema,
  promptConversationSearchSchema,
} from '@/shared/schemas/prompt-context.js'
import type { AgentRunId, ConversationId, ProjectId, TaskId } from '@/shared/schemas/workspace.js'
import type {
  BeginRunCommand,
  CheckoutRegistrationReceipt,
  CoachChat,
  CommandReceipt,
  ConsumeSideChatBringBackCommand,
  ConvertDirectoryProjectCommand,
  CreateDelegationCommand,
  CreateTaskCommand,
  DelegationCursor,
  DelegationQuery,
  DelegationReceipt,
  DeleteSideChatTaskCommand,
  DispatchClaim,
  DispatchFailureCommand,
  EnqueueFollowUpCommand,
  FollowUpReceipt,
  NativeSessionBinding,
  OwnerEpochAcquisition,
  ProjectRegistrationReceipt,
  PromotedFollowUp,
  QueuedFollowUpHeadPage,
  QueuedFollowUpPage,
  RecordConversationHandoffCommand,
  RecordDriverEventCommand,
  RecordRequestResponseCommand,
  RecordSteerCommand,
  RegisterCheckoutCommand,
  RegisterProjectCommand,
  RenameTaskCommand,
  ReopenDelegationCommand,
  RequestResponsePage,
  SetDelegationPendingRequestCommand,
  SetDelegationWakeCommand,
  SetTaskArchivedCommand,
  SettleDelegationCommand,
  SettleDeliveryCommand,
  SideChatBringBackOutcome,
  SideChatBringBackRecord,
  SteerIntentPage,
  TaskCreationReceipt,
  TaskMutationReceipt,
  WorkspaceCheckoutPageOptions,
  WorkspaceConversationPage,
  WorkspaceConversationPageReadOptions,
  WorkspaceEntityPageOptions,
  WorkspaceEventPage,
  WorkspaceExecutionEvent,
  WorkspaceNativeAgentSessionPage,
  WorkspacePayloadPage,
  WorkspacePayloadReference,
  WorkspacePendingRuntimeRequestPage,
  WorkspaceProjectDetail,
  WorkspaceProjectReadPage,
  WorkspaceReadPageOptions,
  WorkspaceSnapshot,
  WorkspaceTaskDetail,
  WorkspaceTaskPageOptions,
  WorkspaceTaskReadPage,
} from '@/shared/schemas/workspace-store.js'
import { WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

export interface NativeTurnAcknowledgement {
  readonly ownerEpoch: number
  readonly nativeSessionId: string
  readonly nativeTurnId?: string | undefined
  readonly acknowledgedAt: string
}

export class WorkspaceStore extends Context.Service<
  WorkspaceStore,
  {
    /** Project registration and in-place conversion share the worker's registration exchange. */
    readonly registerProject: (
      command: RegisterProjectCommand | ConvertDirectoryProjectCommand,
    ) => Effect.Effect<ProjectRegistrationReceipt, WorkspaceStoreError>
    readonly checkUnmanagedProjectPath: (path: string) => Effect.Effect<void, WorkspaceStoreError>
    readonly reserveGitInitialization: (path: string, reservationId: string) => Effect.Effect<void, WorkspaceStoreError>
    readonly releaseGitInitialization: (path: string, reservationId: string) => Effect.Effect<void, WorkspaceStoreError>
    readonly registerCheckout: (
      command: RegisterCheckoutCommand,
    ) => Effect.Effect<CheckoutRegistrationReceipt, WorkspaceStoreError>
    readonly createTask: (command: CreateTaskCommand) => Effect.Effect<TaskCreationReceipt, WorkspaceStoreError>
    readonly getCoachChat: () => Effect.Effect<CoachChat | null, WorkspaceStoreError>
    readonly listActiveCoachRuns: (taskId: TaskId) => Effect.Effect<ReadonlyArray<AgentRunId>, WorkspaceStoreError>
    readonly purgeCoachChat: (taskId: TaskId) => Effect.Effect<void, WorkspaceStoreError>
    readonly sweepCoachChats: () => Effect.Effect<void, WorkspaceStoreError>
    readonly renameTask: (command: RenameTaskCommand) => Effect.Effect<TaskMutationReceipt, WorkspaceStoreError>
    readonly setTaskArchived: (
      command: SetTaskArchivedCommand,
    ) => Effect.Effect<TaskMutationReceipt, WorkspaceStoreError>
    readonly beginRun: (command: BeginRunCommand) => Effect.Effect<CommandReceipt, WorkspaceStoreError>
    readonly claimDispatch: (
      runId: AgentRunId,
      ownerEpoch: number,
      claimedAt: string,
    ) => Effect.Effect<DispatchClaim, WorkspaceStoreError>
    readonly bindNativeSession: (
      runId: AgentRunId,
      binding: NativeSessionBinding,
    ) => Effect.Effect<void, WorkspaceStoreError>
    readonly acknowledgeDispatch: (
      runId: AgentRunId,
      acknowledgement: NativeTurnAcknowledgement,
    ) => Effect.Effect<void, WorkspaceStoreError>
    readonly recordDriverEvent: (
      runId: AgentRunId,
      command: RecordDriverEventCommand,
    ) => Effect.Effect<WorkspaceExecutionEvent, WorkspaceStoreError>
    readonly recordConversationHandoff: (
      runId: AgentRunId,
      command: RecordConversationHandoffCommand,
    ) => Effect.Effect<WorkspaceExecutionEvent, WorkspaceStoreError>
    readonly failDispatch: (
      runId: AgentRunId,
      command: DispatchFailureCommand,
    ) => Effect.Effect<void, WorkspaceStoreError>
    readonly requestInterrupt: (
      runId: AgentRunId,
      ownerEpoch: number,
      requestedAt: string,
    ) => Effect.Effect<void, WorkspaceStoreError>
    readonly recordRequestResponse: (
      command: RecordRequestResponseCommand,
    ) => Effect.Effect<CommandReceipt, WorkspaceStoreError>
    readonly settleRequestResponse: (
      runId: AgentRunId,
      requestId: string,
      outcome: SettleDeliveryCommand,
    ) => Effect.Effect<void, WorkspaceStoreError>
    readonly recordSteer: (command: RecordSteerCommand) => Effect.Effect<CommandReceipt, WorkspaceStoreError>
    readonly settleSteer: (
      runId: AgentRunId,
      commandId: string,
      outcome: SettleDeliveryCommand,
    ) => Effect.Effect<void, WorkspaceStoreError>
    readonly enqueueFollowUp: (command: EnqueueFollowUpCommand) => Effect.Effect<FollowUpReceipt, WorkspaceStoreError>
    readonly cancelQueuedFollowUp: (
      conversationId: ConversationId,
      commandId: string,
    ) => Effect.Effect<void, WorkspaceStoreError>
    readonly listQueuedFollowUps: (
      conversationId: ConversationId,
      options?: WorkspaceReadPageOptions,
    ) => Effect.Effect<QueuedFollowUpPage, WorkspaceStoreError>
    readonly listQueuedFollowUpHeads: (
      options?: WorkspaceReadPageOptions,
    ) => Effect.Effect<QueuedFollowUpHeadPage, WorkspaceStoreError>
    readonly holdQueuedFollowUps: (
      conversationId: ConversationId,
      ownerEpoch: number,
    ) => Effect.Effect<void, WorkspaceStoreError>
    readonly listRequestResponses: (
      taskId: TaskId,
      options?: WorkspaceReadPageOptions,
    ) => Effect.Effect<RequestResponsePage, WorkspaceStoreError>
    readonly listSteerIntents: (
      taskId: TaskId,
      options?: WorkspaceReadPageOptions,
    ) => Effect.Effect<SteerIntentPage, WorkspaceStoreError>
    readonly promoteNextFollowUp: (
      conversationId: ConversationId,
      command: BeginRunCommand,
    ) => Effect.Effect<PromotedFollowUp | null, WorkspaceStoreError>
    readonly recoverWorker: (replacedEpoch: number, recoveredAt: string) => Effect.Effect<number, WorkspaceStoreError>
    /** Release only the reservation; the Run's uncertain delivery outcome remains in history. */
    readonly releaseDispatchAfterCleanup: (
      runId: AgentRunId,
      ownerEpoch: number,
    ) => Effect.Effect<void, WorkspaceStoreError>
    readonly releaseRetiredDispatches: (ownerEpoch: number) => Effect.Effect<void, WorkspaceStoreError>
    /** Records a side chat's bring-back; it is consumed by the parent Conversation's next Run. */
    readonly recordSideChatBringBack: (
      record: SideChatBringBackRecord,
    ) => Effect.Effect<SideChatBringBackOutcome, WorkspaceStoreError>
    /** Consumes the parent Conversation's pending bring-back for this Run, once; a retry returns the same record. */
    readonly consumeSideChatBringBack: (
      runId: AgentRunId,
      command: ConsumeSideChatBringBackCommand,
    ) => Effect.Effect<SideChatBringBackRecord | null, WorkspaceStoreError>
    readonly readPendingSideChatBringBack: (
      conversationId: ConversationId,
    ) => Effect.Effect<SideChatBringBackRecord | null, WorkspaceStoreError>
    /** Deletes a side chat Task and its Conversation; `false` when `onlyIfUnused` finds Runs. */
    readonly deleteSideChatTask: (command: DeleteSideChatTaskCommand) => Effect.Effect<boolean, WorkspaceStoreError>
    readonly acquireOwnerEpoch: (recoveredAt: string) => Effect.Effect<OwnerEpochAcquisition, WorkspaceStoreError>
    readonly pageEvents: (
      afterSequence: number,
      limit: number,
      throughSequence?: number,
    ) => Effect.Effect<WorkspaceEventPage, WorkspaceStoreError>
    readonly listProjects: (
      options?: WorkspaceEntityPageOptions,
    ) => Effect.Effect<WorkspaceProjectReadPage, WorkspaceStoreError>
    readonly getProject: (
      projectId: ProjectId,
      options?: WorkspaceCheckoutPageOptions,
    ) => Effect.Effect<WorkspaceProjectDetail, WorkspaceStoreError>
    readonly listTasks: (
      projectId: ProjectId,
      options?: WorkspaceTaskPageOptions,
    ) => Effect.Effect<WorkspaceTaskReadPage, WorkspaceStoreError>
    readonly searchPromptConversations?: (
      request: Schema.Schema.Type<typeof promptConversationSearchSchema>,
    ) => Effect.Effect<Schema.Schema.Type<typeof promptConversationMatchesSchema>, WorkspaceStoreError>
    readonly readTaskDetail: (
      taskId: TaskId,
      options?: WorkspaceEntityPageOptions,
    ) => Effect.Effect<WorkspaceTaskDetail, WorkspaceStoreError>
    readonly listNativeAgentSessions: (
      taskId: TaskId,
      options?: WorkspaceEntityPageOptions,
    ) => Effect.Effect<WorkspaceNativeAgentSessionPage, WorkspaceStoreError>
    readonly listPendingRuntimeRequests: (
      taskId: TaskId,
      afterSequence: number,
      limit: number,
    ) => Effect.Effect<WorkspacePendingRuntimeRequestPage, WorkspaceStoreError>
    readonly readConversationPage: (
      conversationId: ConversationId,
      afterSequence: number,
      limit: number,
      throughSequence?: number,
      options?: WorkspaceConversationPageReadOptions,
    ) => Effect.Effect<WorkspaceConversationPage, WorkspaceStoreError>
    /** Lossless serialized record chunks; offsets and limits count UTF-16 code units, not bytes. */
    readonly readWorkspacePayload: (
      reference: WorkspacePayloadReference,
      afterOffset: number,
      limit: number,
    ) => Effect.Effect<WorkspacePayloadPage, WorkspaceStoreError>
    readonly readTaskSnapshot: (
      taskId: TaskId,
      runLimit: number,
    ) => Effect.Effect<WorkspaceSnapshot, WorkspaceStoreError>
    /** Creates the child Task, its Conversation and the Delegation row in one transaction, idempotent on commandId. */
    readonly createDelegation: (
      command: CreateDelegationCommand,
    ) => Effect.Effect<DelegationReceipt, WorkspaceStoreError>
    readonly getDelegation: (delegationId: string) => Effect.Effect<DelegationRecord | null, WorkspaceStoreError>
    readonly getDelegationByChildTask: (
      childTaskId: TaskId,
    ) => Effect.Effect<DelegationRecord | null, WorkspaceStoreError>
    readonly listDelegations: (query: DelegationQuery) => Effect.Effect<DelegationList, WorkspaceStoreError>
    readonly settleDelegation: (
      command: SettleDelegationCommand,
    ) => Effect.Effect<DelegationRecord, WorkspaceStoreError>
    readonly setDelegationWake: (
      command: SetDelegationWakeCommand,
    ) => Effect.Effect<DelegationRecord, WorkspaceStoreError>
    readonly setDelegationPendingRequest: (
      command: SetDelegationPendingRequestCommand,
    ) => Effect.Effect<DelegationRecord, WorkspaceStoreError>
    /** Re-opens a settled Delegation for the parent's follow-up Run; a replay with the same child Run is a no-op. */
    readonly reopenDelegation: (
      command: ReopenDelegationCommand,
    ) => Effect.Effect<DelegationRecord, WorkspaceStoreError>
    readonly markDelegationRead: (
      delegationId: string,
      readAt: string,
    ) => Effect.Effect<DelegationRecord, WorkspaceStoreError>
    /** Records a cancel request once; a settled or already-cancelled Delegation is returned unchanged. */
    readonly requestDelegationCancel: (
      delegationId: string,
      requestedAt: string,
    ) => Effect.Effect<DelegationRecord, WorkspaceStoreError>
    /** Pending wakes oldest first, after the cursor. A page can hold fewer than `limit` rows when results are large. */
    readonly listDueDelegationWakes: (
      limit: number,
      after?: DelegationCursor,
    ) => Effect.Effect<ReadonlyArray<DelegationRecord>, WorkspaceStoreError>
  }
>()('watchtower/core/WorkspaceStore') {}

export function convertDirectoryProject(
  store: WorkspaceStore['Service'],
  command: Omit<ConvertDirectoryProjectCommand, '_tag'>,
): Effect.Effect<ProjectRegistrationReceipt, WorkspaceStoreError> {
  return store.registerProject({ ...command, _tag: 'ConvertDirectoryProject' })
}
