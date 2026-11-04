import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'

import { nativeHandlers } from '../../src/platform/electron/main/rpc/native-handlers.js'
import { CheckoutInspectionRpcGroup } from '../../src/shared/rpc/checkout-inspection.js'
import { CoachRpcGroup } from '../../src/shared/rpc/coach.js'
import { ShellRpcGroup } from '../../src/shared/rpc/shell.js'
import { TerminalRpcGroup } from '../../src/shared/rpc/terminal.js'
import { WorkspaceRpcGroup } from '../../src/shared/rpc/workspace.js'

import { CheckoutNavigationRpcGroup } from '../../src/shared/rpc/checkout-navigation.js'
import { CheckoutActionsRpcGroup } from '../../src/shared/rpc/checkout-actions.js'
import { WorkspacePreviewRpcGroup } from '../../src/shared/rpc/workspace-preview.js'
import { WorkspaceDeviceRpcGroup } from '../../src/shared/rpc/workspace-devices.js'
import { WorkspacePullRequestRpcGroup } from '../../src/shared/rpc/workspace-pull-requests.js'
import { WorkspaceSideChatRpcGroup } from '../../src/shared/rpc/workspace-side-chats.js'

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

export const unexpectedCheckoutInspectionHandlers = CheckoutInspectionRpcGroup.toLayer({
  'checkout:diffPreview': unexpected,
  'checkout:filePatch': unexpected,
  'checkout:branches': unexpected,
  'checkout:listEntries': unexpected,
  'checkout:readFile': unexpected,
})

export const unexpectedTerminalHandlers = TerminalRpcGroup.toLayer({
  'terminal:open': unexpected,
  'terminal:adoptDraft': unexpected,
  'terminal:attach': () => Stream.die(new Error('Unexpected terminal subscription in a data-query test')),
  'terminal:write': unexpected,
  'terminal:resize': unexpected,
  'terminal:restart': unexpected,
  'terminal:close': unexpected,
  'terminal:list': unexpected,
})

const unexpectedCheckoutNavigationHandlers = CheckoutNavigationRpcGroup.toLayer({
  'checkout:openFile': unexpected,
  'checkout:revealFile': unexpected,
})

const unexpectedCheckoutActionsRpcGroupHandlers = CheckoutActionsRpcGroup.toLayer({
  'checkout:gitStatus': unexpected,
  'checkout:stage': unexpected,
  'checkout:unstage': unexpected,
  'checkout:commit': unexpected,
})

const unexpectedWorkspacePreviewRpcGroupHandlers = WorkspacePreviewRpcGroup.toLayer({
  'preview:capture': unexpected,
  'preview:focusApp': unexpected,
  'preview:open': unexpected,
  'preview:navigate': unexpected,
  'preview:command': unexpected,
  'preview:layout': unexpected,
  'preview:close': unexpected,
  'preview:adopt': unexpected,
  'preview:events': () => Stream.die(new Error('Unexpected resource subscription in a data-query test')),
})

const unexpectedWorkspaceDeviceRpcGroupHandlers = WorkspaceDeviceRpcGroup.toLayer({
  'devices:connect': unexpected,
  'devices:list': unexpected,
  'devices:boot': unexpected,
  'devices:shutdown': unexpected,
  'devices:screenshot': unexpected,
  'devices:action': unexpected,
  'devices:install': unexpected,
})

const unexpectedWorkspacePullRequestRpcGroupHandlers = WorkspacePullRequestRpcGroup.toLayer({
  'pull-requests:list': unexpected,
  'pull-requests:detail': unexpected,
  'pull-requests:checks': unexpected,
  'pull-requests:diff': unexpected,
  'pull-requests:threads': unexpected,
  'pull-requests:comment': unexpected,
  'pull-requests:review': unexpected,
  'pull-requests:reply': unexpected,
  'pull-requests:resolveThread': unexpected,
  'pull-requests:action': unexpected,
  'pull-requests:update': unexpected,
  'pull-requests:create': unexpected,
})

const unexpectedWorkspaceSideChatRpcGroupHandlers = WorkspaceSideChatRpcGroup.toLayer({
  'sideChat:create': unexpected,
  'sideChat:get': unexpected,
  'sideChat:list': unexpected,
  'sideChat:bringBack': unexpected,
})

export const unexpectedWorkspacePanelHandlers = Layer.mergeAll(
  unexpectedCheckoutNavigationHandlers,
  unexpectedCheckoutActionsRpcGroupHandlers,
  unexpectedWorkspacePreviewRpcGroupHandlers,
  unexpectedWorkspaceDeviceRpcGroupHandlers,
  unexpectedWorkspacePullRequestRpcGroupHandlers,
  unexpectedWorkspaceSideChatRpcGroupHandlers,
)

export const unexpectedWorkspaceHandlers = WorkspaceRpcGroup.toLayer({
  'workspace:status': unexpected,
  'workspace:importAttachment': unexpected,
  'workspace:previewAttachment': unexpected,
  'workspace:searchPromptContext': unexpected,
  'workspace:attachPromptContext': unexpected,
  'workspace:listConnections': unexpected,
  'workspace:inspectConnection': unexpected,
  'workspace:ensureScratchProject': unexpected,
  'workspace:chooseProjectDirectory': unexpected,
  'workspace:browseDirectories': unexpected,
  'workspace:remoteSourceReadiness': unexpected,
  'workspace:lookupGitHubRepository': unexpected,
  'workspace:createProject': unexpected,
  'workspace:cloneProject': unexpected,
  'workspace:registerProject': unexpected,
  'workspace:createTask': unexpected,
  'workspace:listBranches': unexpected,
  'workspace:switchBranch': unexpected,
  'workspace:createWorktree': unexpected,
  'workspace:listProjects': unexpected,
  'workspace:getProject': unexpected,
  'workspace:listTasks': unexpected,
  'workspace:readTaskDetail': unexpected,
  'workspace:readTaskSnapshot': unexpected,
  'workspace:listNativeAgentSessions': unexpected,
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
  unexpectedCheckoutInspectionHandlers,
  unexpectedTerminalHandlers,
  unexpectedWorkspacePanelHandlers,
)
