import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import { agentRunIdSchema, taskIdSchema } from '@/shared/schemas/workspace.js'
import {
  beginRunCommandSchema,
  commandReceiptSchema,
  createTaskCommandSchema,
  dispatchClaimSchema,
  dispatchFailureCommandSchema,
  recordDriverEventCommandSchema,
  registerProjectCommandSchema,
  workerEpochSchema,
  workspaceEventPageSchema,
  workspaceExecutionEventSchema,
  workspaceSnapshotSchema,
  WorkspaceStoreError,
} from '@/shared/schemas/workspace-store.js'

export const WORKSPACE_WORKER_PROTOCOL_VERSION = 1
export const WORKSPACE_WORKER_REQUEST_CAPACITY = 64
export const WORKSPACE_WORKER_REQUEST_BYTE_CAPACITY = 1024 * 1024
export const WORKSPACE_WORKER_RESPONSE_BYTE_CAPACITY = 4 * 1024 * 1024

const text = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1))
const timestamp = beginRunCommandSchema.fields.issuedAt
const pageLimit = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(500))

export const workspaceWorkerDataSchema = Schema.Struct({ filename: text })
export type WorkspaceWorkerData = Schema.Schema.Type<typeof workspaceWorkerDataSchema>

export const workspaceWorkerReadySchema = Schema.Struct({
  protocolVersion: Schema.Literal(WORKSPACE_WORKER_PROTOCOL_VERSION),
})

export const nativeTurnAcknowledgementSchema = Schema.Struct({
  ownerEpoch: workerEpochSchema,
  nativeSessionId: text,
  nativeTurnId: Schema.optional(text),
  acknowledgedAt: timestamp,
})

const error = WorkspaceStoreError

export const WorkspaceWorkerRpcGroup = RpcGroup.make(
  Rpc.make('workspace-worker:ready', { success: workspaceWorkerReadySchema, error }),
  Rpc.make('workspace-worker:registerProject', {
    payload: registerProjectCommandSchema,
    success: Schema.Void,
    error,
  }),
  Rpc.make('workspace-worker:createTask', {
    payload: createTaskCommandSchema,
    success: Schema.Void,
    error,
  }),
  Rpc.make('workspace-worker:beginRun', {
    payload: beginRunCommandSchema,
    success: commandReceiptSchema,
    error,
  }),
  Rpc.make('workspace-worker:claimDispatch', {
    payload: Schema.Struct({ runId: agentRunIdSchema, ownerEpoch: workerEpochSchema, claimedAt: timestamp }),
    success: dispatchClaimSchema,
    error,
  }),
  Rpc.make('workspace-worker:acknowledgeDispatch', {
    payload: Schema.Struct({ runId: agentRunIdSchema, acknowledgement: nativeTurnAcknowledgementSchema }),
    success: Schema.Void,
    error,
  }),
  Rpc.make('workspace-worker:recordDriverEvent', {
    payload: Schema.Struct({ runId: agentRunIdSchema, command: recordDriverEventCommandSchema }),
    success: workspaceExecutionEventSchema,
    error,
  }),
  Rpc.make('workspace-worker:failDispatch', {
    payload: Schema.Struct({ runId: agentRunIdSchema, command: dispatchFailureCommandSchema }),
    success: Schema.Void,
    error,
  }),
  Rpc.make('workspace-worker:requestInterrupt', {
    payload: Schema.Struct({ runId: agentRunIdSchema, ownerEpoch: workerEpochSchema, requestedAt: timestamp }),
    success: Schema.Void,
    error,
  }),
  Rpc.make('workspace-worker:recoverWorker', {
    payload: Schema.Struct({ replacedEpoch: workerEpochSchema, recoveredAt: timestamp }),
    success: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    error,
  }),
  Rpc.make('workspace-worker:pageEvents', {
    payload: Schema.Struct({
      afterSequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
      limit: pageLimit,
    }),
    success: workspaceEventPageSchema,
    error,
  }),
  Rpc.make('workspace-worker:readTaskSnapshot', {
    payload: Schema.Struct({ taskId: taskIdSchema, runLimit: pageLimit }),
    success: workspaceSnapshotSchema,
    error,
  }),
  Rpc.make('workspace-worker:shutdown', { success: Schema.Void, error }),
)
