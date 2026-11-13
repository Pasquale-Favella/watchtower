import * as RpcGroup from 'effect/rpc/RpcGroup'

import { AnalyticsRpcGroup, GetOverview } from '@/shared/rpc/analytics.js'
import { CheckoutInspectionRpcGroup } from '@/shared/rpc/checkout-inspection.js'
import { CheckoutActionsRpcGroup } from '@/shared/rpc/checkout-actions.js'
import { CheckoutNavigationRpcGroup } from '@/shared/rpc/checkout-navigation.js'
import { CoachRpcGroup } from '@/shared/rpc/coach.js'
import { ConfigRpcGroup } from '@/shared/rpc/config.js'
import { LifecycleRpcGroup } from '@/shared/rpc/lifecycle.js'
import { NativeRpcGroup, StartScan } from '@/shared/rpc/native.js'
import { OrbShellRpcGroup, ShellRpcGroup } from '@/shared/rpc/shell.js'
import { TerminalRpcGroup } from '@/shared/rpc/terminal.js'
import { WorkspaceRpcGroup } from '@/shared/rpc/workspace.js'
import { WorkspacePreviewRpcGroup } from '@/shared/rpc/workspace-preview.js'
import { WorkspaceDeviceRpcGroup } from '@/shared/rpc/workspace-devices.js'
import { WorkspacePullRequestRpcGroup } from '@/shared/rpc/workspace-pull-requests.js'
import { WorkspaceSideChatRpcGroup } from '@/shared/rpc/workspace-side-chats.js'

export const ApplicationRpcGroup = AnalyticsRpcGroup.merge(ConfigRpcGroup)
  .merge(CoachRpcGroup)
  .merge(WorkspaceRpcGroup)
  .merge(WorkspacePreviewRpcGroup)
  .merge(WorkspaceDeviceRpcGroup)
  .merge(WorkspacePullRequestRpcGroup)
  .merge(WorkspaceSideChatRpcGroup)
  .merge(CheckoutInspectionRpcGroup)
  .merge(CheckoutActionsRpcGroup)
  .merge(CheckoutNavigationRpcGroup)
  .merge(TerminalRpcGroup)
  .merge(ShellRpcGroup)
  .merge(NativeRpcGroup)
  .merge(LifecycleRpcGroup.omit('panel:events', 'beacon:events'))
export const PanelRpcGroup = RpcGroup.make(GetOverview, StartScan)
  .merge(LifecycleRpcGroup.omit('app:events', 'beacon:events'))
  .merge(OrbShellRpcGroup)
export const BeaconRpcGroup = LifecycleRpcGroup.omit('app:events', 'panel:events').merge(OrbShellRpcGroup)
