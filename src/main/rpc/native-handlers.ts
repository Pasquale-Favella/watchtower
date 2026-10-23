import * as Effect from 'effect/Effect'

import { NativeRpcError, NativeRpcGroup } from '../../shared/rpc/native.js'
import {
  type CoachHarnessesResult,
  type CoachInspectRequest,
  type CoachInspectResult,
  type CoachLoginTerminalResult,
} from '../../shared/schemas/agents.js'
import type { ExportResult } from '../../shared/schemas/export.js'
import type { ScanResult } from '../../shared/schemas/ipc.js'
import type { LedgerMcpConnection, LedgerMcpStartupMode, LedgerMcpStatus } from '../../shared/schemas/ledger-mcp.js'
import type {
  SkillsDismissalRequest,
  SkillsDismissalResult,
  SkillsSaveRequest,
  SkillsSaveResult,
} from '../../shared/schemas/skills.js'
import type { AppVersion, UpdateStatus } from '../../shared/schemas/updates.js'

/** Explicit main-process capabilities. Implementations stay with the owners of
 * dialogs, updater state, credentials, the ledger, and harness processes. */
export interface NativeRpcCapabilities {
  readonly startScan: (options: { readonly provider?: string }) => Effect.Effect<ScanResult, unknown>
  readonly isScanActive: () => Effect.Effect<boolean, unknown>
  readonly getUpdateStatus: () => Effect.Effect<UpdateStatus, unknown>
  readonly checkForUpdates: () => Effect.Effect<UpdateStatus, unknown>
  readonly downloadUpdate: () => Effect.Effect<UpdateStatus, unknown>
  readonly installUpdate: () => Effect.Effect<UpdateStatus, unknown>
  readonly exportData: (request: {
    readonly format: 'csv' | 'json'
    readonly destination?: string
  }) => Effect.Effect<ExportResult, unknown>
  readonly getLedgerMcpStatus: () => Effect.Effect<LedgerMcpStatus, unknown>
  readonly setLedgerMcpStartupMode: (mode: LedgerMcpStartupMode) => Effect.Effect<LedgerMcpStatus, unknown>
  readonly getLedgerMcpConnection: () => Effect.Effect<LedgerMcpConnection, unknown>
  readonly regenerateLedgerMcpToken: () => Effect.Effect<LedgerMcpStatus, unknown>
  readonly getAppVersion: () => Effect.Effect<AppVersion, unknown>
  readonly dismissSkill: (request: SkillsDismissalRequest) => Effect.Effect<SkillsDismissalResult, unknown>
  readonly saveSkill: (request: SkillsSaveRequest) => Effect.Effect<SkillsSaveResult, unknown>
  readonly getCoachHarnesses: () => Effect.Effect<CoachHarnessesResult, unknown>
  readonly refreshCoachHarnesses: () => Effect.Effect<CoachHarnessesResult, unknown>
  readonly inspectCoachHarness: (request: CoachInspectRequest) => Effect.Effect<CoachInspectResult, unknown>
  readonly openCoachLoginTerminal: (instanceId: string) => Effect.Effect<CoachLoginTerminalResult, unknown>
}

const operationFailed = new NativeRpcError({ code: 'operation-failed', message: 'Native operation failed' })

/** Convert failures crossing the native boundary to a fixed, secret-free wire
 * error. Interruption remains interruption so closing a caller can cancel its
 * scoped operation. */
function invoke<A>(operation: () => Effect.Effect<A, unknown>): Effect.Effect<A, NativeRpcError> {
  return Effect.suspend(operation).pipe(
    Effect.catch(() => Effect.fail(operationFailed)),
    Effect.catchDefect(() => Effect.fail(operationFailed)),
  )
}

export function nativeHandlers(capabilities: NativeRpcCapabilities) {
  return NativeRpcGroup.toLayer({
    'scan:start': options => invoke(() => capabilities.startScan(options)),
    'scan:active': () => invoke(capabilities.isScanActive),
    'updates:status': () => invoke(capabilities.getUpdateStatus),
    'updates:check': () => invoke(capabilities.checkForUpdates),
    'updates:download': () => invoke(capabilities.downloadUpdate),
    'updates:install': () => invoke(capabilities.installUpdate),
    export: request => invoke(() => capabilities.exportData(request)),
    'ledger-mcp:status': () => invoke(capabilities.getLedgerMcpStatus),
    'ledger-mcp:startup:set': ({ mode }) => invoke(() => capabilities.setLedgerMcpStartupMode(mode)),
    'ledger-mcp:connection': () => invoke(capabilities.getLedgerMcpConnection),
    'ledger-mcp:token:regenerate': () => invoke(capabilities.regenerateLedgerMcpToken),
    'app:version': () => invoke(capabilities.getAppVersion),
    'skills:dismiss': request => invoke(() => capabilities.dismissSkill(request)),
    'skills:save': request => invoke(() => capabilities.saveSkill(request)),
    'coach:harnesses': () => invoke(capabilities.getCoachHarnesses),
    'coach:harnesses-refresh': () => invoke(capabilities.refreshCoachHarnesses),
    'coach:inspect': ({ request }) => invoke(() => capabilities.inspectCoachHarness(request)),
    'coach:open-login-terminal': ({ instanceId }) => invoke(() => capabilities.openCoachLoginTerminal(instanceId)),
  })
}
