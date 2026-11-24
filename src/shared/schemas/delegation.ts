import * as Schema from 'effect/Schema'

import { agentAccessModeSchema, agentRequestIdSchema } from '@/shared/schemas/execution.js'
import {
  agentRunIdSchema,
  conversationIdSchema,
  projectIdSchema,
  taskIdSchema,
  workspaceCheckoutIdSchema,
} from '@/shared/schemas/workspace.js'

export const DELEGATION_MAX_DEPTH = 1
export const DELEGATION_PROMPT_MAX_CHARS = 32 * 1024
export const DELEGATION_RESULT_MAX_CHARS = 16 * 1024
export const DELEGATION_WAIT_DEFAULT_MS = 30_000
export const DELEGATION_WAIT_MAX_MS = 45_000

const text = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1))
const boundedText = (max: number) => text.check(Schema.isMaxLength(max))
const timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
)
const nonNegativeInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

export const delegationIdSchema = boundedText(128).pipe(Schema.brand('DelegationId'))
export type DelegationId = Schema.Schema.Type<typeof delegationIdSchema>

/** The parent's view of the child. Derived from child Run and Task state, never a native status. */
export const delegationStatusSchema = Schema.Literals([
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
  'uncertain',
])
export type DelegationStatus = Schema.Schema.Type<typeof delegationStatusSchema>

export const delegationSettledStatusSchema = Schema.Literals([
  'completed',
  'failed',
  'interrupted',
  'cancelled',
  'uncertain',
])
export type DelegationSettledStatus = Schema.Schema.Type<typeof delegationSettledStatusSchema>

export const delegationIsolationSchema = Schema.Literals(['shared', 'worktree'])
export type DelegationIsolation = Schema.Schema.Type<typeof delegationIsolationSchema>

/** The role a parent names for a child. Anything but `general` frames the child's task with it. */
export const delegationRoleSchema = Schema.Literals([
  'implementation',
  'research',
  'review',
  'design',
  'test',
  'general',
])
export type DelegationRole = Schema.Schema.Type<typeof delegationRoleSchema>

export const delegationWakeSchema = Schema.Literals(['always', 'settledOnly'])
export type DelegationWake = Schema.Schema.Type<typeof delegationWakeSchema>
export const delegationWakeStateSchema = Schema.Literals(['notDue', 'pending', 'queued', 'delivered', 'disposed'])
export type DelegationWakeState = Schema.Schema.Type<typeof delegationWakeStateSchema>

export const delegationPendingRequestSchema = Schema.Struct({
  requestId: agentRequestIdSchema,
  kind: Schema.Literals(['approval', 'question']),
})
export type DelegationPendingRequest = Schema.Schema.Type<typeof delegationPendingRequestSchema>

export const delegationTargetSchema = Schema.Struct({
  connectionId: boundedText(128),
  modelId: Schema.optional(Schema.NullOr(boundedText(256))),
  modeId: Schema.optional(Schema.NullOr(boundedText(256))),
  configValues: Schema.optional(Schema.Record(boundedText(128), Schema.String.check(Schema.isMaxLength(512)))),
})
export type DelegationTarget = Schema.Schema.Type<typeof delegationTargetSchema>

/** Tool arguments. Caller identity is never read from here. */
export const delegationStartRequestSchema = Schema.Struct({
  clientRequestId: Schema.optional(boundedText(128)),
  prompt: boundedText(DELEGATION_PROMPT_MAX_CHARS),
  title: Schema.optional(boundedText(200)),
  target: Schema.optional(delegationTargetSchema),
  isolation: Schema.optional(delegationIsolationSchema),
  accessMode: Schema.optional(agentAccessModeSchema),
  wait: Schema.optional(Schema.Boolean),
  waitTimeoutMs: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(DELEGATION_WAIT_MAX_MS),
    ),
  ),
})
export type DelegationStartRequest = Schema.Schema.Type<typeof delegationStartRequestSchema>

/** Bound to one Agent Run by its endpoint credential. Built in the platform layer, never from arguments. */
export const delegationCallerSchema = Schema.Struct({
  projectId: projectIdSchema,
  taskId: taskIdSchema,
  conversationId: conversationIdSchema,
  runId: agentRunIdSchema,
})
export type DelegationCaller = Schema.Schema.Type<typeof delegationCallerSchema>

/** Durable record. Hot fields are columns in the store; this shape is the decoded view. */
export const delegationRecordSchema = Schema.Struct({
  id: delegationIdSchema,
  commandId: boundedText(128),
  projectId: projectIdSchema,
  parentTaskId: taskIdSchema,
  parentConversationId: conversationIdSchema,
  parentRunId: agentRunIdSchema,
  childTaskId: taskIdSchema,
  childConversationId: conversationIdSchema,
  childRunId: Schema.NullOr(agentRunIdSchema),
  checkoutId: workspaceCheckoutIdSchema,
  depth: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(DELEGATION_MAX_DEPTH),
  ),
  title: boundedText(200),
  driverId: boundedText(128),
  connectionId: boundedText(128),
  modelId: Schema.NullOr(Schema.String),
  modeId: Schema.NullOr(Schema.String),
  accessMode: agentAccessModeSchema,
  accessModeRequested: Schema.NullOr(agentAccessModeSchema),
  accessModeSteppedDownFrom: Schema.NullOr(agentAccessModeSchema),
  isolation: delegationIsolationSchema,
  status: delegationStatusSchema,
  wake: delegationWakeSchema,
  wakeState: delegationWakeStateSchema,
  /** Wake deliveries lost because their promoted parent Run never launched. Absent means none. */
  wakeAttempts: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  pendingRequest: Schema.NullOr(delegationPendingRequestSchema),
  resultText: Schema.NullOr(Schema.String.check(Schema.isMaxLength(DELEGATION_RESULT_MAX_CHARS))),
  resultTruncated: Schema.Boolean,
  cancelRequestedAt: Schema.NullOr(timestamp),
  resultReadAt: Schema.NullOr(timestamp),
  createdAt: timestamp,
  settledAt: Schema.NullOr(timestamp),
})
export type DelegationRecord = Schema.Schema.Type<typeof delegationRecordSchema>

export const delegationListSchema = Schema.Struct({
  items: Schema.Array(delegationRecordSchema),
  truncated: Schema.Boolean,
})
export type DelegationList = Schema.Schema.Type<typeof delegationListSchema>

/** What an Agent Run reads back through the orchestration tools. */
export const delegationSummarySchema = Schema.Struct({
  delegationId: delegationIdSchema,
  childTaskId: taskIdSchema,
  title: Schema.String,
  status: delegationStatusSchema,
  settled: Schema.Boolean,
  cancelRequested: Schema.Boolean,
  connectionId: boundedText(128),
  modelId: Schema.NullOr(Schema.String),
  accessMode: agentAccessModeSchema,
  accessModeSteppedDownFrom: Schema.NullOr(agentAccessModeSchema),
  isolation: delegationIsolationSchema,
  pendingRequest: Schema.NullOr(delegationPendingRequestSchema),
  resultText: Schema.NullOr(Schema.String),
  resultTruncated: Schema.Boolean,
  waitTimedOut: Schema.Boolean,
  next: Schema.optional(Schema.String),
})
export type DelegationSummary = Schema.Schema.Type<typeof delegationSummarySchema>

/** A model the connection's catalog lists, with the effort levels (modes) it offers for that model. */
export const delegationModelChoiceSchema = Schema.Struct({
  id: boundedText(256),
  label: Schema.String,
  modes: Schema.optional(
    Schema.Array(Schema.Struct({ id: boundedText(256), label: Schema.String })).check(Schema.isMaxLength(32)),
  ),
})
export type DelegationModelChoice = Schema.Schema.Type<typeof delegationModelChoiceSchema>

export const delegationTargetChoiceSchema = Schema.Struct({
  connectionId: boundedText(128),
  label: Schema.String,
  driverId: boundedText(128),
  accessModes: Schema.Array(agentAccessModeSchema),
  models: Schema.Array(delegationModelChoiceSchema).check(Schema.isMaxLength(64)),
  /** How many catalog models matched, which can exceed the models listed. */
  modelCount: Schema.optional(nonNegativeInt),
  modelsKnown: Schema.Boolean,
})
export type DelegationTargetChoice = Schema.Schema.Type<typeof delegationTargetChoiceSchema>

export const delegationCapabilitiesSchema = Schema.Struct({
  parentAccessMode: agentAccessModeSchema,
  depth: nonNegativeInt,
  remainingDepth: nonNegativeInt,
  connections: Schema.Array(delegationTargetChoiceSchema).check(Schema.isMaxLength(64)),
})
export type DelegationCapabilities = Schema.Schema.Type<typeof delegationCapabilitiesSchema>

export const delegationErrorCodeSchema = Schema.Literals([
  'not-found',
  'invalid-request',
  'parent-not-active',
  'depth-exceeded',
  'limit-exceeded',
  'access-escalation-denied',
  'unsupported-access-mode',
  'connection-unavailable',
  'checkout-unavailable',
  'conflict',
  'unavailable',
])
export type DelegationErrorCode = Schema.Schema.Type<typeof delegationErrorCodeSchema>

export class DelegationError extends Schema.TaggedError<DelegationError>()('DelegationError', {
  code: delegationErrorCodeSchema,
  message: Schema.String,
}) {}

/** The wake text is built from a record; the tool result never includes wake state. */
export const delegationWakeMessageSchema = Schema.Struct({
  delegationId: delegationIdSchema,
  childTaskId: taskIdSchema,
  title: Schema.String,
  status: delegationStatusSchema,
})
export type DelegationWakeMessage = Schema.Schema.Type<typeof delegationWakeMessageSchema>
