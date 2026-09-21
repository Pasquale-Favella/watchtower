import type { SessionSort } from '../schemas/renderer.js'
import type { SessionRow } from '../schemas/views.js'
import { clampInt } from './clamp.js'

/**
 * Server-side sessions query (#139 scope 3, #141 item 2). Pure,
 * process-agnostic search/sort/slice over already-scoped `SessionRow[]`:
 * the main process runs this over its SQL range-bounded set so search, sort,
 * and paging execute server-side, and only one page plus totals crosses IPC.
 * The renderer drives it through the `sessions:page` channel and never holds
 * the full scoped set. Shared (not renderer-local) so both sides run the
 * identical semantics — one paging layer, not two.
 */

/** The four row orderings the Sessions list offers. */
const SESSION_SORTS = ['cost', 'recent', 'turns', 'tokens'] as const

function normalizeSort(sort: unknown): SessionSort {
  return (SESSION_SORTS as readonly string[]).includes(sort as string) ? (sort as SessionSort) : 'cost'
}

function normalizeSearch(query: unknown): string {
  return typeof query === 'string' ? query : ''
}

/** Search — case-insensitive match over
 * title, project, session id, and models. An empty/whitespace query passes
 * everything through. */
export function filterSessions(rows: SessionRow[], query: string): SessionRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  return rows.filter(row =>
    [row.title, row.project, row.sessionId, row.models.join(' ')].some(value => value.toLowerCase().includes(q)),
  )
}

function endedAtMs(row: SessionRow): number {
  const ms = new Date(row.endedAt).getTime()
  return Number.isNaN(ms) ? 0 : ms
}

function totalTokens(row: SessionRow): number {
  return row.inputTokens + row.outputTokens
}

/** The descending sort value for one row under the active sort. */
export function sessionSortValue(row: SessionRow, sort: SessionSort): number {
  if (sort === 'cost') return row.cost
  if (sort === 'turns') return row.turns
  if (sort === 'tokens') return totalTokens(row)
  return endedAtMs(row)
}

/** Returns a NEW array sorted by the active sort; the input rows are untouched.
 * Sort-value ties break by binary session id (SQLite byte order, not locale)
 * so the order is total: equal rows can never swap places between two
 * requests, which is what makes keyset cursors stable under refresh. */
export function sortSessions(rows: SessionRow[], sort: SessionSort): SessionRow[] {
  return [...rows].sort((a, b) => {
    const byValue = sessionSortValue(b, sort) - sessionSortValue(a, sort)
    if (byValue !== 0) return byValue
    if (a.sessionId < b.sessionId) return -1
    if (a.sessionId > b.sessionId) return 1
    return 0
  })
}

/** The summary line's raw numbers for the current filter: `N sessions · $cost
 * · tokens`. */
export function summarizeSessions(rows: SessionRow[]): { count: number; costUSD: number; tokens: number } {
  return {
    count: rows.length,
    costUSD: rows.reduce((sum, row) => sum + row.cost, 0),
    tokens: rows.reduce((sum, row) => sum + totalTokens(row), 0),
  }
}

/** A keyset position in a sorted row list: the sort, the last-seen sort
 * value, and the last-seen session id (the tiebreak). */
export interface SessionCursor {
  sort: SessionSort
  value: number
  sessionId: string
}

/** Opaque keyset token for `SessionQuery.cursor`: URI-encoded JSON (no
 * base64 — shared code runs in Node and in the sandboxed renderer, and both
 * have `encodeURIComponent`). Not a security boundary: the server re-parses
 * and re-validates every cursor, and garbage falls back to the offset path. */
export function encodeSessionCursor(cursor: SessionCursor): string {
  return encodeURIComponent(JSON.stringify(cursor))
}

/** Parses an opaque cursor back, or null for anything malformed. */
export function decodeSessionCursor(cursor: unknown): SessionCursor | null {
  if (typeof cursor !== 'string' || cursor === '') return null
  try {
    const raw = JSON.parse(decodeURIComponent(cursor)) as Partial<SessionCursor>
    if (raw === null || typeof raw !== 'object') return null
    if (!normalizeSortIsMember(raw.sort)) return null
    if (typeof raw.value !== 'number' || !Number.isFinite(raw.value)) return null
    if (typeof raw.sessionId !== 'string') return null
    return { sort: raw.sort, value: raw.value, sessionId: raw.sessionId }
  } catch {
    return null
  }
}

function normalizeSortIsMember(sort: unknown): sort is SessionSort {
  return (SESSION_SORTS as readonly string[]).includes(sort as string)
}

/** True when row sorts strictly after the cursor position under the cursor's
 * own sort (same value orders by session id past the cursor's id). */
function isAfterCursor(row: SessionRow, cursor: SessionCursor): boolean {
  const value = sessionSortValue(row, cursor.sort)
  if (value !== cursor.value) return value < cursor.value
  return row.sessionId > cursor.sessionId
}

/** Server-side page request (#141 item 2). Every field is optional and
 * garbage normalizes to the defaults instead of throwing (ADR 0008):
 * unknown shapes ride the same contract as the other view IPC. When both
 * `cursor` and `offset` are present, a valid cursor whose sort matches the
 * request sort wins (stable continuation); otherwise the offset applies. */
export interface SessionQuery {
  /** Free-text search over title/project/session-id/models. */
  query?: unknown
  /** One of cost/recent/turns/tokens; anything else becomes cost. */
  sort?: unknown
  /** Rows per page, clamped to [1, 500]. */
  limit?: unknown
  /** Zero-based start for random access (the numbered pager). */
  offset?: unknown
  /** Opaque keyset token from a previous `nextCursor` (prev/next walk). */
  cursor?: unknown
}

/** Upper bound for one page: keeps a single IPC payload small. */
export const SESSIONS_PAGE_MAX_LIMIT = 500

/** The default page size (the Sessions pager mounts at most this many rows,
 * virtualized to the visible window). */
export const SESSIONS_PAGE_SIZE = 100

/** One server-computed page: the rows that mount plus the filtered totals the
 * summary line and the pager render from — no other scoped rows cross IPC. */
export interface SessionPageResult {
  rows: SessionRow[]
  /** Filtered row count across all pages. */
  total: number
  /** Filtered summary-line numbers across all pages. */
  summary: { count: number; costUSD: number; tokens: number }
  /** The applied zero-based start (echoes a clamped offset). */
  start: number
  /** Keyset continuation for the next page, or null at the end. */
  nextCursor: string | null
}

/** Searches, sorts, and slices already-scoped rows into one page. Pure and
 * total: out-of-range offsets clamp to the last page (a background refresh
 * never strands the UI on an empty page), and every unknown shape normalizes
 * instead of throwing. */
export function querySessionPage(rows: SessionRow[], query: SessionQuery = {}): SessionPageResult {
  const sort = normalizeSort(query.sort)
  const limit = clampInt(query.limit, SESSIONS_PAGE_SIZE, 1, SESSIONS_PAGE_MAX_LIMIT)
  const sorted = sortSessions(filterSessions(rows, normalizeSearch(query.query)), sort)
  const total = sorted.length
  const summary = summarizeSessions(sorted)

  let start = clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER)
  const cursor = decodeSessionCursor(query.cursor)
  if (cursor !== null && cursor.sort === sort) {
    const at = sorted.findIndex(row => isAfterCursor(row, cursor))
    start = at === -1 ? total : at
  }
  if (total > 0 && start >= total) start = Math.max(0, total - limit)

  const pageRows = sorted.slice(start, start + limit)
  const last = pageRows[pageRows.length - 1]
  const nextCursor =
    last !== undefined && start + limit < total
      ? encodeSessionCursor({ sort, value: sessionSortValue(last, sort), sessionId: last.sessionId })
      : null
  return { rows: pageRows, total, summary, start, nextCursor }
}
