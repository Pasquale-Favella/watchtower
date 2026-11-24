import * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'

import type { AgentDriverError, AgentMcpEndpoint } from '@/core/ports/agent-driver.js'
import { bearerHeaderValue } from '@/platform/mcp/auth.js'
import { acquireLoopbackMcp, type LoopbackMcpEndpoint } from '@/platform/mcp/loopback-endpoint.js'
import type { LedgerMcpQueries } from '@/platform/mcp/query-api.js'
import { createLedgerMcpServer } from '@/platform/mcp/server.js'

export type LedgerMcpEndpoint = LoopbackMcpEndpoint & { readonly name: 'watchtower-ledger' }

export const acquireLedgerMcp = Effect.fn('acquireLedgerMcp')(function* (
  queries: LedgerMcpQueries,
  runRequest: (request: Effect.Effect<void>) => Promise<void>,
): Effect.fn.Return<LedgerMcpEndpoint, AgentDriverError, Scope.Scope> {
  const endpoint = yield* acquireLoopbackMcp({
    createServer: signal => createLedgerMcpServer(queries, signal),
    runRequest,
    startFailure: 'The ledger MCP connection could not start.',
  })
  return { name: 'watchtower-ledger', ...endpoint }
})

export function ledgerMcpWithStdio(
  endpoint: LedgerMcpEndpoint,
  command: string,
  entryPath: string,
): LedgerMcpEndpoint & { readonly stdio: NonNullable<AgentMcpEndpoint['stdio']> } {
  return {
    ...endpoint,
    stdio: {
      command,
      args: [entryPath],
      env: [
        { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
        { name: 'WATCHTOWER_LEDGER_MCP_URL', value: endpoint.url },
        { name: 'WATCHTOWER_LEDGER_MCP_TOKEN', value: endpoint.token },
      ],
    },
  }
}

export function ledgerHttp(endpoint: LedgerMcpEndpoint) {
  return {
    type: 'http' as const,
    name: endpoint.name,
    url: endpoint.url,
    headers: [{ name: 'Authorization', value: bearerHeaderValue(endpoint.token) }],
  }
}
