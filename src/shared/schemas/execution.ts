import * as Schema from 'effect/Schema'

import { agentRunIdSchema, agentSessionIdSchema, taskIdSchema } from '@/shared/schemas/workspace.js'

const text = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1))
const optionalText = Schema.optional(Schema.String)
const timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
)
const optionalTimestamp = Schema.optional(Schema.NullOr(timestamp))
const nonNegative = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))

export const agentRunStatusSchema = Schema.Literals([
  'queued',
  'starting',
  'running',
  'awaitingInput',
  'interruptRequested',
  'interrupted',
  'completed',
  'failed',
  'uncertain',
  'recoveryRequired',
])
export type AgentRunStatus = Schema.Schema.Type<typeof agentRunStatusSchema>

export const agentRunSchema = Schema.Struct({
  id: agentRunIdSchema,
  taskId: taskIdSchema,
  sessionId: Schema.optional(Schema.NullOr(agentSessionIdSchema)),
  attempt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  retryOfRunId: Schema.optional(Schema.NullOr(agentRunIdSchema)),
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  status: agentRunStatusSchema,
  submittedAt: timestamp,
  startedAt: optionalTimestamp,
  finishedAt: optionalTimestamp,
  nativeTurnId: Schema.optional(Schema.NullOr(Schema.String)),
  failure: Schema.optional(Schema.NullOr(Schema.String)),
})
export type AgentRun = Schema.Schema.Type<typeof agentRunSchema>

export const agentOperationSchema = Schema.Literals([
  'openSession',
  'loadSession',
  'submit',
  'interrupt',
  'steer',
  'respond',
  'reconcile',
])
export type AgentOperation = Schema.Schema.Type<typeof agentOperationSchema>

export const capabilitySupportSchema = Schema.Literals(['supported', 'unsupported', 'unknown'])
export type CapabilitySupport = Schema.Schema.Type<typeof capabilitySupportSchema>

export const capabilityEvidenceSchema = Schema.Struct({
  source: Schema.Literals(['protocol', 'driver', 'configuration', 'probe', 'unknown']),
  detail: optionalText,
})
export type CapabilityEvidence = Schema.Schema.Type<typeof capabilityEvidenceSchema>

export const capabilitySchema = Schema.Struct({
  support: capabilitySupportSchema,
  restrictions: Schema.Array(Schema.String),
  evidence: Schema.Array(capabilityEvidenceSchema),
})
export type Capability = Schema.Schema.Type<typeof capabilitySchema>

export const agentCapabilitiesSchema = Schema.Struct({
  openSession: capabilitySchema,
  loadSession: capabilitySchema,
  submit: capabilitySchema,
  interrupt: capabilitySchema,
  steer: capabilitySchema,
  respond: capabilitySchema,
  reconcile: capabilitySchema,
  models: Schema.Array(Schema.Struct({ id: text, label: Schema.String })),
  modes: Schema.Array(Schema.Struct({ id: text, label: Schema.String })),
})
export type AgentCapabilities = Schema.Schema.Type<typeof agentCapabilitiesSchema>

export const agentConnectionIdentitySchema = Schema.Struct({
  id: text,
  driverId: text,
  protocolVersion: optionalText,
  authentication: Schema.Literals(['authenticated', 'unauthenticated', 'unknown']),
})
export type AgentConnectionIdentity = Schema.Schema.Type<typeof agentConnectionIdentitySchema>

export const agentSessionIdentitySchema = Schema.Struct({
  nativeSessionId: text,
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
})
export type AgentSessionIdentity = Schema.Schema.Type<typeof agentSessionIdentitySchema>

export const agentRequestDecisionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('approve'), optionId: optionalText }),
  Schema.Struct({ kind: Schema.Literal('deny'), reason: optionalText }),
  Schema.Struct({ kind: Schema.Literal('cancel') }),
  Schema.Struct({
    kind: Schema.Literal('answers'),
    answers: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  }),
])
export type AgentRequestDecision = Schema.Schema.Type<typeof agentRequestDecisionSchema>

export const agentRequestSchema = Schema.Struct({
  requestId: text,
  runId: agentRunIdSchema,
  sessionId: Schema.optional(Schema.NullOr(agentSessionIdSchema)),
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  kind: Schema.Literals(['approval', 'question']),
  prompt: Schema.String,
  options: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: text,
        label: Schema.String,
        scope: Schema.optional(Schema.Literals(['once', 'session', 'project'])),
        kind: Schema.optional(Schema.Literals(['allow', 'deny', 'allowAlways', 'other'])),
      }),
    ),
  ),
  questions: Schema.Array(
    Schema.Struct({
      id: text,
      prompt: Schema.String,
      multiSelect: Schema.Boolean,
      options: Schema.Array(Schema.Struct({ id: text, label: Schema.String })),
    }),
  ),
  nativeRequestId: optionalText,
})
export type AgentRequest = Schema.Schema.Type<typeof agentRequestSchema>

export const agentDriverEventSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('turnStarted'), nativeTurnId: optionalText }),
  Schema.Struct({ kind: Schema.Literal('turnCompleted'), nativeTurnId: optionalText }),
  Schema.Struct({ kind: Schema.Literal('turnInterrupted'), nativeTurnId: optionalText }),
  Schema.Struct({ kind: Schema.Literal('turnFailed'), nativeTurnId: optionalText, message: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('textDelta'), text: Schema.String, itemId: optionalText }),
  Schema.Struct({ kind: Schema.Literal('reasoningDelta'), text: Schema.String, itemId: optionalText }),
  Schema.Struct({ kind: Schema.Literal('toolStarted'), toolCallId: text, name: text, input: optionalText }),
  Schema.Struct({ kind: Schema.Literal('toolUpdated'), toolCallId: text, output: optionalText }),
  Schema.Struct({ kind: Schema.Literal('toolCompleted'), toolCallId: text, error: optionalText }),
  Schema.Struct({ kind: Schema.Literal('requestPending'), request: agentRequestSchema }),
  Schema.Struct({ kind: Schema.Literal('requestResolved'), requestId: text, decision: agentRequestDecisionSchema }),
  Schema.Struct({
    kind: Schema.Literal('usageReported'),
    semantics: Schema.Literals(['delta', 'cumulative', 'final']),
    scope: Schema.Literals(['run', 'session', 'subagent']),
    revision: optionalText,
    resetId: optionalText,
    subjectId: optionalText,
    inputTokens: Schema.optional(nonNegative),
    outputTokens: Schema.optional(nonNegative),
    cost: Schema.optional(nonNegative),
    currency: optionalText,
  }),
  Schema.Struct({ kind: Schema.Literal('nativeNotice'), message: Schema.String }),
])
export type AgentDriverEvent = Schema.Schema.Type<typeof agentDriverEventSchema>

export const agentReconcileEventSchema = Schema.Struct({
  cursor: optionalText,
  replay: Schema.Boolean,
  event: agentDriverEventSchema,
})
export type AgentReconcileEvent = Schema.Schema.Type<typeof agentReconcileEventSchema>
