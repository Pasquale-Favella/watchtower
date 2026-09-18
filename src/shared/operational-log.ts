/**
 * The shared Operational log record seam (spec #126, ADR 0029).
 *
 * One place where every Operational log record is shaped: timestamp, level,
 * emitting context (main, worker, sidecar, renderer), event name, and
 * allowlisted fields only. Unknown or forbidden fields (prompts, message
 * bodies, file contents, bearer tokens, full absolute paths, request bodies,
 * ledger facts) are dropped before emission by construction — callers can
 * only pass the allowlisted input, and the builder basenames file paths and
 * truncates short strings.
 *
 * Electron-free and Node-free (no `node:` imports) so the main process, the
 * db-worker thread, the ledger-MCP sidecar bundle, and the sandboxed renderer
 * all share this exact shape.
 */

/** Where the record was emitted — never a file path, never a username. */
export type OperationalLogContext = 'main' | 'worker' | 'sidecar' | 'renderer'

export type OperationalLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Minimal event allowlist only — no per-file success chatter. */
export type OperationalLogEvent =
  | 'worker.ready'
  | 'worker.init-error'
  | 'scan.start'
  | 'scan.finish'
  | 'scan.abort'
  | 'file.error'
  | 'ipc.error'
  | 'sidecar.boot-error'
  | 'sidecar.health-failure'
  | 'sidecar.stderr'
  | 'ledger-mcp.request-error'
  | 'harness.start'
  | 'harness.finish'
  | 'harness.error'
  | 'updates.offline'
  | 'renderer.tripwire'

export interface OperationalLogPerProviderUnparsed {
  provider: string
  unparsed: number
}

/** Allowlisted input fields only. Everything else is rejected by construction. */
export interface OperationalLogFields {
  provider?: string
  /** Basename only — the builder strips any directory part. */
  file?: string
  /** Short machine code (`read-failed`, `offline`, …), never a message body. */
  code?: string
  /** IPC operation name (`overview:query`), never its arguments. */
  op?: string
  /** Ledger MCP method/route only, never bodies or tokens. */
  method?: string
  route?: string
  /** Harness registry key only, never prompts. */
  harnessKind?: string
  /** Renderer tripwire label/location only, never payload contents. */
  label?: string
  location?: string
  /** Short human note (truncated); never prompts, contents, or facts. */
  message?: string
  count?: number
  manual?: boolean
  unparsed?: OperationalLogPerProviderUnparsed[]
}

export interface OperationalLogRecord extends OperationalLogFields {
  timestamp: string
  level: OperationalLogLevel
  context: OperationalLogContext
  event: OperationalLogEvent
}

const MAX_SHORT = 64
const MAX_FILE = 128
const MAX_MESSAGE = 500

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

/** Basename without `node:path` so the sandboxed renderer can share this seam. */
export function operationalLogBasename(path: string): string {
  for (const part of path.split(/[/\\]+/).reverse()) {
    if (part.length > 0) return part
  }
  return path
}

function cleanShort(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return truncate(trimmed, max)
}

function cleanCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.floor(value)
}

/** Default level per event: offline checks are info notes, never errors. */
export function operationalLogLevelFor(event: OperationalLogEvent): OperationalLogLevel {
  switch (event) {
    case 'scan.start':
    case 'scan.finish':
    case 'worker.ready':
    case 'harness.start':
    case 'harness.finish':
    case 'updates.offline':
      return 'info'
    case 'renderer.tripwire':
    case 'sidecar.stderr':
      return 'warn'
    case 'scan.abort':
      return 'warn'
    default:
      return 'error'
  }
}

/**
 * Builds one Operational log record. Only allowlisted fields survive;
 * `file` is reduced to its basename; short strings are truncated.
 */
export function buildOperationalLogRecord(
  context: OperationalLogContext,
  event: OperationalLogEvent,
  fields: OperationalLogFields = {},
  opts: { level?: OperationalLogLevel; timestamp?: string } = {},
): OperationalLogRecord {
  const unparsed = Array.isArray(fields.unparsed)
    ? fields.unparsed
        .filter(
          (row): row is OperationalLogPerProviderUnparsed =>
            !!row && typeof row === 'object' &&
            typeof (row as { provider?: unknown }).provider === 'string' &&
            typeof (row as { unparsed?: unknown }).unparsed === 'number',
        )
        .map(row => ({
          provider: truncate(row.provider.trim(), MAX_SHORT),
          unparsed: Math.max(0, Math.floor(row.unparsed)),
        }))
        .filter(row => row.provider.length > 0)
    : undefined

  const record: OperationalLogRecord = {
    timestamp: opts.timestamp ?? new Date().toISOString(),
    level: opts.level ?? operationalLogLevelFor(event),
    context,
    event,
  }
  const provider = cleanShort(fields.provider, MAX_SHORT)
  if (provider) record.provider = provider
  if (typeof fields.file === 'string' && fields.file.trim()) {
    record.file = truncate(operationalLogBasename(fields.file.trim()), MAX_FILE)
  }
  const code = cleanShort(fields.code, MAX_SHORT)
  if (code) record.code = code
  const op = cleanShort(fields.op, MAX_SHORT)
  if (op) record.op = op
  const method = cleanShort(fields.method, MAX_SHORT)
  if (method) record.method = method
  const route = cleanShort(fields.route, MAX_SHORT)
  if (route) record.route = route
  const harnessKind = cleanShort(fields.harnessKind, MAX_SHORT)
  if (harnessKind) record.harnessKind = harnessKind
  const label = cleanShort(fields.label, MAX_SHORT)
  if (label) record.label = label
  const location = cleanShort(fields.location, MAX_SHORT)
  if (location) record.location = location
  if (typeof fields.message === 'string' && fields.message.trim()) {
    record.message = truncate(fields.message.trim(), MAX_MESSAGE)
  }
  const count = cleanCount(fields.count)
  if (count !== undefined) record.count = count
  if (typeof fields.manual === 'boolean') record.manual = fields.manual
  if (unparsed && unparsed.length > 0) record.unparsed = unparsed
  return record
}

/** Short error code for an unknown error — never the message body. Non-Error
 * values (including thrown strings, which can carry arbitrary content) map to
 * the fallback so message text can never become a code. */
export function operationalLogCodeFor(err: unknown, fallback = 'unknown'): string {
  if (err instanceof Error && err.name && err.name !== 'Error') {
    return truncate(err.name.replace(/Error$/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || fallback, MAX_SHORT)
  }
  return fallback
}

const RECORD_EVENTS: ReadonlySet<string> = new Set([
  'worker.ready',
  'worker.init-error',
  'scan.start',
  'scan.finish',
  'scan.abort',
  'file.error',
  'ipc.error',
  'sidecar.boot-error',
  'sidecar.health-failure',
  'sidecar.stderr',
  'ledger-mcp.request-error',
  'harness.start',
  'harness.finish',
  'harness.error',
  'updates.offline',
  'renderer.tripwire',
])

export function isOperationalLogRecord(raw: unknown): raw is OperationalLogRecord {
  if (!raw || typeof raw !== 'object') return false
  const msg = raw as Record<string, unknown>
  return (
    typeof msg['timestamp'] === 'string' &&
    typeof msg['level'] === 'string' &&
    (msg['context'] === 'main' || msg['context'] === 'worker' || msg['context'] === 'sidecar' || msg['context'] === 'renderer') &&
    typeof msg['event'] === 'string' &&
    RECORD_EVENTS.has(msg['event'] as string)
  )
}

/** Shared forwarder signature: one allowlisted record per call. Reused by the
 * sidecar pool, the Harness runner, and the update checker so the tuple never
 * drifts per call site. */
export type OperationalLogForwarder = (event: OperationalLogEvent, fields?: OperationalLogFields) => void

/** Structured stderr protocol (ticket #129): the sidecar process writes
 * allowlisted JSON lines with this prefix to stderr — never stdout, so the
 * single `READY {"port": N}` stdout announcement stays parseable under any
 * logging load. Main parses each line back into a record carrying method and
 * route only (no bodies, tokens, or ledger facts). Pure — no `node:` imports,
 * so every bundle (including the sidecar entry) can share it. */
export const SIDECAR_LOG_PREFIX = 'WATCHTOWER_LEDGER_LOG '

export interface ParsedSidecarLog {
  event: OperationalLogEvent
  method?: string
  route?: string
  code?: string
}

/** Parses one structured sidecar stderr line. Returns null for preamble and
 * plain-text lines (Node warnings, legacy prefixes) — those become truncated
 * `sidecar.stderr` notes at the call site, never parse failures. */
export function parseSidecarStderrLine(line: string): ParsedSidecarLog | null {
  if (!line.startsWith(SIDECAR_LOG_PREFIX)) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(line.slice(SIDECAR_LOG_PREFIX.length)) as Record<string, unknown>
  } catch {
    return null
  }
  if (parsed['event'] !== 'ledger-mcp.request-error') return null
  const out: ParsedSidecarLog = { event: 'ledger-mcp.request-error' }
  for (const key of ['method', 'route', 'code'] as const) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim()) {
      out[key] = value.trim().slice(0, MAX_SHORT)
    }
  }
  return out
}

/** Sidecar-side failure reporter (runs IN the sidecar process): one
 * allowlisted JSON line to stderr — method and route only. Never touches
 * stdout, so readiness stays parseable. Top-level `process` access only, so
 * importing this module never touches globals at load time. */
export function reportLedgerRequestFailure(method: string, route: string, code = 'internal'): void {
  try {
    process.stderr.write(
      `${SIDECAR_LOG_PREFIX}${JSON.stringify({ event: 'ledger-mcp.request-error', method, route, code })}\n`,
    )
  } catch { /* logging must never break serving */ }
}
