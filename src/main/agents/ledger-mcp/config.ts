import { harnessSpecs } from '../harnesses/index.js'
import type { AcpMcpServer } from '../harnesses/types.js'

/**
 * Main-side builder for the injected `watchtower-ledger` MCP server: turns
 * the app's own runtime facts — its binary path, the ledger-mcp bundle path,
 * and the ledger DB path — into an ACP `McpServerStdio` config the harness
 * agent spawns. The server is the app itself running as plain node
 * (`ELECTRON_RUN_AS_NODE=1`), so no external binary or network service is
 * needed in dev or packaged builds.
 *
 * The server serves the FULL lifetime ledger — no scope is baked at spawn.
 * Filtering is the harness's job: every tool accepts an optional `scope`
 * argument (shared `overviewScopeSchema`) and the briefing tells the agent
 * about it, so a single server instance answers any window the agent asks
 * about. This is why the spawn context carries only `dbPath`: there is
 * nothing per-conversation left to bake.
 */

export interface LedgerMcpSpawnContext {
  /** `process.execPath` — the Electron/watchtower binary. */
  execPath: string
  /** Absolute path to the bundled entry (`<appPath>/out/main/ledger-mcp.js`). */
  entryPath: string
  /** The app ledger DB (`<userData>/ledger.db`). */
  dbPath: string
}

/** Client-provided MCP transport for a harness registry key: 'http' only
 *  where the spec says so (Copilot — stdio is rejected there), 'stdio'
 *  everywhere else including unknown keys (the agent-spawned default). */
export function ledgerMcpTransportFor(harnessKind: string): 'stdio' | 'http' {
  return harnessSpecs.find(spec => spec.kind === harnessKind)?.clientMcpTransport ?? 'stdio'
}

export function buildLedgerMcpServer(ctx: LedgerMcpSpawnContext): AcpMcpServer {
  // The spawn env carries only the DB path: the server always reads the full
  // lifetime history, and per-window filtering rides the tools' `scope`
  // argument (ADR 0020). The entry validates the context and opens the
  // ledger read-only.
  const context = { dbPath: ctx.dbPath }
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
