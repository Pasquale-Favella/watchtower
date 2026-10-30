import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'

import { nativeHandlers } from '../../src/platform/electron/main/rpc/native-handlers.js'
import { CoachRpcGroup } from '../../src/shared/rpc/coach.js'
import { ShellRpcGroup } from '../../src/shared/rpc/shell.js'
import { WorkspaceRpcGroup } from '../../src/shared/rpc/workspace.js'

const unexpected = () => Effect.die(new Error('Unexpected native RPC operation in a data-query test'))

export const unexpectedShellRpcs = ShellRpcGroup.of({
  'shell:events': () => Stream.die(new Error('Unexpected shell subscription in a data-query test')),
  'shell:notice': unexpected,
  'shell:open-external': unexpected,
  'shell:open-settings': unexpected,
})
export const unexpectedShellHandlers = ShellRpcGroup.toLayer(unexpectedShellRpcs)

export const unexpectedCoachHandlers = CoachRpcGroup.toLayer({
  'coach:run': () => Stream.die(new Error('Unexpected Coach run in a data-query test')),
  'coach:cancel': unexpected,
  'coach:reset': unexpected,
})

export const unexpectedWorkspaceHandlers = WorkspaceRpcGroup.toLayer({
  'workspace:status': unexpected,
  'workspace:registerProject': unexpected,
  'workspace:createTask': unexpected,
  'workspace:listProjects': unexpected,
  'workspace:getProject': unexpected,
  'workspace:listTasks': unexpected,
  'workspace:readTaskDetail': unexpected,
  'workspace:readConversationPage': unexpected,
  'workspace:listPendingRuntimeRequests': unexpected,
  'workspace:readWorkspacePayload': unexpected,
  'workspace:listQueuedFollowUps': unexpected,
  'workspace:listRequestResponses': unexpected,
  'workspace:listSteerIntents': unexpected,
  'workspace:startRun': unexpected,
  'workspace:interrupt': unexpected,
  'workspace:respond': unexpected,
  'workspace:steer': unexpected,
  'workspace:enqueueFollowUp': unexpected,
  'workspace:cancelQueuedFollowUp': unexpected,
  'workspace:promoteQueuedFollowUp': unexpected,
  'workspace:events': () => Stream.die(new Error('Unexpected workspace subscription in a data-query test')),
})

/** Keep data-query tests on the production group while refusing unrelated capabilities. */
export const unexpectedNativeHandlers = Layer.mergeAll(
  nativeHandlers({
    startScan: unexpected,
    isScanActive: unexpected,
    getUpdateStatus: unexpected,
    checkForUpdates: unexpected,
    downloadUpdate: unexpected,
    installUpdate: unexpected,
    exportData: unexpected,
    getLedgerMcpStatus: unexpected,
    setLedgerMcpStartupMode: unexpected,
    getLedgerMcpConnection: unexpected,
    regenerateLedgerMcpToken: unexpected,
    getAppVersion: unexpected,
    dismissSkill: unexpected,
    saveSkill: unexpected,
    getCoachHarnesses: unexpected,
    refreshCoachHarnesses: unexpected,
    inspectCoachHarness: unexpected,
    openCoachLoginTerminal: unexpected,
  }),
  unexpectedCoachHandlers,
  unexpectedShellHandlers,
  unexpectedWorkspaceHandlers,
)
