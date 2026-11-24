import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import {
  DelegationError,
  delegationIdSchema,
  delegationListSchema,
  delegationRecordSchema,
} from '@/shared/schemas/delegation.js'
import { agentRunIdSchema, taskIdSchema } from '@/shared/schemas/workspace.js'

export const WorkspaceDelegationRpcGroup = RpcGroup.make(
  Rpc.make('delegation:list', {
    payload: Schema.Struct({
      parentTaskId: taskIdSchema,
      parentRunId: Schema.optional(agentRunIdSchema),
      limit: Schema.optional(
        Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
      ),
    }),
    success: delegationListSchema,
    error: DelegationError,
  }),
  Rpc.make('delegation:get', {
    payload: Schema.Struct({ delegationId: delegationIdSchema }),
    success: delegationRecordSchema,
    error: DelegationError,
  }),
  Rpc.make('delegation:cancel', {
    payload: Schema.Struct({
      commandId: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(128)),
      delegationId: delegationIdSchema,
      reason: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
    }),
    success: delegationRecordSchema,
    error: DelegationError,
  }),
)
