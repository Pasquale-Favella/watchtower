import * as Schema from 'effect/Schema'

import {
  DELEGATION_PROMPT_MAX_CHARS,
  DELEGATION_RESULT_MAX_CHARS,
  DELEGATION_WAIT_MAX_MS,
  delegationErrorCodeSchema,
  delegationPendingRequestSchema,
  delegationRoleSchema,
  delegationStatusSchema,
} from '@/shared/schemas/delegation.js'
import { agentAccessModeSchema } from '@/shared/schemas/execution.js'

/**
 * Tool surface of the `watchtower-orchestrator` MCP server. These schemas are both the argument validator and the
 * advertised JSON Schema (`Schema.toStandardJSONSchemaV1`), so the wire contract cannot drift from the decoder.
 * Keep descriptions terse: the model reads them on every turn.
 */

/** A settled result is returned in full up to the result cap, because the parent reads it through these tools. */
export const DELEGATION_TOOL_SUMMARY_MAX_CHARS = DELEGATION_RESULT_MAX_CHARS
export const DELEGATION_TOOL_LIST_MAX = 50
export const DELEGATION_TOOL_CONNECTION_MAX = 32
export const DELEGATION_TOOL_MODEL_MAX = 20

const idText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(128))

/** A connection and optional model. Sent as an object, or as a JSON string that decodes to the same object. */
export const delegationToolTargetSchema = Schema.Struct({
  connection: idText.annotate({ description: 'Connection id from delegation_capabilities.' }),
  model: Schema.optionalKey(
    Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256)).annotate({
      description: 'Model id from delegation_capabilities. Omit for the connection default.',
    }),
  ),
  effort: Schema.optionalKey(
    Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256)).annotate({
      description: 'Effort id from the model efforts in delegation_capabilities. Omit for the default.',
    }),
  ),
})
export type DelegationToolTarget = Schema.Schema.Type<typeof delegationToolTargetSchema>

export const delegationToolStartInputSchema = Schema.Struct({
  task: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isMinLength(1),
    Schema.isMaxLength(DELEGATION_PROMPT_MAX_CHARS),
  ).annotate({ description: 'Complete task text. The child sees only this, not your conversation.' }),
  title: Schema.optionalKey(
    Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
      description: 'Short label for the UI.',
    }),
  ),
  target: Schema.optionalKey(
    Schema.Union([delegationToolTargetSchema, Schema.fromJsonString(delegationToolTargetSchema)]).annotate({
      description: 'Where the task runs. Omit to use this run connection and model.',
    }),
  ),
  role: Schema.optionalKey(delegationRoleSchema.annotate({ description: 'Frames the task. Default general.' })),
  isolation: Schema.optionalKey(
    Schema.Literals(['shared', 'worktree']).annotate({
      description: 'shared (default) or worktree (own checkout at HEAD; uncommitted edits are not copied).',
    }),
  ),
  accessMode: Schema.optionalKey(
    agentAccessModeSchema.annotate({ description: 'At most this run access mode. Default: inherit.' }),
  ),
  mode: Schema.optionalKey(
    Schema.Literals(['async', 'wait']).annotate({
      description: 'async (default) returns at once. wait blocks up to timeoutMs for the result.',
    }),
  ),
  timeoutMs: Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(DELEGATION_WAIT_MAX_MS),
    ).annotate({
      description: 'Wait limit in ms when mode is wait. Default 30000, maximum 45000.',
    }),
  ),
  clientRequestId: Schema.optionalKey(
    idText.annotate({ description: 'Idempotency key. The same key returns the same delegation.' }),
  ),
})
export type DelegationToolStartInput = Schema.Schema.Type<typeof delegationToolStartInputSchema>

export const delegationToolStatusInputSchema = Schema.Struct({
  id: Schema.optionalKey(idText.annotate({ description: 'Delegation id. Omit to list yours, newest first.' })),
  limit: Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(DELEGATION_TOOL_LIST_MAX),
    ).annotate({
      description: 'List size without id. Default 20.',
    }),
  ),
})
export type DelegationToolStatusInput = Schema.Schema.Type<typeof delegationToolStatusInputSchema>

export const DELEGATION_TOOL_READ_MAX = 20

export const delegationToolReadInputSchema = Schema.Struct({
  id: idText,
  limit: Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(DELEGATION_TOOL_READ_MAX),
    ).annotate({
      description: 'Latest messages to return. Default 6.',
    }),
  ),
})
export type DelegationToolReadInput = Schema.Schema.Type<typeof delegationToolReadInputSchema>

export const delegationToolSendInputSchema = Schema.Struct({
  id: idText,
  message: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isMinLength(1),
    Schema.isMaxLength(DELEGATION_PROMPT_MAX_CHARS),
  ),
  answers: Schema.optionalKey(
    Schema.Record(idText, Schema.String.check(Schema.isMaxLength(4_000))).annotate({
      description: 'Answers by question id from delegation_read. Default: message answers all.',
    }),
  ),
  clientRequestId: Schema.optionalKey(idText.annotate({ description: 'Idempotency key.' })),
})
export type DelegationToolSendInput = Schema.Schema.Type<typeof delegationToolSendInputSchema>

export const delegationToolCancelInputSchema = Schema.Struct({
  id: idText.annotate({ description: 'Delegation id to stop.' }),
  reason: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(500)).annotate({ description: 'Optional short reason.' }),
  ),
})
export type DelegationToolCancelInput = Schema.Schema.Type<typeof delegationToolCancelInputSchema>

export const delegationToolNoInputSchema = Schema.Struct({})

export const delegationToolCapabilitiesInputSchema = Schema.Struct({
  search: Schema.optionalKey(
    Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(128)).annotate({
      description: 'Words that find models in every catalog, such as "flint free". Lists are short without it.',
    }),
  ),
})

/** One delegation as the parent Run reads it. Bounded, and never a full transcript. */
export const delegationToolSummarySchema = Schema.Struct({
  id: Schema.String,
  childTaskId: Schema.String,
  title: Schema.String,
  status: delegationStatusSchema,
  connection: Schema.String,
  model: Schema.optionalKey(Schema.String),
  accessMode: agentAccessModeSchema,
  steppedDownFrom: Schema.optionalKey(agentAccessModeSchema),
  pending: Schema.optionalKey(delegationPendingRequestSchema.fields.kind),
  summary: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(DELEGATION_TOOL_SUMMARY_MAX_CHARS))),
  truncated: Schema.optionalKey(Schema.Boolean),
  waitTimedOut: Schema.optionalKey(Schema.Boolean),
  cancelRequested: Schema.optionalKey(Schema.Boolean),
  next: Schema.optionalKey(Schema.String),
})
export type DelegationToolSummary = Schema.Schema.Type<typeof delegationToolSummarySchema>

export const delegationToolReadOutputSchema = Schema.Struct({
  delegation: delegationToolSummarySchema,
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(['task', 'agent']),
      text: Schema.String,
      truncated: Schema.optionalKey(Schema.Boolean),
    }),
  ).check(Schema.isMaxLength(DELEGATION_TOOL_READ_MAX)),
  earlierOmitted: Schema.Boolean,
  question: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.Literals(['approval', 'question']),
      prompt: Schema.String,
      questions: Schema.Array(
        Schema.Struct({ id: Schema.String, prompt: Schema.String, options: Schema.Array(Schema.String) }),
      ),
    }),
  ),
})

export const delegationToolListOutputSchema = Schema.Struct({
  items: Schema.Array(delegationToolSummarySchema).check(Schema.isMaxLength(DELEGATION_TOOL_LIST_MAX)),
  truncated: Schema.Boolean,
})

export const delegationToolCapabilitiesOutputSchema = Schema.Struct({
  accessMode: agentAccessModeSchema,
  available: Schema.Literals([0, 'unlimited']),
  connections: Schema.Array(
    Schema.Struct({
      connection: Schema.String,
      label: Schema.String,
      accessModes: Schema.Array(agentAccessModeSchema),
      models: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          label: Schema.String,
          efforts: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(DELEGATION_TOOL_MODEL_MAX))),
        }),
      ).check(Schema.isMaxLength(DELEGATION_TOOL_MODEL_MAX)),
      moreModels: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
      modelsKnown: Schema.Boolean,
    }),
  ).check(Schema.isMaxLength(DELEGATION_TOOL_CONNECTION_MAX)),
})

/** Typed tool error. Returned as an MCP tool error result, never thrown past the transport. */
export const delegationToolErrorSchema = Schema.Struct({
  code: delegationErrorCodeSchema,
  message: Schema.String,
})
export type DelegationToolError = Schema.Schema.Type<typeof delegationToolErrorSchema>
