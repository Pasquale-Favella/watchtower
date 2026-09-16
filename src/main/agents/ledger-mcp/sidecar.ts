import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'

import type { AcpMcpServer } from '../harnesses/types.js'

/**
 * Main-side spawner for the loopback-HTTP `watchtower-ledger` MCP server:
 * the per-run sidecar for harnesses that reject client-provided stdio
 * servers (the Copilot CLI — `Rejecting non-http/sse MCP server ... from
 * client`). The app boots its own bundle as plain node on an ephemeral
 * 127.0.0.1 port and hands the agent an `http` server config; the agent
 * connects back over the loopback. Same read-only ledger, same tools — only
 * the transport differs from the agent-spawned stdio default.
 *
 * Lifetime is per-run: the caller releases when the run's stream settles
 * (end, error, or cancel), so no sidecar outlives its conversation turn.
 * Electron-free (child_process + net only) so the runner stays testable.
 */

export interface LedgerMcpHttpSpawnContext {
  /** `process.execPath` — the Electron/watchtower binary. */
  execPath: string
  /** Absolute path to the bundled entry (`<appPath>/out/main/ledger-mcp.js`). */
  entryPath: string
  /** The app ledger DB (`<userData>/ledger.db`). */
  dbPath: string
}

export interface StartedLedgerMcpHttp {
  server: AcpMcpServer
  release: () => void
}

const READY_TIMEOUT_MS = 10_000
const READY_POLL_MS = 100

/** A free loopback port, picked by binding port 0. Tiny inherent race until
 *  the sidecar binds it — localhost-only, and a miss degrades to a
 *  no-tools run, never a wrong-tools one. */
function pickLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

async function waitForHealth(port: number, token: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) return
    } catch {
      // Not up yet — poll until the deadline.
    }
    if (Date.now() >= deadline) throw new Error('ledger MCP HTTP server did not become ready')
    await new Promise(resolve => setTimeout(resolve, READY_POLL_MS))
  }
}

/** Minimal env for the sidecar: it serves telemetry over HTTP, so it never
 *  inherits the app's secrets — only what plain node needs plus its own
 *  spawn context. */
function sidecarEnv(dbPath: string, port: number, token: string): Record<string, string> {
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    WATCHTOWER_LEDGER_MCP: JSON.stringify({ dbPath, port, token }),
  }
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

export async function startLedgerMcpHttp(ctx: LedgerMcpHttpSpawnContext): Promise<StartedLedgerMcpHttp> {
  const token = randomUUID()
  const port = await pickLoopbackPort()
  const child: ChildProcess = spawn(ctx.execPath, [ctx.entryPath, '--ledger-mcp-http'], {
    env: sidecarEnv(ctx.dbPath, port, token),
    // stdin/stdout unused in HTTP mode; stderr stays piped so a sidecar that
    // fails to boot (bad bundle, locked DB) leaves a trace in the main-process
    // console instead of dying silently behind a readiness timeout.
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`watchtower-ledger(http): ${chunk.toString()}`)
  })
  const earlyExit = new Promise<never>((_resolve, reject) => {
    child.once('exit', code => reject(new Error(`ledger MCP HTTP server exited early (code ${code})`)))
  })
  try {
    await Promise.race([waitForHealth(port, token), earlyExit])
  } catch (err) {
    child.kill()
    throw err
  }
  return {
    server: {
      type: 'http',
      name: 'watchtower-ledger',
      url: `http://127.0.0.1:${port}/mcp`,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    },
    release: () => {
      child.kill()
    },
  }
}
