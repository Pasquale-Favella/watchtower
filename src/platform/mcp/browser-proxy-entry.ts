import * as NodeRuntime from '@effect/platform-node/NodeRuntime'

import { runHttpMcpStdioProxy } from './http-stdio-proxy.js'

NodeRuntime.runMain(
  runHttpMcpStdioProxy({
    serverName: 'watchtower-browser',
    urlVariable: 'WATCHTOWER_BROWSER_MCP_URL',
    tokenVariable: 'WATCHTOWER_BROWSER_MCP_TOKEN',
  }),
)
