import * as Schema from 'effect/Schema'

import { projectIdSchema, type TaskId, taskIdSchema, workspaceCheckoutIdSchema } from '@/shared/schemas/workspace.js'

/** Terminal limits shared by the RPC boundary, the host and the renderer drawer. */
export const TERMINAL_MAX_PER_TASK = 32
export const TERMINAL_MAX_PER_GROUP = 4
export const TERMINAL_MAX_LIVE_SESSIONS = 32
export const TERMINAL_SCROLLBACK_BYTES = 512 * 1024
export const TERMINAL_WRITE_MAX_CHARS = 65_536
export const TERMINAL_DEFAULT_COLS = 120
export const TERMINAL_DEFAULT_ROWS = 30
export const TERMINAL_MAX_COLS = 1000
export const TERMINAL_MAX_ROWS = 500

/** Tab ids are allocated lowest-first per Task, so a Task never names more than TERMINAL_MAX_PER_TASK tabs. */
export const TERMINAL_IDS = [
  'term-1',
  'term-2',
  'term-3',
  'term-4',
  'term-5',
  'term-6',
  'term-7',
  'term-8',
  'term-9',
  'term-10',
  'term-11',
  'term-12',
  'term-13',
  'term-14',
  'term-15',
  'term-16',
  'term-17',
  'term-18',
  'term-19',
  'term-20',
  'term-21',
  'term-22',
  'term-23',
  'term-24',
  'term-25',
  'term-26',
  'term-27',
  'term-28',
  'term-29',
  'term-30',
  'term-31',
  'term-32',
] as const
export const terminalIdSchema = Schema.Literals(TERMINAL_IDS)
export type TerminalId = Schema.Schema.Type<typeof terminalIdSchema>

export const draftTerminalTargetSchema = Schema.Struct({
  kind: Schema.Literal('draft'),
  draftId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200), Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
  projectId: Schema.NullOr(projectIdSchema),
  checkoutId: Schema.optional(workspaceCheckoutIdSchema),
})
export type DraftTerminalTarget = Schema.Schema.Type<typeof draftTerminalTargetSchema>
export const terminalTargetSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('task'), taskId: taskIdSchema }),
  draftTerminalTargetSchema,
])
export type TerminalTarget = Schema.Schema.Type<typeof terminalTargetSchema>
export type TerminalOwner = TaskId | TerminalTarget

export function terminalTarget(owner: TerminalOwner): TerminalTarget {
  return typeof owner === 'string' ? { kind: 'task', taskId: owner } : owner
}

/** Stable namespace for shell ownership, distinct from Task identity for an unsent draft. */
export function terminalOwnerKey(owner: TerminalOwner): string {
  const target = terminalTarget(owner)
  return target.kind === 'task'
    ? target.taskId
    : JSON.stringify(['draft', target.draftId, target.projectId, target.checkoutId ?? null])
}

export const terminalOwnerRequestFields = {
  taskId: Schema.optional(taskIdSchema),
  target: Schema.optional(terminalTargetSchema),
}

export interface TerminalOwnerRequest {
  readonly taskId?: TaskId | undefined
  readonly target?: TerminalTarget | undefined
}

export function terminalRequestTarget(request: TerminalOwnerRequest): TerminalTarget {
  if (request.target) return request.target
  if (request.taskId) return { kind: 'task', taskId: request.taskId }
  throw new Error('A terminal owner is required')
}

export function terminalTargetPayload(owner: TerminalOwner): { readonly target: TerminalTarget } {
  return { target: terminalTarget(owner) }
}

export const terminalOwnerRequestCheck = Schema.makeFilter<TerminalOwnerRequest>(
  request => Boolean(request.taskId) !== Boolean(request.target) || 'Exactly one terminal owner is required.',
)
export const terminalOwnerRequestSchema = Schema.Struct(terminalOwnerRequestFields).check(terminalOwnerRequestCheck)

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
  ...terminalOwnerRequestFields,
  terminalId: terminalIdSchema,
}).check(terminalOwnerRequestCheck)

export const openTerminalRequestSchema = Schema.Struct({
  ...terminalOwnerRequestFields,
  terminalId: terminalIdSchema,
  cols: Schema.optional(terminalColsSchema),
  rows: Schema.optional(terminalRowsSchema),
}).check(terminalOwnerRequestCheck)
export type OpenTerminalRequest = Schema.Schema.Type<typeof openTerminalRequestSchema>

export const terminalListSchema = Schema.Struct({
  items: Schema.Array(terminalSummarySchema),
})

/** The key a session is registered under, in the host and in the renderer. */
export function terminalSessionKey(owner: TerminalOwner, terminalId: TerminalId): string {
  return JSON.stringify([terminalOwnerKey(owner), terminalId])
}
