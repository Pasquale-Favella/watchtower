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

export const agentGoalStateSchema = Schema.Struct({
  objective: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32 * 1024)),
  status: Schema.Literals(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']),
  tokenBudget: Schema.optional(Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)))),
  tokensUsed: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  timeUsedSeconds: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  createdAt: Schema.Number.check(Schema.isInt()),
  updatedAt: Schema.Number.check(Schema.isInt()),
})
export type AgentGoalState = Schema.Schema.Type<typeof agentGoalStateSchema>

/** How much a Run may do without asking. Absent values are applied as the fail-safe default. */
export const agentAccessModeSchema = Schema.Literals(['approval-required', 'auto-accept-edits', 'auto', 'full-access'])
export type AgentAccessMode = Schema.Schema.Type<typeof agentAccessModeSchema>
export const DEFAULT_AGENT_ACCESS_MODE: AgentAccessMode = 'approval-required'

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
  goal: Schema.optional(Schema.NullOr(agentGoalStateSchema)),
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

/** Most model or mode choices one connection can report. OpenCode lists hundreds of provider models. */
export const MAX_AGENT_CATALOG_CHOICES = 1024
/** The account an agent reports it is signed in with. Fields stay absent when the agent does not say. */
export const agentAccountSchema = Schema.Struct({
  label: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  email: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
})
export type AgentAccount = Schema.Schema.Type<typeof agentAccountSchema>
export const agentModelChoiceSchema = Schema.Struct({
  id: text,
  label: Schema.String,
  /** What the model is for, shown under its name. */
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  modes: Schema.optional(Schema.Array(Schema.Struct({ id: text, label: Schema.String }))),
})
export const agentSlashCommandSchema = Schema.Struct({
  name: text,
  description: Schema.String,
  inputHint: Schema.optional(Schema.String),
})
export const agentPromptSkillSchema = Schema.Struct({
  name: text,
  scope: optionalText,
  description: optionalText,
  enabled: Schema.Boolean,
  userInvocable: Schema.optional(Schema.Boolean),
})
export const agentPromptCatalogSchema = Schema.Struct({
  skills: Schema.Array(agentPromptSkillSchema).check(Schema.isMaxLength(512)),
  skillsComplete: Schema.Boolean,
  commands: Schema.Array(agentSlashCommandSchema).check(Schema.isMaxLength(256)),
})
export type AgentPromptCatalog = Schema.Schema.Type<typeof agentPromptCatalogSchema>

export const agentConfigOptionSchema = Schema.Struct({
  id: text,
  label: Schema.String,
  description: optionalText,
  category: optionalText,
  currentValue: Schema.String,
  options: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String, description: optionalText })),
})
export type AgentConfigOption = Schema.Schema.Type<typeof agentConfigOptionSchema>
export const agentConfigValuesSchema = Schema.Record(text, Schema.String)

export const agentCapabilitiesSchema = Schema.Struct({
  openSession: capabilitySchema,
  loadSession: capabilitySchema,
  submit: capabilitySchema,
  interrupt: capabilitySchema,
  steer: capabilitySchema,
  respond: capabilitySchema,
  reconcile: capabilitySchema,
  models: Schema.Array(agentModelChoiceSchema),
  modes: Schema.Array(Schema.Struct({ id: text, label: Schema.String })),
  configOptions: Schema.optional(Schema.Array(agentConfigOptionSchema)),
  promptContent: Schema.optional(Schema.Struct({ images: Schema.Boolean, files: Schema.Boolean })),
  commands: Schema.optional(Schema.Array(agentSlashCommandSchema).check(Schema.isMaxLength(256))),
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
  Schema.Struct({ kind: Schema.Literal('deny'), optionId: optionalText, reason: optionalText }),
  Schema.Struct({ kind: Schema.Literal('cancel') }),
  Schema.Struct({
    kind: Schema.Literal('answers'),
    answers: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  }),
])
export type AgentRequestDecision = Schema.Schema.Type<typeof agentRequestDecisionSchema>

export const agentToolMetadataSchema = Schema.Struct({
  category: Schema.optional(
    Schema.Literals(['command', 'fileRead', 'fileWrite', 'search', 'web', 'subagent', 'mcp', 'other']),
  ),
  command: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number.check(Schema.isInt())),
  durationMs: Schema.optional(nonNegative),
  paths: Schema.optional(Schema.Array(Schema.String)),
  url: Schema.optional(Schema.String),
  changes: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        kind: Schema.Literals(['add', 'delete', 'update']),
        diff: Schema.optional(Schema.String),
      }),
    ),
  ),
})
export type AgentToolMetadata = Schema.Schema.Type<typeof agentToolMetadataSchema>

export const agentRequestSchema = Schema.Struct({
  requestId: text,
  runId: agentRunIdSchema,
  sessionId: Schema.optional(Schema.NullOr(agentSessionIdSchema)),
  generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  kind: Schema.Literals(['approval', 'question']),
  prompt: Schema.String,
  cancelDecision: Schema.optional(Schema.Struct({ kind: Schema.Literal('cancel') })),
  options: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: text,
        label: Schema.String,
        scope: Schema.optional(Schema.Literals(['once', 'session', 'project', 'persistent'])),
        kind: Schema.optional(Schema.Literals(['allow', 'deny', 'allowAlways', 'other'])),
        decision: Schema.optional(agentRequestDecisionSchema),
      }),
    ),
  ),
  questions: Schema.Array(
    Schema.Struct({
      id: text,
      prompt: Schema.String,
      header: Schema.optional(Schema.String),
      allowCustomAnswer: Schema.optional(Schema.Boolean),
      isSecret: Schema.optional(Schema.Boolean),
      multiSelect: Schema.Boolean,
      options: Schema.Array(
        Schema.Struct({
          id: text,
          label: Schema.String,
          description: Schema.optional(Schema.String),
          recommended: Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  ),
  nativeRequestId: optionalText,
  toolCallId: optionalText,
  tool: Schema.optional(agentToolMetadataSchema),
})
export type AgentRequest = Schema.Schema.Type<typeof agentRequestSchema>

export const agentPlanEntrySchema = Schema.Struct({
  content: Schema.String,
  status: Schema.Literals(['pending', 'inProgress', 'completed']),
})
export type AgentPlanEntry = Schema.Schema.Type<typeof agentPlanEntrySchema>

export const agentDriverEventSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('capabilitiesUpdated'), capabilities: agentCapabilitiesSchema }),
  Schema.Struct({
    kind: Schema.Literal('goalUpdated'),
    nativeSessionId: text,
    generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
    goal: Schema.NullOr(agentGoalStateSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal('goalTurnStarted'),
    nativeSessionId: text,
    generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
    nativeTurnId: text,
  }),
  Schema.Struct({
    kind: Schema.Literal('goalTurnCompleted'),
    nativeSessionId: text,
    generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
    nativeTurnId: text,
    status: Schema.Literals(['completed', 'interrupted', 'failed']),
  }),
  Schema.Struct({ kind: Schema.Literal('turnStarted'), nativeTurnId: optionalText }),
  Schema.Struct({ kind: Schema.Literal('turnCompleted'), nativeTurnId: optionalText }),
  Schema.Struct({ kind: Schema.Literal('turnInterrupted'), nativeTurnId: optionalText }),
  Schema.Struct({ kind: Schema.Literal('turnFailed'), nativeTurnId: optionalText, message: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('textDelta'), text: Schema.String, itemId: optionalText }),
  Schema.Struct({ kind: Schema.Literal('reasoningDelta'), text: Schema.String, itemId: optionalText }),
  Schema.Struct({
    kind: Schema.Literal('toolStarted'),
    toolCallId: text,
    name: text,
    input: Schema.optional(Schema.String),
    ...agentToolMetadataSchema.fields,
  }),
  Schema.Struct({
    kind: Schema.Literal('toolUpdated'),
    toolCallId: text,
    name: optionalText,
    input: Schema.optional(Schema.String),
    output: Schema.optional(Schema.String),
    append: Schema.optional(Schema.Boolean),
    ...agentToolMetadataSchema.fields,
  }),
  Schema.Struct({
    kind: Schema.Literal('toolCompleted'),
    toolCallId: text,
    name: optionalText,
    input: Schema.optional(Schema.String),
    output: Schema.optional(Schema.String),
    error: optionalText,
    ...agentToolMetadataSchema.fields,
  }),
  Schema.Struct({
    kind: Schema.Literal('media'),
    itemId: optionalText,
    mediaType: text,
    url: Schema.String,
    alt: optionalText,
  }),
  Schema.Struct({
    kind: Schema.Literal('planUpdated'),
    itemId: optionalText,
    explanation: optionalText,
    entries: Schema.Array(agentPlanEntrySchema),
  }),
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
