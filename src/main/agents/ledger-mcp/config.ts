import type { OverviewScope } from '../../../shared/schemas/overview.js'
import type { AcpMcpServer } from '../harnesses/types.js'

/**
 * Main-side builder for the injected `watchtower-ledger` MCP server (map 53):
 * turns the app's own runtime facts — its binary path, the ledger-mcp bundle
 * path, the ledger DB path, and the current UI scope — into an ACP
 * `McpServerStdio` config the harness agent spawns. The server is the app
 * itself running as plain node (`ELECTRON_RUN_AS_NODE=1`), so no external
 * binary or network service is needed in dev or packaged builds.
 */

export interface LedgerMcpSpawnContext {
  /** `process.execPath` — the Electron/watchtower binary. */
  execPath: string
  /** Absolute path to the bundled entry (`<appPath>/out/main/ledger-mcp.js`). */
  entryPath: string
  /** The app ledger DB (`<userData>/ledger.db`). */
  dbPath: string
}

export function buildLedgerMcpServer(ctx: LedgerMcpSpawnContext, scope: OverviewScope): AcpMcpServer {
  // The conversation's UI scope rides the spawn env verbatim (ADR 0020); the
  // entry validates it and computes the range itself via overviewDateRange.
  const context = { dbPath: ctx.dbPath, scope }
  return {
    name: 'watchtower-ledger',
    command: ctx.execPath,
    args: [ctx.entryPath, '--ledger-mcp'],
    env: [
      { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
      { name: 'WATCHTOWER_LEDGER_MCP', value: JSON.stringify(context) },
    ],
  }
}
