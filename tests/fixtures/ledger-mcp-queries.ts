import type { EngineRuntime } from '../../src/infrastructure/runtime/engine-runtime.js'
import { ledgerQueryRequest } from '../../src/platform/electron/workers/query-dispatch.js'
import { createLedgerMcpQueries, type LedgerMcpQueries } from '../../src/platform/mcp/query-api.js'

export function fixtureLedgerMcpQueries(runtime: EngineRuntime): LedgerMcpQueries {
  return createLedgerMcpQueries({
    request: async (op, ...args) => {
      const query = ledgerQueryRequest(op, args)
      if (!query) throw new Error(`Unexpected ledger MCP read: ${op}`)
      return runtime.runPromise(query)
    },
  })
}
