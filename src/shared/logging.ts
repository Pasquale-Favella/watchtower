export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogContext = 'main' | 'worker' | 'sidecar' | 'renderer'

const LOG_CONTEXTS = new Set<string>(['main', 'worker', 'sidecar', 'renderer'])
const ALLOWED_STRING_FIELDS = [
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
] as const
const ALLOWED_COUNT_FIELDS = ['count', 'ported', 'unparsed', 'failed'] as const
/** Measurements are numbers too, but they are not tallies: `durationMs` is the
 * Effect span's millisecond duration (A7). It gets its own name rather than
 * riding `count` because `count` is a tally everywhere else in this file, and a
 * reader must never have to infer the unit. Same finite / non-negative rule. */
const ALLOWED_MEASURE_FIELDS = ['durationMs'] as const
const ALLOWED_NUMERIC_FIELDS = [...ALLOWED_COUNT_FIELDS, ...ALLOWED_MEASURE_FIELDS] as const

/** Effect span identity (A7). Hex only, up to 64 chars: Effect mints `traceId`
 * and `spanId` with `Encoding.randomHex` (32 and 16 lower-case hex characters,
 * verified against `effect/dist/Encoding.js:371`), so anything else under these
 * keys is not a span id. Deliberately NOT in `ALLOWED_STRING_FIELDS` — trim +
 * cap would accept a prompt; an external span with an opaque id simply loses
 * its link instead of widening the door. */
const ALLOWED_SPAN_ID_FIELDS = ['traceId', 'spanId', 'parentSpanId'] as const
const SPAN_ID_PATTERN = /^[0-9a-f]{1,64}$/

/**
 * Closed-vocabulary fields (#148, Wave 9 Slice E): allowlisted BY VALUE, not
 * by name. A counter dimension (`scan.duration` outcome, `fetch.timeout`
 * reason, `probe.outcome` status) can break down in the Operational log
 * without any free text reaching it — the only fileable values under these
 * keys are the constants below, and a value outside its set is dropped exactly
 * like a non-allowlisted field. No coercion, no trimming, no cap-then-keep:
 * the set is the whole allowlist, so `' success '` is as foreign as a prompt.
 *
 * Every set is transcribed from the emitting call site's own declared union
 * (the runtime enforcement point remains this sanitizer — every counter seam
 * takes a `Record<string, unknown>` field bag, so types cannot enforce it at
 * the boundary):
 * - `outcome` — `ScanDurationOutcome` in `src/main/pipeline/scan.ts`;
 *   `outcomeForScanExit` returns exactly `success | aborted | failed`.
 * - `status` — `ProbeResult['status']` in `src/main/agents/probe.ts`, i.e.
 *   `Exclude<ProbeStatus, 'pending'>`. `pending` is a not-yet-probed row state
 *   and never a settled probe, so it is deliberately NOT a member.
 * - `reason` — the `FETCH_TIMEOUT_COUNTER` field in
 *   `src/main/pipeline/fetch-utils.ts`, timeout-only (the `HttpFetchError`
 *   `abort`/`network` reasons are error values, never filed). That keeps every
 *   other `reason` in the app droppable, e.g. the free-text skills-dismiss
 *   reason in `src/main/store/ledger.ts`.
 *
 * `kind` deliberately stays in `ALLOWED_STRING_FIELDS` (free-form, 200-capped)
 * instead of joining this map: it is allowlisted by name today, so moving it
 * would silently change every harness record, and the harness registry owns
 * that list. The dimension that actually needs breaking down — the settled
 * probe `status` — is enumerated.
 *
 * The sets are hand-transcribed from the type unions above, so adding a union
 * member (say a fifth `ProbeStatus`) compiles, files nothing, and fails
 * SILENTLY — the fail-closed direction, and the same trade `ALLOWED_STRING_FIELDS`
 * already makes. A vocabulary test asserts each transcription against its union
 * so the drift shows up as a red test rather than a missing dimension.
 */
const ALLOWED_ENUM_FIELDS = {
  outcome: ['success', 'aborted', 'failed'],
  status: ['ready', 'warning', 'error', 'disabled'],
  reason: ['timeout'],
} as const

const ALLOWED_ENUM_VALUES: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(
  Object.entries(ALLOWED_ENUM_FIELDS).map(([key, values]) => [key, new Set<string>(values)] as const),
)

export function sanitizeOperationalRecord(
  event: string,
  fields: Record<string, unknown>,
  context: string,
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    context: LOG_CONTEXTS.has(context) ? context : 'main',
    event,
  }
  for (const key of ALLOWED_STRING_FIELDS) {
    const value = fields[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    const safeValue = key === 'file' ? (trimmed.split(/[\\/]/).pop() ?? '') : trimmed
    const capped = safeValue.slice(0, 200)
    if (capped) record[key] = capped
  }
  for (const key of ALLOWED_NUMERIC_FIELDS) {
    const value = fields[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) record[key] = value
  }
  // After the string rules so a future name collision can only tighten the
  // record: the id pattern is narrower than trim + cap.
  for (const key of ALLOWED_SPAN_ID_FIELDS) {
    const value = fields[key]
    if (typeof value === 'string' && SPAN_ID_PATTERN.test(value)) record[key] = value
  }
  // Last, so a future name collision between the lists can only tighten the
  // record: this loop writes vocabulary members or nothing.
  for (const [key, allowed] of Object.entries(ALLOWED_ENUM_VALUES)) {
    const value = fields[key]
    if (typeof value === 'string' && allowed.has(value)) record[key] = value
  }
  return record
}

export function errorCodeFor(err: unknown, fallback = 'failed'): string {
  // Single error-code policy for every context (#138 review): prefer the
  // errno `code` (EACCES, ENOENT, ...) when present — it is the most precise
  // stable identifier across main/worker/sidecar paths — then fall back to
  // the Error-name slug, then the caller fallback. Main and worker must log
  // the same failure with the same `code`.
  const errno = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined
  if (typeof errno === 'string' && errno.trim()) return errno.trim()
  if (err instanceof Error && err.name && err.name !== 'Error') {
    const slug = err.name
      .replace(/Error$/, '')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
    if (slug) return slug
  }
  return fallback
}

/** Kept for call-site compatibility: same unified policy as `errorCodeFor`. */
export function errnoCodeFor(err: unknown, fallback = 'failed'): string {
  return errorCodeFor(err, fallback)
}
