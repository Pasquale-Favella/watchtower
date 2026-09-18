import { join } from 'node:path'
import pino, { type Logger } from 'pino'
import pretty from 'pino-pretty'
// @ts-expect-error pino-roll ships without bundled types; single-use import kept local
// so no ambient declaration file or web-tsconfig change is needed.
import buildRoll from 'pino-roll'

/**
 * Main-owned Operational log (spec #126, ADR 0029).
 *
 * Simple pino tactic: one JSON-lines file under `<userData>/logs`, owned
 * exclusively by main. Pino owns levels, JSON framing, ISO timestamps, and
 * redaction; a minimal field allowlist drops everything else before emission,
 * so prompts, paths, and ledger facts can never reach the file. The db-worker
 * thread (#128) and the ledger-MCP sidecar (#129) forward allowlisted records
 * to main over their existing channels (worker host events, sidecar stderr);
 * the sandboxed renderer (#130) forwards tripwire notices over IPC. Main
 * records everything through this module — nobody else touches the file.
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
  /** Test-only rotation overrides for the #131 quota test; production always
   * uses the defaults above. */
  size?: string | number
  count?: number
}

/** Emitting context for every record (spec #126 record shape). Forwarders
 * stamp their own; main paths use the default. */
export type LogContext = 'main' | 'worker' | 'sidecar' | 'renderer'

const LOG_CONTEXTS = new Set<string>(['main', 'worker', 'sidecar', 'renderer'])

/** Allowlisted short-string record fields: identifiers and codes only —
 * never prompts, bodies, paths, tokens, or ledger facts. Unknown keys never
 * reach pino. Values are trimmed and capped: forwarders pass identifiers, so
 * anything longer is a hostile shape, not data. */
const ALLOWED_STRING_FIELDS = new Set([
  'op',
  'code',
  'provider',
  'file',
  'method',
  'route',
  'kind',
  'label',
  'location',
  'model',
])

/** Allowlisted numeric record fields: finite counts only. */
const ALLOWED_COUNT_FIELDS = new Set(['count', 'ported', 'unparsed', 'failed'])

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

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
    size: opts.size ?? DEFAULT_ROLL_SIZE,
    limit: { count: opts.count ?? DEFAULT_ROLL_COUNT, removeOtherLogFiles: true },
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
  context: LogContext = 'main',
): void {
  if (!active) return
  const record: Record<string, unknown> = {
    context: LOG_CONTEXTS.has(context) ? context : 'main',
    event,
  }
  for (const key of ALLOWED_STRING_FIELDS) {
    const value = fields[key]
    if (typeof value === 'string') {
      const trimmed = value.trim()
      const safeValue = key === 'file' ? trimmed.split(/[\\/]/).pop() ?? '' : trimmed
      const capped = safeValue.slice(0, 200)
      if (capped) record[key] = capped
    }
  }
  for (const key of ALLOWED_COUNT_FIELDS) {
    const value = fields[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) record[key] = value
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
function emitSafe(level: LogLevel, event: string, fields: Record<string, unknown> = {}, context: LogContext = 'main'): void {
  try {
    logOperationalEvent(level, event, fields, context)
  } catch { /* logging must never break callers */ }
}

/** Never-throwing IPC failure record: operation name + code only. */
export function logIpcError(op: string, err: unknown): void {
  emitSafe('error', 'ipc.error', { op, code: logCodeFor(err) })
}

/** Never-throwing generic record for boot paths and forwarders. */
export function safeLogOperationalEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
  context: LogContext = 'main',
): void {
  emitSafe(level, event, fields, context)
}

export function closeOperationalLog(): void {
  if (!active) return
  try { active.stream.end() } catch { /* best effort */ }
  active = null
}
