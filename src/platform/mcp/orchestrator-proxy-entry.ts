import * as NodeRuntime from '@effect/platform-node/NodeRuntime'

import { runHttpMcpStdioProxy } from './http-stdio-proxy.js'

NodeRuntime.runMain(
  runHttpMcpStdioProxy({
    serverName: 'watchtower-orchestrator',
    urlVariable: 'WATCHTOWER_ORCHESTRATOR_MCP_URL',
    tokenVariable: 'WATCHTOWER_ORCHESTRATOR_MCP_TOKEN',
  }),
)
