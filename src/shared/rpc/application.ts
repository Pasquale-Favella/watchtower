import * as RpcGroup from 'effect/rpc/RpcGroup'

import { AnalyticsRpcGroup, GetOverview } from './analytics.js'
import { CoachRpcGroup } from './coach.js'
import { ConfigRpcGroup } from './config.js'
import { LifecycleRpcGroup } from './lifecycle.js'
import { NativeRpcGroup, StartScan } from './native.js'

export const ApplicationRpcGroup = AnalyticsRpcGroup.merge(ConfigRpcGroup)
  .merge(CoachRpcGroup)
  .merge(NativeRpcGroup)
  .merge(LifecycleRpcGroup.omit('panel:events', 'beacon:events'))
export const PanelRpcGroup = RpcGroup.make(GetOverview, StartScan).merge(
  LifecycleRpcGroup.omit('app:events', 'beacon:events'),
)
export const BeaconRpcGroup = LifecycleRpcGroup.omit('app:events', 'panel:events')
