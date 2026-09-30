import { writeSync } from 'node:fs'

import { fileErrorCode } from '../../pipeline/file-errors.js'

/**
 * Sidecar stderr protocol (#129): one JSON line per failure, on fd 2, nothing
 * else. The main process reads these lines back with `parseSidecarLogLine` and
 * stamps them `sidecar` — this process NEVER opens the Operational log
 * (ADR 0027: app-scoped, Electron-free), so the line protocol IS the transport.
 *
 * Hand-framed (`JSON.stringify` + `writeSync(2, …)`) rather than going through
 * a logger: the whole protocol is a record with three or four keys and a sync
 * write to fd 2, and a writer that cannot fail is what this stream needs.
 * Never throws — a failed report must not change sidecar behavior.
 */

function shortCode(code: unknown): string {
  return typeof code === 'string' && code.trim() ? code.trim() : 'failed'
}

function emitSidecarError(record: Record<string, unknown>): void {
  try {
    // `time`/`level` are for whoever tails the child's stderr by hand; the
    // parser ignores both and reads only the allowlisted keys below.
    writeSync(2, `${JSON.stringify({ level: 'error', time: new Date().toISOString(), ...record })}\n`)
  } catch {
    /* logging must never change sidecar behavior */
  }
}

export function reportSidecarBootFailure(code: unknown): void {
  emitSidecarError({ kind: 'boot', op: 'ledger-mcp-boot', code: shortCode(code) })
}

export function reportSidecarRequestFailure(method: string | undefined, route: string, err: unknown): void {
  emitSidecarError({
    kind: 'request',
    ...(method ? { method } : {}),
    ...(route ? { route } : {}),
    code: fileErrorCode(err, 'failed'),
  })
}
