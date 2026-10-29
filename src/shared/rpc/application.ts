import * as RpcGroup from 'effect/rpc/RpcGroup'

import { AnalyticsRpcGroup, GetOverview } from '@/shared/rpc/analytics.js'
import { CoachRpcGroup } from '@/shared/rpc/coach.js'
import { ConfigRpcGroup } from '@/shared/rpc/config.js'
import { LifecycleRpcGroup } from '@/shared/rpc/lifecycle.js'
import { OrbShellRpcGroup, ShellRpcGroup } from '@/shared/rpc/shell.js'
import { NativeRpcGroup, StartScan } from '@/shared/rpc/native.js'

export const ApplicationRpcGroup = AnalyticsRpcGroup.merge(ConfigRpcGroup)
  .merge(CoachRpcGroup)
  .merge(ShellRpcGroup)
  .merge(NativeRpcGroup)
  .merge(LifecycleRpcGroup.omit('panel:events', 'beacon:events'))
export const PanelRpcGroup = RpcGroup.make(GetOverview, StartScan)
  .merge(LifecycleRpcGroup.omit('app:events', 'beacon:events'))
  .merge(OrbShellRpcGroup)
export const BeaconRpcGroup = LifecycleRpcGroup.omit('app:events', 'panel:events').merge(OrbShellRpcGroup)
