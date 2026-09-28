import pino from 'pino'

import { fileErrorCode } from '../../pipeline/file-errors.js'

const sidecarLogger = pino({ level: 'error', base: null }, pino.destination({ dest: 2, sync: true }))

function shortCode(code: unknown): string {
  return typeof code === 'string' && code.trim() ? code.trim() : 'failed'
}

function emitSidecarError(record: Record<string, unknown>): void {
  try {
    sidecarLogger.error(record)
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
