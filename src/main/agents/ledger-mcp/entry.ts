import { createServer } from 'node:http'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { LedgerStore } from '../../store/ledger.js'
import { createLedgerMcpHttpHandler } from './http-server.js'
import { createLedgerMcpServer } from './server.js'
import { readContext, readHttpContext, type LedgerMcpContext, type LedgerMcpHttpContext } from './spawn-env.js'

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

function openStoreReadOnly(dbPath: string): LedgerStore {
  try {
    return new LedgerStore(dbPath, { readOnly: true })
  } catch (err) {
    process.stderr.write(`watchtower-ledger: cannot open ledger read-only: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}

/** The parent is the only thing that should ever outlive this process: if
 *  the main process dies without killing its sidecar (a crash between spawn
 *  and release), exit instead of lingering on a loopback port holding a
 *  read-only DB handle. `kill(pid, 0)` only tests existence — ESRCH means the
 *  parent is gone (reparenting aside, the handle is useless anyway); any
 *  other outcome, including EPERM, means it is alive. */
function watchParentLiveness(): void {
  const parentPid = process.ppid
  if (!parentPid) return
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') process.exit(0)
    }
  }, 5_000)
  timer.unref()
}

/** Loopback-HTTP mode (`--ledger-mcp-http`): the same ledger over
 *  StreamableHTTP for harnesses that reject client-provided stdio servers.
 *  Binds port 0 itself and reports the bound port on stdout (`READY
 *  {"port": N}`) — the spawner never picks ports, so there is no probe and
 *  no bind race. Every route needs the per-spawn bearer token. The process
 *  lives until the spawner's pool releases it (app quit), or
 *  until its parent dies — whichever comes first. */
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
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer((req, res) => {
      void handler(req, res)
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address) resolve(address.port)
      else reject(new Error('no loopback address'))
    })
  })
  process.stdout.write(`READY ${JSON.stringify({ port })}\n`)
  watchParentLiveness()
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
