import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as EffectLogger from 'effect/Logger'
import type * as EffectLogLevel from 'effect/LogLevel'
import * as Option from 'effect/Option'
import * as References from 'effect/References'
import * as Tracer from 'effect/Tracer'

import { errorCodeFor, type LogContext, type LogLevel, sanitizeOperationalRecord } from '../shared/logging.js'

/**
 * Main-owned Operational log (spec #126, ADR 0029).
 *
 * One JSON-lines file under `<userData>/logs`, owned exclusively by main, and
 * one mechanism to write it: Effect's own `Logger` / `Tracer` feeding a
 * hand-written append-and-rotate writer in this module. There is no third-party
 * logging dependency and no second sink — the writer below owns JSON framing,
 * ISO timestamps, the level ceiling, rotation, and the allowlist; Effect owns
 * levels, annotations, and spans.
 *
 * `sanitizeOperationalRecord` (`src/shared/logging.ts`) is the SECURITY
 * BOUNDARY and is unchanged: a minimal field allowlist drops everything else
 * before a byte reaches the file, so prompts, paths, and ledger facts cannot
 * get out (ADR 0012). It is deliberately the ONLY thing between a call site and
 * the disk — the `pino` redact list this module used to configure named only
 * keys the allowlist had already dropped (`prompt`, `token`, `headers`, `body`,
 * `fileContent`, …), so it was unreachable and nothing is loosened by its
 * removal. The db-worker thread (#128) and the ledger-MCP sidecar (#129)
 * forward allowlisted records to main over their existing channels (worker host
 * events, sidecar stderr); the sandboxed renderer (#130) forwards tripwire
 * notices over IPC. Main records everything through this module — nobody else
 * touches the file.
 */

export const OPERATIONAL_LOG_FILE = 'operational.log'
const DEFAULT_ROLL_SIZE = '5m'
/** `count` keeps this many rotated files BESIDE the active one, so 2 + active at
 * 5MB each is ~15MB total — the lower bound of the spec's fifteen-to-twenty
 * range and ADR 0029's ~5MB x3. Same number pino-roll's `limit.count` held. */
const DEFAULT_ROLL_COUNT = 2
/** Rotated generation of the active file: `operational.log.1` is the newest,
 * `.2` the one before it, and anything beyond the quota is pruned on boot. */
const ROTATED_PATTERN = /^operational\.log\.(\d+)$/
/** Event name for an `Effect.log` that carries no `event` annotation — the
 * pre-existing name for "an Effect log with no opinion of its own". */
const DEFAULT_LOG_EVENT = 'effect.log'
/** Level order for the file-level ceiling (debug in dev, info in packaged). */
const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 }

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

/**
 * Size grammar, transcribed from the `pino-roll` `size` option it replaces
 * (`pino-roll/lib/utils.js:11`, `parseSize`) so the #131 quota test's
 * `size: '2k'` seam keeps its exact meaning: a bare number is MEGABYTES, and
 * only a `b` / `k` / `m` / `g` suffix picks the unit.
 */
function parseRollSize(size: string | number): number {
  if (typeof size === 'number') return size * 1024 * 1024
  const match = /^([\d.]+)(\w?)$/.exec(size)
  const value = match?.[1] === undefined ? Number.NaN : Number(match[1])
  const unit = match?.[2]?.toLowerCase()
  const multiplier = unit === 'g' ? 1024 ** 3 : unit === 'k' ? 1024 : unit === 'b' ? 1 : 1024 * 1024
  return value * multiplier
}

function rotationLimit(count: number | undefined): number {
  return count !== undefined && Number.isFinite(count) && count >= 1 ? Math.floor(count) : DEFAULT_ROLL_COUNT
}

/**
 * The whole file sink: an append-only JSON-lines file with a size ceiling and a
 * fixed number of rotated generations beside it. This is the single writer every
 * path in `src/main` reaches — the `Logger` below, the `Tracer` below, and the
 * Promise-seam callers that have no fiber to yield into. It is called
 * imperatively in that last case rather than through a second API: there is one
 * function, not one function plus a wrapper.
 *
 * Writes are synchronous and unbuffered, exactly as the previous
 * `pino` + `sonic-boom` (`sync: true`) pair was, because a reader polls the
 * file while the app is still running (`e2e/operational-log.spec.ts`) and a
 * buffered writer would show a stale file. `writeSync` appends whole lines, so
 * a record is either fully in the file or not in it at all — which is what
 * keeps every surviving line parseable across a rotation.
 *
 * NEVER THROWS, including before `initOperationalLog` has run (the `active`
 * guard on the caller), inside a fiber finalizer, and when the disk is unhappy.
 */
class OperationalLogWriter {
  private readonly dir: string
  private readonly file: string
  private readonly maxBytes: number
  private readonly keep: number
  private readonly minRank: number
  /** Dev-only console echo: the one thing `pino-pretty` was doing, reduced to
   * the transform it actually performed (colourise off, one line per record). */
  private readonly echo: boolean
  private fd: number | null = null
  private bytes = 0

  constructor(opts: OperationalLogOptions) {
    this.dir = opts.logDir
    this.file = join(opts.logDir, OPERATIONAL_LOG_FILE)
    const size = parseRollSize(opts.size ?? DEFAULT_ROLL_SIZE)
    this.maxBytes = Number.isFinite(size) && size > 0 ? size : parseRollSize(DEFAULT_ROLL_SIZE)
    this.keep = rotationLimit(opts.count)
    this.minRank = LEVEL_RANK[opts.isPackaged ? 'info' : 'debug']
    this.echo = !opts.isPackaged
    mkdirSync(this.dir, { recursive: true })
    this.prune()
    this.reopen()
  }

  write(level: LogLevel, event: string, fields: Record<string, unknown>, context: LogContext): void {
    try {
      if (LEVEL_RANK[level] < this.minRank) return
      const time = new Date().toISOString()
      const record = { time, level, ...sanitizeOperationalRecord(event, fields, context) }
      const line = `${JSON.stringify(record)}\n`
      const bytes = Buffer.byteLength(line)
      if (this.fd === null) this.reopen()
      // Checked BEFORE the append, so the active file never overshoots its
      // ceiling by more than the record that triggers the roll (and never
      // overshoots at all when the ceiling is larger than one record).
      if (this.fd === null) return
      if (this.bytes > 0 && this.bytes + bytes > this.maxBytes) this.rotate()
      writeSync(this.fd, line)
      this.bytes += bytes
      if (this.echo) process.stdout.write(`[${time.slice(11, 23)}] ${level.toUpperCase()}: ${line}`)
    } catch {
      /* a log must never break its caller, whatever the disk is doing */
    }
  }

  close(): void {
    if (this.fd === null) return
    try {
      closeSync(this.fd)
    } catch {
      /* best effort */
    }
    this.fd = null
  }

  /** Appends to the active file and adopts its current size, so a re-init in a
   * process that already wrote records does not restart the ceiling at zero. */
  private reopen(): void {
    const fd = openSync(this.file, 'a')
    this.fd = fd
    try {
      this.bytes = statSync(this.file).size
    } catch {
      this.bytes = 0
    }
  }

  /**
   * Shifts every generation down one slot and prunes past the quota.
   *
   * The descriptor is closed first because Windows refuses to rename an open
   * file; the next `write` reopens it. Every step is best-effort: a wedged
   * rename costs a file, never a record, and the next rotation retries the
   * whole shift.
   */
  private rotate(): void {
    this.close()
    this.bytes = 0
    try {
      for (let index = this.keep; index >= 1; index -= 1) {
        const from = index === 1 ? this.file : join(this.dir, `${OPERATIONAL_LOG_FILE}.${index - 1}`)
        const to = join(this.dir, `${OPERATIONAL_LOG_FILE}.${index}`)
        if (index === this.keep) rmSync(to, { force: true })
        if (existsSync(from)) renameSync(from, to)
      }
      this.prune()
    } catch {
      /* rotation is best-effort */
    }
  }

  /** Drops every generation past the quota. Run on boot and after each roll, so
   * a quota smaller than a previous run's cannot leave the directory growing
   * forever. */
  private prune(): void {
    for (const entry of readdirSync(this.dir)) {
      const match = ROTATED_PATTERN.exec(entry)
      if (match && Number(match[1]) > this.keep) rmSync(join(this.dir, entry), { force: true })
    }
  }
}

let active: OperationalLogWriter | null = null

/**
 * Opens (or re-opens) the Operational log. `async` because its callers await
 * it at boot; it never rejects — an unopenable log dir leaves logging inert
 * (`active` stays `null`, records are dropped) rather than failing a boot.
 */
export async function initOperationalLog(opts: OperationalLogOptions): Promise<void> {
  const previous = active
  active = null
  try {
    previous?.close()
  } catch {
    /* best effort */
  }
  try {
    active = new OperationalLogWriter(opts)
  } catch {
    /* logging must never break boot */
  }
}

/**
 * The one writer call. `void` and never throwing — see the class doc — so the
 * Promise seams in `index.ts` / `agents/ipc.ts` and the `readline` listener in
 * `sidecar.ts` can call it directly instead of manufacturing a runtime.
 */
export function logOperationalEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
  context: LogContext = 'main',
): void {
  const writer = active
  if (!writer) return
  writer.write(level, event, fields, context)
}

export const logCodeFor = errorCodeFor

/** Never-throwing emit shared by the record helpers below. */
function emitSafe(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
  context: LogContext = 'main',
): void {
  try {
    logOperationalEvent(level, event, fields, context)
  } catch {
    /* logging must never break callers */
  }
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
  const previous = active
  active = null
  try {
    previous?.close()
  } catch {
    /* best effort */
  }
}

/**
 * Injectable sink seam (Wave 2, issue #148 §4.4 + §5.4). The live layer
 * delegates to the writer above; tests substitute a fake via `layerWithSink`.
 *
 * This is NOT the logging API domain code uses — `Effect.log*` +
 * `Effect.annotateLogs` is (A12, replacing the `emitOperationalRecord` free
 * export this used to also provide). The service stays because it is a
 * substitutable dependency of the worker composition root and of the counter
 * seams that read it (`pipeline/scan.ts`, `agents/snapshot.ts`,
 * `pipeline/fetch-utils.ts`), and it adds no network exporter: OTLP would
 * duplicate truth, rotation, and the redaction audit and contradict the
 * local-first promise in ADR 0012.
 */

export interface OperationalLogSink {
  emit(level: LogLevel, event: string, fields: Record<string, unknown>, context: LogContext): void
}

/** Counter KEYS for the later call-site wiring slice (events, not values).
 * Each key files one record per increment through the allowlisted seam
 * (`count` field); no OTLP, no separate exporter. */
export const SCAN_DURATION_COUNTER = 'scan.duration' as const
export const FETCH_TIMEOUT_COUNTER = 'fetch.timeout' as const
export const PROBE_OUTCOME_COUNTER = 'probe.outcome' as const

export type OperationalLogCounter =
  typeof SCAN_DURATION_COUNTER | typeof FETCH_TIMEOUT_COUNTER | typeof PROBE_OUTCOME_COUNTER

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
      } catch {
        /* logging must never break callers */
      }
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

  const recordGauge = Effect.fnUntraced(function* (name: string, value: number, fields: Record<string, unknown> = {}) {
    yield* emitSafely('info', name, { ...fields, count: value }, 'main')
  })

  return { log, incrementCounter, recordGauge }
}

/** The live impl, built once and handed out by `OperationalLog.layer`. */
const liveOperationalLog = makeOperationalLogImpl({ emit: liveEmit })

/**
 * Main-owned operational log as an Effect service (`HttpFetch.layer` /
 * Wave-1 `HarnessProbe` shape). The live layer delegates to the writer; tests
 * substitute a fake via `layerWithSink`.
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
    readonly recordGauge: (name: string, value: number, fields?: Record<string, unknown>) => Effect.Effect<void>
  }
>()('watchtower/main/OperationalLog') {
  static readonly layer = Layer.succeed(OperationalLog, OperationalLog.of(liveOperationalLog))

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

/** Fiber log annotations, read the supported way: `Effect.annotateLogs` stores
 * its bag in the `CurrentLogAnnotations` reference (`References.d.ts:180`) and
 * the fiber's own `getRef` reads it without touching the caller's `R`
 * (`Effect.d.ts:18149`). Best-effort — an unreadable fiber costs the
 * annotations, never the record. */
function currentLogAnnotations(fiber: {
  getRef(reference: typeof References.CurrentLogAnnotations): unknown
}): Record<string, unknown> {
  try {
    const annotations = fiber.getRef(References.CurrentLogAnnotations)
    if (annotations && typeof annotations === 'object') return annotations as Record<string, unknown>
  } catch {
    /* annotations are best-effort */
  }
  return {}
}

function annotationString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * THE `Effect.log*` PATH: the one `Logger` that turns a runtime log event into
 * an Operational-log record.
 *
 * How fields reach it — `Effect.log` has no field bag (`Logger.Options` is
 * `{ message, logLevel, cause, fiber, date }`), so a call site spells its record
 * as an annotation:
 *
 * ```ts
 * yield* Effect.logError('sidecar.error').pipe(
 *   Effect.annotateLogs({ event: 'sidecar.error', context: 'sidecar', op: 'ledger-mcp-spawn', code: 'ENOENT' }),
 * )
 * ```
 *
 * `event` and `context` are not Effect concepts either, so they ride the same
 * bag and are pulled out here BEFORE sanitizing — they are the record's own two
 * columns, not annotation fields. Everything else in the bag passes through
 * `sanitizeOperationalRecord`, so an unvetted annotation is dropped exactly as
 * an unvetted positional argument would be; call sites must still never log
 * prompts, paths, or ledger facts.
 *
 * The rendered message is filed as `label` (capped at 200 chars by the
 * sanitizer) only when it carries prose BEYOND the event name, because an
 * operational record logs its own event name as its message — filing that too
 * would add a `label` field no record had before. An annotation `label` still
 * wins over the message, and a non-empty cause still files its `code` through
 * `errorCodeFor` (never the message). Spans are NOT this logger's business —
 * they are the `Tracer` half's (`OperationalLogTracerLayer` below), because a
 * span end is a different write at a different point in a fiber's life. Never
 * throws, including without `initOperationalLog`.
 */
export const OperationalLogLogger: EffectLogger.Logger<unknown, void> = EffectLogger.make(options => {
  try {
    const level = mapEffectLogLevel(options.logLevel)
    if (level === null) return
    const annotations = currentLogAnnotations(options.fiber)
    const event = annotationString(annotations['event']) ?? DEFAULT_LOG_EVENT
    const fields: Record<string, unknown> = {}
    const label = renderEffectMessage(options.message)
    if (label && label !== event) fields['label'] = label
    for (const [key, value] of Object.entries(annotations)) {
      if (key === 'event' || key === 'context') continue
      fields[key] = value
    }
    try {
      if (options.cause && options.cause.reasons.length > 0) {
        fields['code'] = errorCodeFor(Cause.squash(options.cause))
      }
    } catch {
      /* cause code is best-effort */
    }
    // `sanitizeOperationalRecord` is the validator for `context`: an
    // unrecognised annotation falls back to `main` there, exactly as it does
    // for the forwarder seams that stamp their own.
    const context = (annotationString(annotations['context']) ?? 'main') as LogContext
    logOperationalEvent(level, event, fields, context)
  } catch {
    /* logging must never break callers, including inside fibers */
  }
})

/** Installs `OperationalLogLogger`, replacing the default loggers so Effect
 * logs land only in the operational file (no console duplication). Lowers the
 * Effect minimum to `Debug` so debug records reach the sink in dev; the writer
 * stays the file-level enforcement point (info in packaged, debug in dev). */
export const OperationalLogLoggerLayer = EffectLogger.layer([OperationalLogLogger]).pipe(
  Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, 'Debug')),
)

/**
 * `Tracer` half of the bridge (A7). `OperationalLogLogger` above is the
 * `Effect.log` half; without a `Tracer` the reference resolves to
 * `Tracer.nativeTracer`, which builds a `NativeSpan` and drops it — so every
 * `Effect.fn('…')` in `src/main` was paying for a span nobody could read. This
 * is the missing half: one `debug` record per span END, carrying the name,
 * duration, kind and trace/span identity.
 *
 * Same writer, same rotation, same allowlist as the logger: records go through
 * `safeLogOperationalEvent`, so `sanitizeOperationalRecord` is the enforcement
 * point and span attributes — Effect-internal annotations, never vetted ledger
 * facts — are dropped unless they name an allowlisted key, exactly as at an
 * `Effect.log` call site. Never throws, including before
 * `initOperationalLog` and inside a fiber finalizer, and files at `debug` so
 * high-volume spans never compete with real events (the writer drops `debug` in
 * packaged builds, which is the intended ceiling).
 */
export const SPAN_EVENT = 'effect.span' as const

/** Effect's span clocks are bigint nanoseconds; the record carries
 * milliseconds at three decimals (microsecond precision), so a `debug` line
 * stays readable in a JSON-lines file. */
const NANOS_PER_MS = 1_000_000
const MS_DECIMALS = 3

function spanDurationMs(startTime: bigint, endTime: bigint): number {
  const nanos = Number(endTime - startTime)
  if (!Number.isFinite(nanos) || nanos <= 0) return 0
  return Number((nanos / NANOS_PER_MS).toFixed(MS_DECIMALS))
}

class OperationalLogSpan extends Tracer.NativeSpan {
  readonly logContext: LogContext

  constructor(options: ConstructorParameters<typeof Tracer.NativeSpan>[0], logContext: LogContext) {
    super(options)
    this.logContext = logContext
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    // A span END is the only write: no start line, because a start record per
    // span doubles the file volume and duration is the whole diagnostic. The
    // runtime ends a span exactly once (`endSpan` returns early when
    // `status._tag === 'Ended'`, `internal/effect.js:2734`), so the end record
    // IS the record.
    emitSpanEnd(this, endTime, exit)
    super.end(endTime, exit)
  }
}

function emitSpanEnd(span: OperationalLogSpan, endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
  try {
    const fields: Record<string, unknown> = {}
    // Attributes ride the same unvetted bag as the logger's log annotations —
    // the sanitizer decides, not this loop. The span's own identity is written
    // AFTER them so an attribute can never overwrite the name, ids or duration
    // of the record it rides on.
    for (const [key, value] of span.attributes) fields[key] = value
    fields['op'] = span.name
    fields['kind'] = span.kind
    fields['durationMs'] = spanDurationMs(span.startTime, endTime)
    fields['traceId'] = span.traceId
    fields['spanId'] = span.spanId
    const parent = Option.getOrUndefined(span.parent)
    if (parent) fields['parentSpanId'] = parent.spanId
    // The failure channel carries user and ledger data, so an `Exit` is NEVER
    // rendered: a failed span files the same `errorCodeFor` slug the Logger
    // files, and nothing else — no message, no squashed value. Guarded on its
    // own so an unreadable exit costs the `code`, never the whole record.
    try {
      if (Exit.isFailure(exit)) fields['code'] = errorCodeFor(Cause.squash(exit.cause))
    } catch {
      /* cause code is best-effort */
    }
    safeLogOperationalEvent('debug', SPAN_EVENT, fields, span.logContext)
  } catch {
    /* tracing must never break callers, including inside fibers */
  }
}

/** The writer-backed `Tracer` for one emitting isolate. `context` is the
 * `LogContext` its records are stamped with: `'worker'` for the db-worker
 * runtime, `'main'` for the main isolate. */
export const makeOperationalLogTracer = (context: LogContext): Tracer.Tracer =>
  Tracer.make({
    span: options => new OperationalLogSpan(options, context),
  })

/**
 * Installs the operational tracer as the `Tracer.Tracer` reference — the tracing
 * twin of `OperationalLogLoggerLayer`, and like it a Reference rather than a
 * `Context.Service`, so it adds nothing to `R` and the graph stays exactly the
 * services it declares. Install it in BOTH runtimes: worker-only would leave
 * the main isolate's spans dangling and merely relocate the problem.
 */
export const OperationalLogTracerLayer = (context: LogContext) =>
  Layer.succeed(Tracer.Tracer, makeOperationalLogTracer(context))
