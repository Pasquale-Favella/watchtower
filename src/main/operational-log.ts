import { join } from 'node:path'
import pino, { type Logger } from 'pino'
import pretty from 'pino-pretty'
// @ts-expect-error pino-roll ships without bundled types; single-use import kept local
// so no ambient declaration file or web-tsconfig change is needed.
import buildRoll from 'pino-roll'

/**
 * Main-owned Operational log (spec #126 slice 1, ADR 0029).
 *
 * Simple pino tactic: one JSON-lines file under `<userData>/logs`, owned
 * exclusively by main. Pino owns levels, JSON framing, ISO timestamps, and
 * redaction; a minimal field allowlist drops everything else before emission,
 * so prompts, paths, and ledger facts can never reach the file. Worker /
 * sidecar / renderer forwarding (#128-#130) extends the allowlist with the
 * shared seam; this slice covers main boot + IPC failures only
 * (`op` + `code`).
 */

export const OPERATIONAL_LOG_FILE = 'operational.log'
const DEFAULT_ROLL_SIZE = '5m'
/** pino-roll `limit.count` keeps this many rotated files BESIDES the active
 * one (verified against the pino-roll source), so 2 + active at 5MB each is
 * ~15MB total — the lower bound of the spec's fifteen-to-twenty range and
 * ADR 0029's ~5MB x3. */
const DEFAULT_ROLL_COUNT = 2

export interface OperationalLogOptions {
  logDir: string
  isPackaged: boolean
}

/** Allowlisted record fields for the main-only slice: short values only,
 * set by the two producers below. Unknown keys never reach pino. */
const ALLOWED_FIELDS = new Set(['op', 'code'])

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface ActiveLog {
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>
  stream: { end(): void }
}

let active: ActiveLog | null = null

function loggerOptions(level: 'info' | 'debug'): Parameters<typeof pino>[0] {
  return {
    level,
    formatters: { level: (label: string): { level: string } => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: null,
    redact: {
      paths: [
        'prompt',
        '*.prompt',
        'token',
        '*.token',
        'authorization',
        '*.authorization',
        'headers',
        '*.headers',
        'body',
        '*.body',
        'requestBody',
        'fileContent',
        'fileContents',
      ],
      censor: '[Redacted]',
    },
  }
}

export async function initOperationalLog(opts: OperationalLogOptions): Promise<void> {
  const level = opts.isPackaged ? 'info' : 'debug'
  if (active) active.stream.end()
  const stream = await (buildRoll as (o: unknown) => Promise<{ end(): void } & NodeJS.WritableStream>)({
    file: join(opts.logDir, OPERATIONAL_LOG_FILE),
    size: DEFAULT_ROLL_SIZE,
    limit: { count: DEFAULT_ROLL_COUNT, removeOtherLogFiles: true },
    mkdir: true,
    sync: true,
  })
  const logger = (
    opts.isPackaged
      ? pino(loggerOptions(level), stream)
      : pino(
        loggerOptions(level),
        pino.multistream([
          { stream, level },
          { stream: pretty({ colorize: false, singleLine: true }), level: 'debug' },
        ]),
      )
  ) as ActiveLog['logger']
  active = { logger, stream }
}

export function logOperationalEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (!active) return
  const record: Record<string, unknown> = { context: 'main', event }
  for (const key of ALLOWED_FIELDS) {
    const value = fields[key]
    if (typeof value === 'string' && value.trim()) record[key] = value
  }
  active.logger[level](record)
}

/** Short machine code for an error — never the message body. */
export function logCodeFor(err: unknown, fallback = 'failed'): string {
  if (err instanceof Error && err.name && err.name !== 'Error') {
    const slug = err.name
      .replace(/Error$/, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
    return slug || fallback
  }
  return fallback
}

/** Never-throwing emit shared by the record helpers below. */
function emitSafe(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  try {
    logOperationalEvent(level, event, fields)
  } catch { /* logging must never break callers */ }
}

/** Never-throwing IPC failure record: operation name + code only. */
export function logIpcError(op: string, err: unknown): void {
  emitSafe('error', 'ipc.error', { op, code: logCodeFor(err) })
}

/** Never-throwing generic record for boot paths. */
export function safeLogOperationalEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  emitSafe(level, event, fields)
}

export function closeOperationalLog(): void {
  if (!active) return
  try { active.stream.end() } catch { /* best effort */ }
  active = null
}
