import * as RpcGroup from 'effect/rpc/RpcGroup'

import { AnalyticsRpcGroup, GetOverview } from './analytics.js'
import { ConfigRpcGroup } from './config.js'
import { LifecycleRpcGroup } from './lifecycle.js'

export const ApplicationRpcGroup = AnalyticsRpcGroup.merge(ConfigRpcGroup).merge(
  LifecycleRpcGroup.omit('panel:events', 'beacon:events'),
)
export const PanelRpcGroup = RpcGroup.make(GetOverview).merge(LifecycleRpcGroup.omit('app:events', 'beacon:events'))
export const BeaconRpcGroup = LifecycleRpcGroup.omit('app:events', 'panel:events')
