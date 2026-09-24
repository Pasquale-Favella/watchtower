import { join } from 'node:path'
import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as EffectLogger from 'effect/Logger'
import type * as EffectLogLevel from 'effect/LogLevel'
import * as Layer from 'effect/Layer'
import * as References from 'effect/References'
import pino, { type Logger } from 'pino'
import pretty from 'pino-pretty'
import { errorCodeFor, sanitizeOperationalRecord, type LogContext, type LogLevel } from '../shared/logging.js'
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
export type { LogContext, LogLevel } from '../shared/logging.js'

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
  active.logger[level](sanitizeOperationalRecord(event, fields, context))
}

export const logCodeFor = errorCodeFor

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

/**
 * Effect bridge over the main-owned pino sink (Wave 2, issue #148 §4.4 + §5.4).
 *
 * The module-level `active` singleton above stays the sole sink owner: one
 * file (`OPERATIONAL_LOG_FILE`), one rotation policy, one allowlist
 * (`sanitizeOperationalRecord`) plus pino redaction. `OperationalLog` is a
 * thin Effect facade that delegates every emit to the active logger through
 * `safeLogOperationalEvent` — never a second sink, never a network exporter
 * (locked per §5.4: OTLP would duplicate truth, rotation, and the redaction
 * audit and contradict the local-first promise in ADR 0012).
 *
 * Call-site wiring (scan/fetch/probe) is a later slice: this module only
 * defines the service shape, the `Logger` bridge, and the counter KEYS.
 */

export interface OperationalLogSink {
  emit(level: LogLevel, event: string, fields: Record<string, unknown>, context: LogContext): void
}

/** Counter KEYS for the later call-site wiring slice (events, not values).
 * Each key files one pino record per increment through the allowlisted seam
 * (`count` field); no OTLP, no separate exporter. */
export const SCAN_DURATION_COUNTER = 'scan.duration' as const
export const FETCH_TIMEOUT_COUNTER = 'fetch.timeout' as const
export const PROBE_OUTCOME_COUNTER = 'probe.outcome' as const

export type OperationalLogCounter =
  | typeof SCAN_DURATION_COUNTER
  | typeof FETCH_TIMEOUT_COUNTER
  | typeof PROBE_OUTCOME_COUNTER

function liveEmit(level: LogLevel, event: string, fields: Record<string, unknown>, context: LogContext): void {
  safeLogOperationalEvent(level, event, fields, context)
}

function makeOperationalLogImpl(sink: OperationalLogSink) {
  const emitSafely = (
    level: LogLevel,
    event: string,
    fields: Record<string, unknown>,
    context: LogContext,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      try {
        sink.emit(level, event, fields, context)
      } catch { /* logging must never break callers */ }
    })

  const log = Effect.fnUntraced(function* (
    level: LogLevel,
    event: string,
    fields: Record<string, unknown> = {},
    context: LogContext = 'main',
  ) {
    yield* emitSafely(level, event, fields, context)
  })

  const incrementCounter = Effect.fnUntraced(function* (
    name: OperationalLogCounter,
    amount = 1,
    fields: Record<string, unknown> = {},
  ) {
    yield* emitSafely('info', name, { ...fields, count: amount }, 'main')
  })

  const recordGauge = Effect.fnUntraced(function* (
    name: string,
    value: number,
    fields: Record<string, unknown> = {},
  ) {
    yield* emitSafely('info', name, { ...fields, count: value }, 'main')
  })

  return { log, incrementCounter, recordGauge }
}

/**
 * Main-owned operational log as an Effect service (`HttpFetch.layer` /
 * Wave-1 `HarnessProbe` shape). The live layer delegates to the `active`
 * singleton; tests substitute a fake via `layerWithSink`.
 */
export class OperationalLog extends Context.Service<
  OperationalLog,
  {
    readonly log: (
      level: LogLevel,
      event: string,
      fields?: Record<string, unknown>,
      context?: LogContext,
    ) => Effect.Effect<void>
    readonly incrementCounter: (
      name: OperationalLogCounter,
      amount?: number,
      fields?: Record<string, unknown>,
    ) => Effect.Effect<void>
    readonly recordGauge: (
      name: string,
      value: number,
      fields?: Record<string, unknown>,
    ) => Effect.Effect<void>
  }
>()('watchtower/main/OperationalLog') {
  static readonly layer = Layer.succeed(
    OperationalLog,
    OperationalLog.of(makeOperationalLogImpl({ emit: liveEmit })),
  )

  static readonly layerWithSink = (sink: OperationalLogSink): Layer.Layer<OperationalLog> =>
    Layer.succeed(OperationalLog, OperationalLog.of(makeOperationalLogImpl(sink)))
}

export type OperationalLogService = OperationalLog['Service']

function mapEffectLogLevel(level: EffectLogLevel.LogLevel): LogLevel | null {
  switch (level) {
    case 'Fatal':
    case 'Error':
      return 'error'
    case 'Warn':
      return 'warn'
    case 'Info':
      return 'info'
    case 'Debug':
    case 'Trace':
    case 'All':
      return 'debug'
    case 'None':
      return null
    default:
      return 'info'
  }
}

function renderEffectMessage(message: unknown): string {
  try {
    const parts = Array.isArray(message) ? message : [message]
    return parts
      .map(part => {
        if (typeof part === 'string') return part
        if (typeof part === 'number' || typeof part === 'boolean' || typeof part === 'bigint') return String(part)
        if (part === null || part === undefined) return ''
        try {
          const json = JSON.stringify(part)
          return typeof json === 'string' ? json : String(part)
        } catch {
          return String(part)
        }
      })
      .join(' ')
      .trim()
  } catch {
    return ''
  }
}

/**
 * `Logger` that forwards `Effect.log` records into the pino sink through the
 * allowlisted seam. The rendered message is filed as `label` (capped at 200
 * chars by the sanitizer — call sites must still never log prompts, paths, or
 * ledger facts, same contract as direct pino calls); fiber annotations pass
 * through `sanitizeOperationalRecord` so only allowlisted keys survive; a
 * non-empty cause files its `code` only via `errorCodeFor` (never the
 * message). Spans are intentionally ignored here — span enrichment is a
 * follow-up. Never throws, including without `initOperationalLog`
 * (mirrors `if (!active) return`).
 */
export const OperationalLogLogger: EffectLogger.Logger<unknown, void> = EffectLogger.make(options => {
  try {
    const level = mapEffectLogLevel(options.logLevel)
    if (level === null) return
    const fields: Record<string, unknown> = {}
    const label = renderEffectMessage(options.message)
    if (label) fields['label'] = label
    try {
      const annotations = options.fiber.getRef(References.CurrentLogAnnotations) as Record<string, unknown>
      if (annotations && typeof annotations === 'object') {
        for (const [key, value] of Object.entries(annotations)) fields[key] = value
      }
    } catch { /* annotations are best-effort */ }
    try {
      if (options.cause && options.cause.reasons.length > 0) {
        fields['code'] = errorCodeFor(Cause.squash(options.cause))
      }
    } catch { /* cause code is best-effort */ }
    safeLogOperationalEvent(level, 'effect.log', fields)
  } catch { /* logging must never break callers, including inside fibers */ }
})

/** Installs `OperationalLogLogger`, replacing the default loggers so Effect
 * logs land only in the operational file (no console duplication). Lowers the
 * Effect minimum to `Debug` so debug records reach the sink in dev; pino
 * stays the file-level enforcement point (info in packaged, debug in dev). */
export const OperationalLogLoggerLayer = EffectLogger.layer([OperationalLogLogger]).pipe(
  Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, 'Debug')),
)
