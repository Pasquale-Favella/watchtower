import * as RpcGroup from 'effect/rpc/RpcGroup'

import { AnalyticsRpcGroup, GetOverview } from './analytics.js'
import { ConfigRpcGroup } from './config.js'

export const ApplicationRpcGroup = AnalyticsRpcGroup.merge(ConfigRpcGroup)
export const PanelRpcGroup = RpcGroup.make(GetOverview)
