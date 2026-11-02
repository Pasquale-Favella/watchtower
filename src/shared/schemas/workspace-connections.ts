import * as Schema from 'effect/Schema'

import { agentAccessModeSchema, agentModelChoiceSchema } from './execution.js'

/** Renderer-safe description of a detected Harness Connection.
 * Launch commands, arguments, environment and credential references are intentionally absent.
 */
export const workspaceConnectionSchema = Schema.Struct({
  connectionId: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(128)),
  label: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256)),
  harnessKind: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(128)),
  driverId: Schema.Literals(['acp', 'codex-app-server', 'claude-agent-sdk']),
  provenance: Schema.Literals(['path', 'bundled', 'native-discovery']),
  availability: Schema.Literal('available'),
  capabilities: Schema.Literal('unknown'),
})

export const workspaceConnectionListSchema = Schema.Struct({
  items: Schema.Array(workspaceConnectionSchema).check(Schema.isMaxLength(256)),
})

const capabilityEvidenceSchema = Schema.Struct({
  source: Schema.Literals(['protocol', 'driver', 'configuration', 'probe', 'unknown']),
  detail: Schema.optional(Schema.String),
})
const capabilitySchema = Schema.Struct({
  support: Schema.Literals(['supported', 'unsupported', 'unknown']),
  restrictions: Schema.Array(Schema.String).check(Schema.isMaxLength(32)),
  evidence: Schema.Array(capabilityEvidenceSchema).check(Schema.isMaxLength(16)),
})
const choiceFactsSchema = Schema.Struct({
  state: Schema.Literals(['unknown', 'session-scoped', 'connection-scoped']),
  items: Schema.Array(agentModelChoiceSchema).check(Schema.isMaxLength(256)),
})

/** Connection inspection never opens a native session. Choice catalogs can remain session-scoped. */
export const workspaceConnectionInspectionSchema = Schema.Struct({
  connectionId: workspaceConnectionSchema.fields.connectionId,
  driverId: workspaceConnectionSchema.fields.driverId,
  protocol: Schema.Struct({
    state: Schema.Literals(['initialized', 'not-established']),
    version: Schema.optional(Schema.String),
  }),
  authentication: Schema.Literal('unknown'),
  /** Access modes the connection can enforce natively. Absent means only approval-required is known. */
  accessModes: Schema.optional(Schema.Array(agentAccessModeSchema)),
  capabilities: Schema.Struct({
    openSession: capabilitySchema,
    loadSession: capabilitySchema,
    submit: capabilitySchema,
    interrupt: capabilitySchema,
    steer: capabilitySchema,
    respond: capabilitySchema,
    reconcile: capabilitySchema,
    models: choiceFactsSchema,
    modes: choiceFactsSchema,
    promptContent: Schema.optional(Schema.Struct({ images: Schema.Boolean, files: Schema.Boolean })),
  }),
})

export type WorkspaceConnection = Schema.Schema.Type<typeof workspaceConnectionSchema>
export type WorkspaceConnectionList = Schema.Schema.Type<typeof workspaceConnectionListSchema>
export type WorkspaceConnectionInspection = Schema.Schema.Type<typeof workspaceConnectionInspectionSchema>
