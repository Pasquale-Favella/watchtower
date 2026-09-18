import { join } from 'node:path'
import pino, { type Logger } from 'pino'
import pretty from 'pino-pretty'
import buildRoll from 'pino-roll'

import {
  buildOperationalLogRecord,
  type OperationalLogContext,
  type OperationalLogEvent,
  type OperationalLogFields,
  type OperationalLogLevel,
} from '../shared/operational-log.js'

/**
 * Main-owned Operational log file sink (spec #126, ADR 0029, ticket #127).
 *
 * One JSON-lines log family under `<userData>/logs`, owned exclusively by
 * the main process — worker/sidecar/renderer records are forwarded here, never
 * appended directly. The transport is pure pino power, no custom rotation:
 * pino-roll owns size rotation, retention (including pre-existing generations
 * in our dedicated log dir), and boot numbering; a multistream fans debug
 * output to a human-readable console mirror in development; level filtering,
 * string level names, and the trimmed line shape come from pino options.
 * Packaged builds write info level only; development writes debug. This module
 * only maps our seam onto those knobs.
 */

export const OPERATIONAL_LOG_FILE = 'operational.log'
const DEFAULT_ROLL_SIZE = '5m'
/** Rotated files kept besides the active one (~5MB x3 total per ADR 0029). */
const DEFAULT_ROLL_COUNT = 2

export interface OperationalLogOptions {
  logDir: string
  isPackaged: boolean
  /** pino-roll size (default '5m'): plain numbers are MB, 'k'/'m'/'g' suffixes. */
  size?: string | number
  /** pino-roll limit.count: rotated files kept besides the active one. */
  count?: number
}

interface ActiveLog {
  /** The four level methods only: plain and multistream loggers share them,
   * but differ in generics, so the seam depends on just what it calls. */
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>
  /** The open roll stream. Ended on re-init/close; the console mirror writes
   * to process stdout and is never closed by us. */
  stream: { end(): void }
}

let active: ActiveLog | null = null

/** One clean JSON line per record: string level, our ISO timestamp only. */
function loggerOptions(level: 'info' | 'debug'): Parameters<typeof pino>[0] {
  return {
    level,
    formatters: {
      level: (label: string): { level: string } => ({ level: label }),
    },
    // The seam's own ISO timestamp is the record's time; pid/hostname are
    // constants in this single-writer file — all three would be noise.
    timestamp: false,
    base: null,
  }
}

/** Boots (or re-boots) the singleton sink. Numbering continues across reboots
 * and retention applies to pre-existing generations (dedicated log dir). */
export async function initOperationalLog(opts: OperationalLogOptions): Promise<void> {
  const level = opts.isPackaged ? 'info' : 'debug'
  if (active) active.stream.end()
  const stream = await buildRoll({
    file: join(opts.logDir, OPERATIONAL_LOG_FILE),
    size: opts.size ?? DEFAULT_ROLL_SIZE,
    limit: { count: opts.count ?? DEFAULT_ROLL_COUNT, removeOtherLogFiles: true },
    mkdir: true,
    sync: true,
  })
  // Explicit per-stream levels: multistream streams without one default to
  // info and would silently drop debug lines from the file in development.
  const logger = opts.isPackaged
    ? pino(loggerOptions(level), stream)
    : pino(
      loggerOptions(level),
      pino.multistream([
        { stream, level },
        { stream: pretty({ colorize: false, singleLine: true }), level: 'debug' },
      ]),
    )
  active = { logger, stream }
}

/** Records one allowlisted record — the ONLY way main-path code emits. */
export function recordOperationalLog(
  context: OperationalLogContext,
  event: OperationalLogEvent,
  fields: OperationalLogFields = {},
  opts: { level?: OperationalLogLevel; timestamp?: string } = {},
): void {
  if (!active) return
  const record = buildOperationalLogRecord(context, event, fields, opts)
  const logger = active.logger
  switch (record.level) {
    case 'debug': logger.debug(record); break
    case 'info': logger.info(record); break
    case 'warn': logger.warn(record); break
    case 'error': logger.error(record); break
  }
}

/** Ends the sink (tests + quit path). Re-entrant. Sync writes are already
 * durable; rotation itself completes asynchronously inside pino-roll. */
export function closeOperationalLog(): void {
  if (!active) return
  try { active.stream.end() } catch { /* best effort */ }
  active = null
}

/** Never-throwing record for call sites where logging must not break the
 * surrounding path (IPC handlers, boot, quit). Collapses the repeated
 * try/catch guard into the seam itself. */
export function safeRecordOperationalLog(
  context: OperationalLogContext,
  event: OperationalLogEvent,
  fields: OperationalLogFields = {},
): void {
  try {
    recordOperationalLog(context, event, fields)
  } catch { /* logging must never break callers */ }
}
