import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { LedgerStore } from '../../store/ledger.js'
import { overviewScopeSchema, type OverviewScope } from '../../../shared/schemas/overview.js'
import { createLedgerMcpServer } from './server.js'

/**
 * The `watchtower-ledger` MCP server CLI entry (map 53, ADR 0020). The harness
 * agent spawns this exactly like any stdio MCP server: `command:
 * process.execPath`, `args: [<this bundle>, '--ledger-mcp']`, with
 * `ELECTRON_RUN_AS_NODE=1` and the spawn context in `WATCHTOWER_LEDGER_MCP`
 * (the main process builds that config via `buildLedgerMcpServer`).
 *
 * Electron-free except for the app's own (also electron-free) data layer — the
 * ledger store (read-only second connection), the aggregation seam, and the
 * view builders the UI uses — so plain-node mode runs it from the dev `out/`
 * tree AND the packaged asar. The protocol layer is the official
 * `@modelcontextprotocol/sdk` (newline-delimited JSON over stdin/stdout);
 * the server exits when the agent closes stdin.
 */

interface LedgerMcpContext {
  dbPath: string
  scope: OverviewScope
}

async function main(): Promise<void> {
  // Safety: never boot as the app — this bundle only ever runs as the MCP
  // server. (In dev the main entry is separate; this guard is belt-and-suspenders.)
  if (!process.argv.includes('--ledger-mcp')) return

  let ctx: LedgerMcpContext
  try {
    const raw: unknown = JSON.parse(process.env['WATCHTOWER_LEDGER_MCP'] ?? '')
    const parsed = raw as { dbPath?: unknown; scope?: unknown }
    const scopeResult = overviewScopeSchema.safeParse(parsed?.scope)
    if (typeof parsed?.dbPath !== 'string' || !scopeResult.success) {
      throw new Error('context must carry dbPath + a valid UI scope')
    }
    ctx = { dbPath: parsed.dbPath, scope: scopeResult.data }
  } catch (err) {
    process.stderr.write(`watchtower-ledger: bad spawn context: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
    return
  }

  let store: LedgerStore
  try {
    store = new LedgerStore(ctx.dbPath, { readOnly: true })
  } catch (err) {
    process.stderr.write(`watchtower-ledger: cannot open ledger read-only: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
    return
  }

  const server = createLedgerMcpServer(store, ctx.scope)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // The transport closes when the agent closes stdin → the SDK closes the
  // server → no handles remain → the process exits naturally.
}

void main()
