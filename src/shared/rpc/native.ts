import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import {
  coachHarnessesResultSchema,
  coachInspectRequestSchema,
  coachInspectResultSchema,
  coachLoginTerminalResultSchema,
  coachOpenLoginTerminalRequestSchema,
} from '../schemas/agents.js'
import { exportResultSchema } from '../schemas/export.js'
import { scanResultSchema } from '../schemas/ipc.js'
import { ledgerMcpStartupModeSchema } from '../schemas/ledger-mcp.js'
import { ledgerMcpConnectionSchema, ledgerMcpStatusSchema } from '../schemas/ledger-mcp.js'
import {
  skillsDismissalRequestSchema,
  skillsDismissalResultSchema,
  skillsSaveRequestSchema,
  skillsSaveResultSchema,
} from '../schemas/skills.js'
import { appVersionSchema, updateStatusSchema } from '../schemas/updates.js'

/** A native main-process operation failed. This wire error intentionally has
 * no cause, message interpolation, or operation details that could disclose
 * paths, credentials, SQL, or runtime stack data. */
export class NativeRpcError extends Schema.TaggedError<NativeRpcError>()('NativeRpcError', {
  code: Schema.Literal('operation-failed'),
  message: Schema.Literal('Native operation failed'),
}) {}

const scanOptionsSchema = Schema.Struct({ provider: Schema.optional(Schema.String) })
const exportRequestSchema = Schema.Struct({
  format: Schema.Literals(['csv', 'json']),
  destination: Schema.optional(Schema.String),
})

/** Main-owned application operations that are not worker analytics or config.
 * Tags retain the established renderer operation names. */
export const NativeRpcGroup = RpcGroup.make(
  Rpc.make('scan:start', { payload: scanOptionsSchema, success: scanResultSchema, error: NativeRpcError }),
  Rpc.make('scan:active', { success: Schema.Boolean, error: NativeRpcError }),
  Rpc.make('updates:status', { success: updateStatusSchema, error: NativeRpcError }),
  Rpc.make('updates:check', { success: updateStatusSchema, error: NativeRpcError }),
  Rpc.make('updates:download', { success: updateStatusSchema, error: NativeRpcError }),
  Rpc.make('updates:install', { success: updateStatusSchema, error: NativeRpcError }),
  Rpc.make('export', { payload: exportRequestSchema, success: exportResultSchema, error: NativeRpcError }),
  Rpc.make('ledger-mcp:status', { success: ledgerMcpStatusSchema, error: NativeRpcError }),
  Rpc.make('ledger-mcp:startup:set', {
    payload: { mode: ledgerMcpStartupModeSchema },
    success: ledgerMcpStatusSchema,
    error: NativeRpcError,
  }),
  Rpc.make('ledger-mcp:connection', { success: ledgerMcpConnectionSchema, error: NativeRpcError }),
  Rpc.make('ledger-mcp:token:regenerate', { success: ledgerMcpStatusSchema, error: NativeRpcError }),
  Rpc.make('app:version', { success: appVersionSchema, error: NativeRpcError }),
  Rpc.make('skills:dismiss', {
    payload: skillsDismissalRequestSchema,
    success: skillsDismissalResultSchema,
    error: NativeRpcError,
  }),
  Rpc.make('skills:save', { payload: skillsSaveRequestSchema, success: skillsSaveResultSchema, error: NativeRpcError }),
  Rpc.make('coach:harnesses', { success: coachHarnessesResultSchema, error: NativeRpcError }),
  Rpc.make('coach:harnesses-refresh', { success: coachHarnessesResultSchema, error: NativeRpcError }),
  Rpc.make('coach:inspect', {
    payload: { request: coachInspectRequestSchema },
    success: coachInspectResultSchema,
    error: NativeRpcError,
  }),
  Rpc.make('coach:open-login-terminal', {
    payload: { instanceId: coachOpenLoginTerminalRequestSchema },
    success: coachLoginTerminalResultSchema,
    error: NativeRpcError,
  }),
)
