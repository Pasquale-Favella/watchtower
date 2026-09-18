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

/** Minimal event allowlist only — no per-file success chatter. Single source
 * for the event union and the runtime guard below: add an event once here. */
const OPERATIONAL_LOG_EVENTS = [
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
] as const

export type OperationalLogEvent = typeof OPERATIONAL_LOG_EVENTS[number]

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

/** Type guard for per-provider unparsed tallies arriving in scan metadata. */
function isUnparsedRow(row: unknown): row is OperationalLogPerProviderUnparsed {
  if (!row || typeof row !== 'object') return false
  const candidate = row as { provider?: unknown; unparsed?: unknown }
  return typeof candidate.provider === 'string' && typeof candidate.unparsed === 'number'
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
        .filter(isUnparsedRow)
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
  for (const key of ['provider', 'code', 'op', 'method', 'route', 'harnessKind', 'label', 'location'] as const) {
    const value = cleanShort(fields[key], MAX_SHORT)
    if (value) record[key] = value
  }
  if (typeof fields.file === 'string' && fields.file.trim()) {
    record.file = truncate(operationalLogBasename(fields.file.trim()), MAX_FILE)
  }
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
    const slug = err.name
      .replace(/Error$/, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
    return truncate(slug || fallback, MAX_SHORT)
  }
  return fallback
}

/** Shared forwarder signature: one allowlisted record per call. Reused by the
 * sidecar pool, the Harness runner, and the update checker so the tuple never
 * drifts per call site. */
export type OperationalLogForwarder = (event: OperationalLogEvent, fields?: OperationalLogFields) => void

/** Parses one sidecar stderr line back out of the JSON pino writes there,
 * picking method and route only (no bodies, tokens, or ledger facts). Pure —
 * no `node:` imports, so every bundle (including the sidecar entry) shares
 * it. Preamble and plain-text lines (Node warnings) return null and become
 * truncated `sidecar.stderr` notes at the call site, never failures. */
export function parseSidecarStderrLine(line: string): OperationalLogFields | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const out: OperationalLogFields = {}
  for (const key of ['method', 'route', 'code'] as const) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim()) {
      out[key] = value.trim().slice(0, MAX_SHORT)
    }
  }
  if (out.method === undefined && out.route === undefined) return null
  return out
}
