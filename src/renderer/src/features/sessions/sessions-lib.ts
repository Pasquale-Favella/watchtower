import type { SessionRow } from './drilldown'

import type { SessionGroup, SessionSort } from '../../../../shared/schemas/renderer.js'
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
    const list = byProvider.get(row.provider) ?? []
    list.push(row)
    byProvider.set(row.provider, list)
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
