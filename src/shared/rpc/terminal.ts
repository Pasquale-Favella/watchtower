import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import {
  openTerminalRequestSchema,
  terminalColsField,
  terminalFrameSchema,
  terminalListSchema,
  terminalRefSchema,
  terminalRowsField,
  terminalSnapshotSchema,
  terminalWriteSchema,
} from '@/shared/schemas/terminal.js'
import { taskIdSchema } from '@/shared/schemas/workspace.js'

/** The fixed message for each failure code. Messages never include paths, process output or platform error text. */
export const terminalRpcMessages = {
  'invalid-request': 'Terminal request is invalid.',
  'not-found': 'Terminal was not found.',
  'limit-reached': 'Terminal limit reached.',
  'not-running': 'Terminal process is not running.',
  conflict: 'Terminal state conflicts with this request.',
  'cwd-unavailable': 'The Task checkout is unavailable.',
  'spawn-failed': 'Terminal could not be started.',
  'stream-overflow': 'Terminal output exceeded its limit. Reattach to resume.',
  unavailable: 'Terminal is unavailable.',
  failed: 'Terminal operation failed.',
} as const

/** Sanitized terminal failures. Messages never include paths, process output or platform error text. */
export class TerminalRpcError extends Schema.TaggedError<TerminalRpcError>()('TerminalRpcError', {
  code: Schema.Literals([
    'invalid-request',
    'not-found',
    'limit-reached',
    'not-running',
    'conflict',
    'cwd-unavailable',
    'spawn-failed',
    'stream-overflow',
    'unavailable',
    'failed',
  ]),
  message: Schema.Literals(Object.values(terminalRpcMessages)),
}) {}

const error = TerminalRpcError

/** Terminal sessions are scoped to one Task. The server resolves the working directory from that Task's checkout. */
export const TerminalRpcGroup = RpcGroup.make(
  Rpc.make('terminal:open', {
    payload: openTerminalRequestSchema,
    success: terminalSnapshotSchema,
    error,
  }),
  Rpc.make('terminal:attach', {
    payload: terminalRefSchema,
    success: terminalFrameSchema,
    error,
    stream: true,
  }),
  Rpc.make('terminal:write', {
    payload: Schema.Struct({ ...terminalRefSchema.fields, data: terminalWriteSchema }),
    success: Schema.Void,
    error,
  }),
  Rpc.make('terminal:resize', {
    payload: Schema.Struct({ ...terminalRefSchema.fields, cols: terminalColsField, rows: terminalRowsField }),
    success: Schema.Void,
    error,
  }),
  Rpc.make('terminal:restart', {
    payload: openTerminalRequestSchema,
    success: terminalSnapshotSchema,
    error,
  }),
  Rpc.make('terminal:close', {
    payload: terminalRefSchema,
    success: Schema.Void,
    error,
  }),
  Rpc.make('terminal:list', {
    payload: Schema.Struct({ taskId: taskIdSchema }),
    success: terminalListSchema,
    error,
  }),
)
