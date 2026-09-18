import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'

import type { AcpMcpServer } from '../harnesses/types.js'
import { bearerHeaderValue } from './auth.js'
import type { LedgerMcpSpawnContext } from './config.js'
import type { OperationalLogForwarder } from '../../../shared/operational-log.js'

/**
 * Main-side spawner for the loopback-HTTP `watchtower-ledger` MCP server:
 * the pooled sidecar for harnesses that reject client-provided stdio
 * servers (the Copilot CLI — `Rejecting non-http/sse MCP server ... from
 * client`). The app boots its own bundle as plain node on an ephemeral
 * 127.0.0.1 port and hands the agent an `http` server config; the agent
 * connects back over the loopback. Same read-only ledger, same tools — only
 * the transport differs from the agent-spawned stdio default.
 *
 * Lifetime is pooled at app scope (`pool.ts`): the pool reuses one sidecar
 * across Coach conversations and local MCP clients, releasing it on app quit
 * — per-run acquire/release stays a no-op so the runner's settle path is
 * unchanged.
 * Electron-free (child_process only) so the spawner stays testable.
 */

export interface StartedLedgerMcpHttp {
  server: AcpMcpServer
  release: () => void
  /** Single-attempt liveness probe — the pool gates sidecar reuse on it, so a
   *  sidecar that died between turns is respawned instead of handed out. */
  checkHealth: () => Promise<boolean>
}

/** Operational log forwarder injected by the composition root (main/index).
 * Defaults to a no-op so unit tests without a logger stay silent. */
export type SidecarLogFn = OperationalLogForwarder

// The structured stderr protocol (prefix, parser, sidecar-side reporter)
// lives in the shared seam so the sidecar bundle never imports this
// spawner (which needs `node:child_process`).
import { parseSidecarStderrLine } from '../../../shared/operational-log.js'

const READY_TIMEOUT_MS = 10_000
const READY_POLL_MS = 100
const READY_PREFIX = 'READY '
/** Preamble cap: the announcement is one short line — megabytes of stdout
 *  before it means the child is chatty-broken, not booting. */
const MAX_READY_BYTES = 64 * 1024

/** Parses the sidecar's single stdout announcement (`READY {"port": N}`).
 *  Anything else — wrong prefix, bad JSON, out-of-range port — is a boot
 *  failure, never something to connect to. */
export function parseReadyPort(line: string): number {
  if (!line.startsWith(READY_PREFIX)) throw new Error(`sidecar announced an unexpected ready line: ${line}`)
  const parsed = (JSON.parse(line.slice(READY_PREFIX.length)) as { port?: unknown }) ?? {}
  if (!Number.isInteger(parsed.port) || (parsed.port as number) < 1 || (parsed.port as number) > 65535) {
    throw new Error(`sidecar announced an invalid port: ${line}`)
  }
  return parsed.port as number
}

/** The bound port the sidecar reports itself — it binds port 0, so the
 *  parent never picks ports and there is no probe/bind race. Preamble lines
 *  (Node warnings, SDK banners) are skipped — only a `READY ...` line is
 *  parsed, strictly, so a corrupt announcement fails fast instead of burning
 *  the timeout. Rejects when the child exits first (its stderr stays piped,
 *  so the cause is visible in the main-process console) or when the line
 *  never arrives in time. Exported for unit tests (see ledger-mcp-pool). */
export function readReadyPort(child: ChildProcess, stdout: NodeJS.ReadableStream): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('ledger MCP HTTP server did not become ready'))
    }, READY_TIMEOUT_MS)
    const cleanup = (): void => {
      clearTimeout(timer)
      stdout.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString()
      if (buffer.length > MAX_READY_BYTES) {
        cleanup()
        reject(new Error('ledger MCP HTTP server announced too much before becoming ready'))
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith(READY_PREFIX)) {
          cleanup()
          try {
            resolve(parseReadyPort(line))
          } catch (err) {
            reject(err)
          }
          return
        }
        newline = buffer.indexOf('\n')
      }
    }
    const onExit = (code: number | null): void => {
      cleanup()
      reject(new Error(`ledger MCP HTTP server exited early (code ${code})`))
    }
    const onError = (err: Error): void => {
      cleanup()
      reject(err)
    }
    stdout.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

async function probeOnce(port: number, token: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: bearerHeaderValue(token) },
      signal: AbortSignal.timeout(2000),
    })
    return res.ok
  } catch {
    return false
  }
}

async function waitForHealth(port: number, token: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    if (await probeOnce(port, token)) return
    if (Date.now() >= deadline) throw new Error('ledger MCP HTTP server did not become ready')
    await new Promise(resolve => setTimeout(resolve, READY_POLL_MS))
  }
}

/** Minimal env for the sidecar: it serves telemetry over HTTP, so it never
 *  inherits the app's secrets — only what plain node needs plus its own
 *  spawn context. */
function sidecarEnv(httpCtx: { dbPath: string; token: string }): Record<string, string> {
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    WATCHTOWER_LEDGER_MCP: JSON.stringify(httpCtx),
  }
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

export async function startLedgerMcpHttp(
  ctx: LedgerMcpSpawnContext,
  deps: { onOperationalLog?: SidecarLogFn } = {},
): Promise<StartedLedgerMcpHttp> {
  const onLog = deps.onOperationalLog ?? (() => {})
  const token = randomUUID()
  const child: ChildProcess = spawn(ctx.execPath, [ctx.entryPath, '--ledger-mcp-http'], {
    env: sidecarEnv({ dbPath: ctx.dbPath, token }),
    // stdout carries the single READY line (consumed below, then drained);
    // stderr stays piped so a sidecar that fails to boot (bad bundle, locked
    // DB) leaves a trace in the Operational log instead of dying silently
    // behind a readiness timeout. Stdout is never written here.
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Line-buffered stderr forwarder (ticket #129): structured lines become
  // method-and-route-only records; anything else becomes a truncated note.
  // Chunk splits are reassembled — a JSON line split across two `data`
  // events still parses.
  let stderrBuffer = ''
  const forwardStderrLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed) return
    const parsed = parseSidecarStderrLine(trimmed)
    try {
      if (parsed) onLog(parsed.event, { method: parsed.method, route: parsed.route, code: parsed.code })
      else onLog('sidecar.stderr', { message: trimmed.slice(0, 500) })
    } catch { /* logging must never break the sidecar */ }
  };
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuffer += chunk.toString()
    let newline = stderrBuffer.indexOf('\n')
    while (newline >= 0) {
      forwardStderrLine(stderrBuffer.slice(0, newline))
      stderrBuffer = stderrBuffer.slice(newline + 1)
      newline = stderrBuffer.indexOf('\n')
    }
    if (stderrBuffer.length > 64 * 1024) {
      forwardStderrLine(stderrBuffer)
      stderrBuffer = ''
    }
  })
  if (!child.stdout) {
    child.kill()
    throw new Error('ledger MCP HTTP server has no stdout for its ready announcement')
  }
  const stdout = child.stdout
  const earlyExit = new Promise<never>((_resolve, reject) => {
    child.once('exit', code => reject(new Error(`ledger MCP HTTP server exited early (code ${code})`)))
  })
  let port: number
  try {
    // The child binds its own ephemeral port and announces it — no
    // parent-side probe, no bind race. The listen callback precedes the
    // announcement, so the confirming health check below passes first try on
    // a healthy boot; it only polls when something is genuinely wedged.
    port = await readReadyPort(child, stdout)
    stdout.resume()
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
      headers: [{ name: 'Authorization', value: bearerHeaderValue(token) }],
    },
    release: () => {
      child.kill()
    },
    checkHealth: () => probeOnce(port, token),
  }
}
