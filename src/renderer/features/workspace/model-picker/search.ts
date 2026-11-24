export interface SearchableRow {
  readonly id: string
  readonly label: string
}

/**
 * Ranks rows for a query of whitespace tokens. Every token must occur in the label or the id.
 * An exact label or id match comes first, then labels starting with the query; ties keep their order.
 * A blank query keeps every row in its declared order.
 */
export function rankModelRows<Row extends SearchableRow>(rows: readonly Row[], query: string): Row[] {
  const normalized = query.trim().toLowerCase()
  if (normalized === '') return [...rows]
  const tokens = normalized.split(/\s+/)
  return rows
    .map((row, index) => ({ row, index, label: row.label.toLowerCase(), id: row.id.toLowerCase() }))
    .filter(entry => tokens.every(token => entry.label.includes(token) || entry.id.includes(token)))
    .map(entry => ({ ...entry, rank: exactness(entry, normalized) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(entry => entry.row)
}

function exactness(entry: { readonly label: string; readonly id: string }, query: string): number {
  if (entry.label === query || entry.id === query) return 0
  return entry.label.startsWith(query) ? 1 : 2
}
