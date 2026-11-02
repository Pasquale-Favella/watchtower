import * as Schema from 'effect/Schema'

import { type TaskId, taskIdSchema } from '@/shared/schemas/workspace.js'

/** Terminal limits shared by the RPC boundary, the host and the renderer drawer. */
export const TERMINAL_MAX_PER_TASK = 4
export const TERMINAL_MAX_LIVE_SESSIONS = 32
export const TERMINAL_SCROLLBACK_BYTES = 512 * 1024
export const TERMINAL_WRITE_MAX_CHARS = 65_536
export const TERMINAL_DEFAULT_COLS = 120
export const TERMINAL_DEFAULT_ROWS = 30
export const TERMINAL_MAX_COLS = 1000
export const TERMINAL_MAX_ROWS = 500

/** Tab ids are allocated lowest-first per Task, so a Task never names more than TERMINAL_MAX_PER_TASK tabs. */
export const TERMINAL_IDS = ['term-1', 'term-2', 'term-3', 'term-4'] as const
export const terminalIdSchema = Schema.Literals(TERMINAL_IDS)
export type TerminalId = Schema.Schema.Type<typeof terminalIdSchema>

const terminalColsSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(TERMINAL_MAX_COLS),
)
const terminalRowsSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(TERMINAL_MAX_ROWS),
)
const sequenceSchema = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

export const terminalColsField = terminalColsSchema
export const terminalRowsField = terminalRowsSchema
export const terminalWriteSchema = Schema.String.check(Schema.isMaxLength(TERMINAL_WRITE_MAX_CHARS))

export const terminalStatusSchema = Schema.Literals(['running', 'exited'])
export type TerminalStatus = Schema.Schema.Type<typeof terminalStatusSchema>

/** One tab's metadata. `sequence` is the last event number the session has produced. */
export const terminalSummarySchema = Schema.Struct({
  terminalId: terminalIdSchema,
  status: terminalStatusSchema,
  exitCode: Schema.NullOr(Schema.Int),
  cols: terminalColsSchema,
  rows: terminalRowsSchema,
  sequence: sequenceSchema,
})
export type TerminalSummary = Schema.Schema.Type<typeof terminalSummarySchema>

/** Bounded scrollback at `sequence`. Live output with a greater sequence continues it. */
export const terminalSnapshotSchema = Schema.Struct({
  ...terminalSummarySchema.fields,
  data: Schema.String,
})
export type TerminalSnapshot = Schema.Schema.Type<typeof terminalSnapshotSchema>

/** Stream frames for one session. Consumers drop frames whose sequence is not newer than the last applied one. */
export const terminalFrameSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('snapshot'),
    sequence: sequenceSchema,
    status: terminalStatusSchema,
    exitCode: Schema.NullOr(Schema.Int),
    cols: terminalColsSchema,
    rows: terminalRowsSchema,
    data: Schema.String,
  }),
  Schema.Struct({ _tag: Schema.Literal('output'), sequence: sequenceSchema, data: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal('exited'), sequence: sequenceSchema, exitCode: Schema.NullOr(Schema.Int) }),
  Schema.Struct({
    _tag: Schema.Literal('restarted'),
    sequence: sequenceSchema,
    cols: terminalColsSchema,
    rows: terminalRowsSchema,
  }),
])
export type TerminalFrame = Schema.Schema.Type<typeof terminalFrameSchema>

/** Requests name a Task and a tab. The working directory is resolved by the server, never supplied here. */
export const terminalRefSchema = Schema.Struct({
  taskId: taskIdSchema,
  terminalId: terminalIdSchema,
})

export const openTerminalRequestSchema = Schema.Struct({
  taskId: taskIdSchema,
  terminalId: terminalIdSchema,
  cols: Schema.optional(terminalColsSchema),
  rows: Schema.optional(terminalRowsSchema),
})
export type OpenTerminalRequest = Schema.Schema.Type<typeof openTerminalRequestSchema>

export const terminalListSchema = Schema.Struct({
  items: Schema.Array(terminalSummarySchema),
})

/** The key a session is registered under, in the host and in the renderer. */
export function terminalSessionKey(taskId: TaskId, terminalId: TerminalId): string {
  return JSON.stringify([taskId, terminalId])
}
