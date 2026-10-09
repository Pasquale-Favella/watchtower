import * as Schema from 'effect/Schema'

import { overviewScopeSchema } from './overview.js'

const writable = Schema.mutableKey
const mutableArray = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.mutable(Schema.Array(schema))
const optionalText = Schema.optional(Schema.String)
const nullableOptionalText = Schema.optional(Schema.NullOr(Schema.String))

export const coachModelInfoSchema = Schema.Struct({
  modelId: writable(Schema.String),
  name: writable(Schema.String),
  description: writable(nullableOptionalText),
})
export type CoachModelInfo = Schema.Schema.Type<typeof coachModelInfoSchema>

export const coachSessionModeSchema = Schema.Struct({
  id: writable(Schema.String),
  name: writable(Schema.String),
  description: writable(nullableOptionalText),
})
export type CoachSessionMode = Schema.Schema.Type<typeof coachSessionModeSchema>

export const coachSessionModelsSchema = Schema.Struct({
  availableModels: writable(mutableArray(coachModelInfoSchema)),
  currentModelId: writable(Schema.String),
})
export type CoachSessionModels = Schema.Schema.Type<typeof coachSessionModelsSchema>

export const coachSessionModesSchema = Schema.Struct({
  availableModes: writable(mutableArray(coachSessionModeSchema)),
  currentModeId: writable(Schema.String),
})
export type CoachSessionModes = Schema.Schema.Type<typeof coachSessionModesSchema>

const statusEventSchema = Schema.Struct({
  kind: writable(Schema.Literal('status')),
  state: writable(Schema.Literals(['starting', 'running', 'done'])),
})
const textEventSchema = Schema.Struct({ kind: writable(Schema.Literal('text')), delta: writable(Schema.String) })
const reasoningEventSchema = Schema.Struct({
  kind: writable(Schema.Literal('reasoning')),
  delta: writable(Schema.String),
})
const toolEventSchema = Schema.Struct({
  kind: writable(Schema.Literal('tool')),
  tool: writable(Schema.String),
  title: writable(optionalText),
  id: writable(optionalText),
  state: writable(Schema.optional(Schema.Literals(['started', 'completed', 'error']))),
  input: writable(optionalText),
  output: writable(optionalText),
  error: writable(optionalText),
})
const sessionEventSchema = Schema.Struct({
  kind: writable(Schema.Literal('session')),
  resumeCursor: writable(Schema.String),
  models: writable(Schema.optional(coachSessionModelsSchema)),
  modes: writable(Schema.optional(coachSessionModesSchema)),
})
const noticeEventSchema = Schema.Struct({ kind: writable(Schema.Literal('notice')), message: writable(Schema.String) })
const errorEventSchema = Schema.Struct({ kind: writable(Schema.Literal('error')), message: writable(Schema.String) })

export const coachEventSchema = Schema.Union([
  statusEventSchema,
  textEventSchema,
  reasoningEventSchema,
  toolEventSchema,
  sessionEventSchema,
  noticeEventSchema,
  errorEventSchema,
])
export type CoachEvent = Schema.Schema.Type<typeof coachEventSchema>

export const coachEventEnvelopeSchema = Schema.Struct({
  runId: writable(Schema.String),
  event: writable(coachEventSchema),
})
export type CoachEventEnvelope = Schema.Schema.Type<typeof coachEventEnvelopeSchema>

export const coachRunRequestSchema = Schema.Struct({
  harnessKind: writable(Schema.String),
  modelId: writable(optionalText),
  modeId: writable(optionalText),
  scope: writable(Schema.optional(overviewScopeSchema)),
  prompt: writable(optionalText),
  resumeCursor: writable(optionalText),
  allowApiKeyEnv: writable(Schema.optional(Schema.Boolean)),
})
export type CoachRunRequest = Schema.Schema.Type<typeof coachRunRequestSchema>

export const coachRunResultSchema = Schema.Union([
  Schema.Struct({ ok: writable(Schema.Literal(true)), runId: writable(Schema.String) }),
  Schema.Struct({ ok: writable(Schema.Literal(false)), error: writable(Schema.String) }),
])
export type CoachRunResult = Schema.Schema.Type<typeof coachRunResultSchema>

export const coachHarnessRowSchema = Schema.Struct({
  instanceId: writable(Schema.String),
  kind: writable(Schema.String),
  displayName: writable(Schema.String),
  status: writable(Schema.Literals(['pending', 'ready', 'warning', 'error', 'disabled'])),
  auth: writable(
    Schema.Struct({
      status: writable(Schema.Literals(['configured', 'unauthenticated', 'unknown'])),
      label: writable(optionalText),
      loginCommand: writable(optionalText),
    }),
  ),
  version: writable(optionalText),
  binaryPath: writable(optionalText),
  message: writable(optionalText),
})
export type CoachHarnessRow = Schema.Schema.Type<typeof coachHarnessRowSchema>

export const coachHarnessesResultSchema = mutableArray(coachHarnessRowSchema)
export type CoachHarnessesResult = Schema.Schema.Type<typeof coachHarnessesResultSchema>

export const coachOpenLoginTerminalRequestSchema = Schema.String.pipe(Schema.check(Schema.isMinLength(1)))
export type CoachOpenLoginTerminalRequest = Schema.Schema.Type<typeof coachOpenLoginTerminalRequestSchema>

export const coachLoginTerminalResultSchema = Schema.Union([
  Schema.Struct({ ok: writable(Schema.Literal(true)) }),
  Schema.Struct({ ok: writable(Schema.Literal(false)), error: writable(Schema.String) }),
])
export type CoachLoginTerminalResult = Schema.Schema.Type<typeof coachLoginTerminalResultSchema>

export const coachInspectRequestSchema = Schema.Union([
  Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  Schema.Struct({
    kind: writable(Schema.String.pipe(Schema.check(Schema.isMinLength(1)))),
    allowApiKeyEnv: writable(Schema.optional(Schema.Boolean)),
  }),
])
export type CoachInspectRequest = Schema.Schema.Type<typeof coachInspectRequestSchema>

export const coachInspectResultSchema = Schema.Union([
  Schema.Struct({
    ok: writable(Schema.Literal(true)),
    models: writable(Schema.optional(coachSessionModelsSchema)),
    modes: writable(Schema.optional(coachSessionModesSchema)),
  }),
  Schema.Struct({ ok: writable(Schema.Literal(false)), error: writable(Schema.String) }),
])
export type CoachInspectResult = Schema.Schema.Type<typeof coachInspectResultSchema>
