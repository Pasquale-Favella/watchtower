import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'

import type { AgentRunId, TaskId } from '@/shared/schemas/workspace.js'
import type {
  BeginRunCommand,
  CommandReceipt,
  CreateTaskCommand,
  DispatchClaim,
  DispatchFailureCommand,
  RecordDriverEventCommand,
  RegisterProjectCommand,
  WorkspaceEventPage,
  WorkspaceExecutionEvent,
  WorkspaceSnapshot,
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
    readonly registerProject: (command: RegisterProjectCommand) => Effect.Effect<void, WorkspaceStoreError>
    readonly createTask: (command: CreateTaskCommand) => Effect.Effect<void, WorkspaceStoreError>
    readonly beginRun: (command: BeginRunCommand) => Effect.Effect<CommandReceipt, WorkspaceStoreError>
    readonly claimDispatch: (
      runId: AgentRunId,
      ownerEpoch: number,
      claimedAt: string,
    ) => Effect.Effect<DispatchClaim, WorkspaceStoreError>
    readonly acknowledgeDispatch: (
      runId: AgentRunId,
      acknowledgement: NativeTurnAcknowledgement,
    ) => Effect.Effect<void, WorkspaceStoreError>
    readonly recordDriverEvent: (
      runId: AgentRunId,
      command: RecordDriverEventCommand,
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
    readonly recoverWorker: (replacedEpoch: number, recoveredAt: string) => Effect.Effect<number, WorkspaceStoreError>
    readonly pageEvents: (
      afterSequence: number,
      limit: number,
    ) => Effect.Effect<WorkspaceEventPage, WorkspaceStoreError>
    readonly readTaskSnapshot: (
      taskId: TaskId,
      runLimit: number,
    ) => Effect.Effect<WorkspaceSnapshot, WorkspaceStoreError>
  }
>()('watchtower/core/WorkspaceStore') {}
