import { clampInt } from '../../../../shared/lib/clamp.js'
import type { SessionGroup, SessionSort } from '../../../../shared/schemas/renderer.js'
import type { SessionRow } from './drilldown'
export type { SessionGroup, SessionSort }

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

/** Returns a NEW array sorted by the active sort; the input rows are untouched. */
export function sortSessions(rows: SessionRow[], sort: SessionSort): SessionRow[] {
  return [...rows].sort((a, b) => {
    if (sort === 'cost') return b.cost - a.cost
    if (sort === 'turns') return b.turns - a.turns
    if (sort === 'tokens') return totalTokens(b) - totalTokens(a)
    return endedAtMs(b) - endedAtMs(a)
  })
}

function groupSortValue(group: SessionGroup, sort: SessionSort): number {
  if (sort === 'cost') return group.rows.reduce((sum, row) => sum + row.cost, 0)
  if (sort === 'turns') return group.rows.reduce((sum, row) => sum + row.turns, 0)
  if (sort === 'tokens') return group.rows.reduce((sum, row) => sum + totalTokens(row), 0)
  return group.rows.reduce((latest, row) => Math.max(latest, endedAtMs(row)), 0)
}

/** Groups rows by provider, sorting each group by the active sort and ordering
 * the groups by their aggregate sort value (ties broken by provider name). */
export function groupSessionsByProvider(rows: SessionRow[], sort: SessionSort): SessionGroup[] {
  const byProvider = new Map<string, SessionRow[]>()
  for (const row of rows) {
    let list = byProvider.get(row.provider)
    if (list === undefined) {
      list = []
      byProvider.set(row.provider, list)
    }
    list.push(row)
  }
  return [...byProvider.entries()]
    .map(([provider, providerRows]) => ({
      provider,
      count: providerRows.length,
      cost: providerRows.reduce((sum, row) => sum + row.cost, 0),
      rows: sortSessions(providerRows, sort),
    }))
    .sort((a, b) => groupSortValue(b, sort) - groupSortValue(a, sort) || a.provider.localeCompare(b.provider))
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

/** One rendered page through the Sessions list (#139). The scoped fetch is
 * already range-bounded in SQL; this bounds what MOUNTS (at most one page of
 * rows) while search/sort/group stay global over the scoped set. A full
 * virtualizer (@tanstack/react-virtual, React 19 compatible) is the follow-up
 * if page sizes ever grow — at 100 rows a pager already keeps the DOM small
 * with no new dependency. */
export const SESSIONS_PAGE_SIZE = 100

export interface SessionsPage {
  /** The clamped zero-based page that actually renders. */
  page: number
  pageCount: number
  /** The slice that mounts — at most `pageSize` rows. */
  pageRows: SessionRow[]
}

/** Slices already-sorted rows into one page, clamping out-of-range pages
 * (scope reloads, narrowed searches) to the nearest valid page. */
export function paginateSessions(
  rows: SessionRow[],
  page: number,
  pageSize: number = SESSIONS_PAGE_SIZE,
): SessionsPage {
  const size = clampInt(pageSize, SESSIONS_PAGE_SIZE, 1, Number.MAX_SAFE_INTEGER)
  const pageCount = Math.max(1, Math.ceil(rows.length / size))
  const clamped = clampInt(page, 0, 0, pageCount - 1)
  return { page: clamped, pageCount, pageRows: rows.slice(clamped * size, clamped * size + size) }
}

/** One entry of the pager number row: a zero-based page or a gap marker. */
export type PageNumberEntry = number | 'ellipsis'

/** The numbered slots for the shadcn pager: every page when there are few,
 * otherwise the first page, a one-neighbour window around the current page,
 * and the last page, with `'ellipsis'` slots wherever pages are skipped. */
export function visiblePageNumbers(pageCount: number, currentPage: number): PageNumberEntry[] {
  const total = Number.isFinite(pageCount) ? Math.max(1, Math.floor(pageCount)) : 1
  const current = clampInt(currentPage, 0, 0, total - 1)
  if (total <= 7) return Array.from({ length: total }, (_, index) => index)
  const wanted = new Set([0, total - 1, current - 1, current, current + 1])
  const slots = [...wanted].filter(slot => slot >= 0 && slot < total).sort((a, b) => a - b)
  const entries: PageNumberEntry[] = []
  let previous = -1
  for (const slot of slots) {
    if (previous !== -1 && slot - previous > 1) entries.push('ellipsis')
    entries.push(slot)
    previous = slot
  }
  return entries
}
