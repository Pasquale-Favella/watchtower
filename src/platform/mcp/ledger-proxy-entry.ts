import * as NodeRuntime from '@effect/platform-node/NodeRuntime'

import { runHttpMcpStdioProxy } from './http-stdio-proxy.js'

NodeRuntime.runMain(
  runHttpMcpStdioProxy({
    serverName: 'watchtower-ledger',
    urlVariable: 'WATCHTOWER_LEDGER_MCP_URL',
    tokenVariable: 'WATCHTOWER_LEDGER_MCP_TOKEN',
  }),
)
