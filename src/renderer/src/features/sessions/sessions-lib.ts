import { clampInt } from '../../../../shared/lib/clamp.js'
import { sortSessions } from '../../../../shared/lib/sessions-query.js'
import type { SessionGroup, SessionSort } from '../../../../shared/schemas/renderer.js'
import type { SessionRow } from './drilldown'
export type { SessionGroup, SessionSort }

/**
 * Renderer-side Sessions list helpers (#139 + #141 item 2). Search, sort,
 * summarize, and slicing live in `src/shared/lib/sessions-query.ts` and run
 * server-side — this module keeps only what renders from a page already
 * fetched: provider grouping over the mounted page slice and the pager slots.
 */

function totalTokens(row: SessionRow): number {
  return row.inputTokens + row.outputTokens
}

function endedAtMs(row: SessionRow): number {
  const ms = new Date(row.endedAt).getTime()
  return Number.isNaN(ms) ? 0 : ms
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

/** One virtual list entry (#141 item 3): a provider group header or a session
 * row. Keys are stable across pages and refreshes (provider / session id). */
export type SessionListItem =
  | { kind: 'header'; key: string; provider: string; count: number; cost: number }
  | { kind: 'row'; key: string; row: SessionRow }

/** Flattens one fetched page into a single virtual item list: group headers
 * stay in-flow as items (not sticky) with their rows following the header,
 * or plain rows when ungrouped. Exactly one of `groups`/`ungrouped` is
 * non-empty (the view computes one or the other); `grouped` picks which. */
export function flattenSessionListItems(
  groups: SessionGroup[],
  ungrouped: SessionRow[],
  grouped: boolean,
): SessionListItem[] {
  if (!grouped) return ungrouped.map(row => ({ kind: 'row', key: `row:${row.sessionId}`, row }))
  const out: SessionListItem[] = []
  for (const group of groups) {
    out.push({
      kind: 'header',
      key: `header:${group.provider}`,
      provider: group.provider,
      count: group.count,
      cost: group.cost,
    })
    for (const row of group.rows) out.push({ kind: 'row', key: `row:${row.sessionId}`, row })
  }
  return out
}

/** Fixed virtual-list geometry (#141 item 3): every row is exactly
 * `SESSION_ROW_HEIGHT` and every group header exactly
 * `SESSION_HEADER_HEIGHT` (the matching `h-16` / `h-8` classes live on the
 * row components in `SessionsView.tsx`). Fixed heights make virtual positions
 * pure arithmetic — no measuring, so rows can never overlap or drift. The
 * contract: row content must always fit its height (truncate, never grow).
 * Change the content height and these constants together. */
export const SESSION_ROW_HEIGHT = 64
export const SESSION_HEADER_HEIGHT = 32

/** The virtual height of one list item: headers and rows each have their
 * fixed height. */
export function sessionListItemHeight(item: SessionListItem): number {
  return item.kind === 'header' ? SESSION_HEADER_HEIGHT : SESSION_ROW_HEIGHT
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
