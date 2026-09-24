import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'

import { logCodeFor, safeLogOperationalEvent } from '../../operational-log.js'
import type { AcpMcpServer } from '../harnesses/types.js'
import { bearerHeaderValue } from './auth.js'
import type { LedgerMcpSpawnContext } from './config.js'

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

const READY_TIMEOUT_MS = 10_000
const READY_POLL_MS = 100
const READY_PREFIX = 'READY '
const READY_TIMEOUT_MESSAGE = 'ledger MCP HTTP server did not become ready'

function earlyExitError(code: number | null): Error {
  return new Error(`ledger MCP HTTP server exited early (code ${code})`)
}
/** Single health-probe ceiling (was `AbortSignal.timeout(2000)` — now the
 *  Effect Clock governs it, so `TestClock` controls prod timeouts). */
const PROBE_TIMEOUT_MS = 2000
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

/** READY wait as a Clock-governed Effect (exported for `TestClock` tests):
 *  `Effect.callback` owns the stdout/exit/error listeners with a finalizer,
 *  so a timeout interruption removes them — no leaked listeners. The
 *  deadline rides `Effect.timeoutOption` (Clock, not `setTimeout`), mapping
 *  to the exact legacy timeout error.
 *  Removal: raw `setTimeout(READY_TIMEOUT_MS)` READY timer removed when the
 *  wait rides this Effect + Clock. */
export const readReadyPortEffect = Effect.fnUntraced(function* (child: ChildProcess, stdout: NodeJS.ReadableStream) {
  const waitForLine = Effect.callback<number, Error>(resume => {
    let buffer = ''
    const cleanup = (): void => {
      stdout.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString()
      if (buffer.length > MAX_READY_BYTES) {
        cleanup()
        resume(Effect.fail(new Error('ledger MCP HTTP server announced too much before becoming ready')))
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith(READY_PREFIX)) {
          cleanup()
          try {
            resume(Effect.succeed(parseReadyPort(line)))
          } catch (err) {
            resume(Effect.fail(err as Error))
          }
          return
        }
        newline = buffer.indexOf('\n')
      }
    }
    const onExit = (code: number | null): void => {
      cleanup()
      resume(Effect.fail(earlyExitError(code)))
    }
    const onError = (err: Error): void => {
      cleanup()
      resume(Effect.fail(err))
    }
    stdout.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
    return Effect.sync(() => cleanup())
  })

  const outcome = yield* waitForLine.pipe(Effect.timeoutOption(Duration.millis(READY_TIMEOUT_MS)))
  if (Option.isNone(outcome)) {
    return yield* Effect.fail(new Error(READY_TIMEOUT_MESSAGE))
  }
  return outcome.value
})

/** The bound port the sidecar reports itself — it binds port 0, so the
 *  parent never picks ports and there is no probe/bind race. Preamble lines
 *  (Node warnings, SDK banners) are skipped — only a `READY ...` line is
 *  parsed, strictly, so a corrupt announcement fails fast instead of burning
 *  the timeout. Rejects when the child exits first (its stderr stays piped,
 *  so the cause is visible in the main-process console) or when the line
 *  never arrives in time. Exported for unit tests (see ledger-mcp-pool).
 *  Promise seam kept — `run*` stays at this spawn-function boundary. */
export function readReadyPort(child: ChildProcess, stdout: NodeJS.ReadableStream): Promise<number> {
  return Effect.runPromise(readReadyPortEffect(child, stdout) as Effect.Effect<number, Error>)
}

/** One sidecar stderr record as parsed off the line protocol: method + route +
 * short code for failed requests, op + code for boot failures — never bodies
 * or tokens. */
export interface SidecarRequestRecord {
  kind: 'request' | 'boot'
  method?: string
  route?: string
  op?: string
  code: string
}

function shortField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** Parses one sidecar stderr line (#129 protocol). The sidecar emits a JSON
 * line per failed request (`{ kind: 'request', method, route, code }`) and
 * per boot failure (`{ kind: 'boot', op, code }`); anything else (Node
 * warnings, stacks) is dropped — stdout stays the exclusive READY channel
 * and only allowlisted fields reach the log. Pure (unit-tested). */
export function parseSidecarLogLine(line: string): SidecarRequestRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const fields = parsed as Record<string, unknown>
  const code = shortField(fields['code'])
  if (!code) return null
  const record: SidecarRequestRecord = { kind: fields['kind'] === 'boot' ? 'boot' : 'request', code }
  const method = shortField(fields['method'])
  if (method) record.method = method
  const route = shortField(fields['route'])
  if (route) record.route = route
  const op = shortField(fields['op'])
  if (op) record.op = op
  return record
}

/** Files one parsed stderr line via the shared seam (never throws). */
function recordSidecarLine(line: string): void {
  const parsed = parseSidecarLogLine(line)
  if (!parsed) return
  if (parsed.kind === 'boot') {
    safeLogOperationalEvent(
      'error',
      'sidecar.error',
      { op: parsed.op ?? 'ledger-mcp-boot', code: parsed.code },
      'sidecar',
    )
    return
  }
  safeLogOperationalEvent(
    'error',
    'sidecar.request',
    { method: parsed.method, route: parsed.route, code: parsed.code },
    'sidecar',
  )
}

/** Single health probe as a never-fails Effect (the `HttpFetch` timeout
 *  shape): fiber interruption aborts the underlying fetch via the
 *  `tryPromise` signal, and the ceiling rides `Effect.timeoutOption` (Clock)
 *  — no manual `AbortSignal` plumbing at call sites. `fetch` stays as-is
 *  (no `@effect/platform` — not installed); only the timeout moved to Clock.
 *  Removal: `AbortSignal.timeout(2000)` removed when the probe rides this
 *  Effect + Clock. */
const probeOnceEffect = Effect.fnUntraced(function* (port: number, token: string) {
  return yield* Effect.tryPromise({
    try: (signal: AbortSignal) =>
      fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: bearerHeaderValue(token) },
        signal,
      }).then(
        res => res.ok,
        () => false,
      ),
    catch: () => false,
  }).pipe(
    Effect.timeoutOption(Duration.millis(PROBE_TIMEOUT_MS)),
    Effect.map(outcome => Option.getOrElse(outcome, () => false)),
  )
})

async function probeOnce(port: number, token: string): Promise<boolean> {
  try {
    return await Effect.runPromise(probeOnceEffect(port, token))
  } catch {
    return false
  }
}

/** Confirming health poll as a Clock-governed Effect (exported for tests):
 *  `Schedule.spaced` paces retries, `timeoutOption` bounds the whole poll —
 *  same `READY_TIMEOUT_MS` deadline and exact legacy timeout error as before.
 *  Removal: `Date.now()` deadline + `setTimeout(READY_POLL_MS)` poll loop
 *  removed when the poll rides this Schedule + Clock. */
export const waitForHealthEffect = Effect.fnUntraced(function* (port: number, token: string) {
  const healthyOrFail = Effect.filterOrFail(
    probeOnceEffect(port, token),
    (healthy): healthy is true => healthy,
    () => new Error(READY_TIMEOUT_MESSAGE),
  )
  const outcome = yield* healthyOrFail.pipe(
    Effect.retry(Schedule.spaced(Duration.millis(READY_POLL_MS))),
    Effect.timeoutOption(Duration.millis(READY_TIMEOUT_MS)),
  )
  if (Option.isNone(outcome)) {
    return yield* Effect.fail(new Error(READY_TIMEOUT_MESSAGE))
  }
})

/** Early-exit as an Effect for the boot race: fails when the child exits
 *  before health confirms (same exact error as the legacy `earlyExit`
 *  Promise — exit code only, no stderr detail). Listeners are
 *  finalizer-owned, so the losing side of the race is cleaned up. */
const earlyExitEffect = (child: ChildProcess): Effect.Effect<never, Error> =>
  Effect.callback<never, Error>(resume => {
    const cleanup = (): void => {
      child.off('exit', onExit)
    }
    const onExit = (code: number | null): void => {
      cleanup()
      resume(Effect.fail(earlyExitError(code)))
    }
    child.once('exit', onExit)
    return Effect.sync(() => cleanup())
  })

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

export async function startLedgerMcpHttp(ctx: LedgerMcpSpawnContext): Promise<StartedLedgerMcpHttp> {
  const token = randomUUID()
  const child: ChildProcess = spawn(ctx.execPath, [ctx.entryPath, '--ledger-mcp-http'], {
    env: sidecarEnv({ dbPath: ctx.dbPath, token }),
    // stdout carries the single READY line (consumed below, then drained);
    // stderr carries one JSON record per failed request (read line-wise
    // above) — never the READY announcement, never request bodies or tokens.
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (child.stderr) {
    createInterface({ input: child.stderr }).on('line', recordSidecarLine)
  }
  if (!child.stdout) {
    child.kill()
    throw new Error('ledger MCP HTTP server has no stdout for its ready announcement')
  }
  const stdout = child.stdout
  let port: number
  try {
    // The child binds its own ephemeral port and announces it — no
    // parent-side probe, no bind race. The listen callback precedes the
    // announcement, so the confirming health check below passes first try on
    // a healthy boot; it only polls when something is genuinely wedged.
    // Boot race rides `Effect.raceFirst` (the `Promise.race` semantics:
    // first settle — success OR failure — wins, so an early exit fails fast
    // instead of burning the health timeout; `Effect.race` would ignore the
    // fast failure and hang). Removal: `Promise.race([waitForHealth,
    // earlyExit])` removed when boot rides this Effect race + Clock.
    port = await Effect.runPromise(readReadyPortEffect(child, stdout) as Effect.Effect<number, Error>)
    stdout.resume()
    await Effect.runPromise(Effect.raceFirst(waitForHealthEffect(port, token), earlyExitEffect(child)))
  } catch (err) {
    child.kill()
    safeLogOperationalEvent('error', 'sidecar.error', { op: 'ledger-mcp-spawn', code: logCodeFor(err) }, 'sidecar')
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
