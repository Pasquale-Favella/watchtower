import { createServer } from 'node:http'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { LedgerStore } from '../../store/ledger.js'
import { createLedgerMcpHttpHandler } from './http-server.js'
import { createLedgerMcpServer } from './server.js'

/**
 * The `watchtower-ledger` MCP server CLI entry (map 53, ADR 0020). The harness
 * agent spawns this exactly like any stdio MCP server: `command:
 * process.execPath`, `args: [<this bundle>, '--ledger-mcp']`, with
 * `ELECTRON_RUN_AS_NODE=1` and the spawn context in `WATCHTOWER_LEDGER_MCP`
 * (the main process builds that config via `buildLedgerMcpServer`).
 *
 * The server always serves the FULL lifetime ledger: filtering is the harness's
 * job through each tool's optional `scope` argument, so the spawn context
 * carries only `dbPath` — nothing per-conversation is baked at spawn.
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
}

interface LedgerMcpHttpContext {
  dbPath: string
  port: number
  token: string
}

function readContext(): LedgerMcpContext {
  const raw: unknown = JSON.parse(process.env['WATCHTOWER_LEDGER_MCP'] ?? '')
  const parsed = raw as { dbPath?: unknown }
  if (typeof parsed?.dbPath !== 'string' || parsed.dbPath.length === 0) {
    throw new Error('context must carry dbPath')
  }
  return { dbPath: parsed.dbPath }
}

function readHttpContext(): LedgerMcpHttpContext {
  const raw: unknown = JSON.parse(process.env['WATCHTOWER_LEDGER_MCP'] ?? '')
  const parsed = raw as { dbPath?: unknown; port?: unknown; token?: unknown }
  if (typeof parsed?.dbPath !== 'string' || parsed.dbPath.length === 0) {
    throw new Error('context must carry dbPath')
  }
  const port = parsed?.port
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    throw new Error('context must carry a valid port')
  }
  const token = parsed?.token
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('context must carry token')
  }
  return { dbPath: parsed.dbPath, port: port as number, token }
}

function openStoreReadOnly(dbPath: string): LedgerStore {
  try {
    return new LedgerStore(dbPath, { readOnly: true })
  } catch (err) {
    process.stderr.write(`watchtower-ledger: cannot open ledger read-only: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}

/** Loopback-HTTP mode (`--ledger-mcp-http`): the same ledger over
 *  StreamableHTTP for harnesses that reject client-provided stdio servers.
 *  Bound to 127.0.0.1 on the main-picked port; every route needs the
 *  per-spawn bearer token. The process lives until killed by the spawner
 *  (the run's release). */
async function serveHttp(): Promise<void> {
  let ctx: LedgerMcpHttpContext
  try {
    ctx = readHttpContext()
  } catch (err) {
    process.stderr.write(`watchtower-ledger: bad spawn context: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
    return
  }
  const store = openStoreReadOnly(ctx.dbPath)
  const handler = createLedgerMcpHttpHandler(store, ctx.token)
  await new Promise<void>((resolve, reject) => {
    createServer((req, res) => {
      void handler(req, res)
    }).listen(ctx.port, '127.0.0.1', () => resolve()).once('error', reject)
  })
}

async function main(): Promise<void> {
  // Safety: never boot as the app — this bundle only ever runs as the MCP
  // server. (In dev the main entry is separate; this guard is belt-and-suspenders.)
  if (process.argv.includes('--ledger-mcp-http')) {
    await serveHttp()
    return
  }
  if (!process.argv.includes('--ledger-mcp')) return

  let ctx: LedgerMcpContext
  try {
    ctx = readContext()
  } catch (err) {
    process.stderr.write(`watchtower-ledger: bad spawn context: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
    return
  }

  const store = openStoreReadOnly(ctx.dbPath)

  const server = createLedgerMcpServer(store)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // The transport closes when the agent closes stdin → the SDK closes the
  // server → no handles remain → the process exits naturally.
}

void main()
