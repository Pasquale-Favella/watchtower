import type { DateRange } from '../pipeline/types.js'

const CANDIDATE_WINDOW_MS = 24 * 60 * 60 * 1000

/** SQLite's timestamp index selects likely sessions; full rows for those
 * composite identities are read afterwards to retain turn and spawn context. */
export function candidateTimestampBounds(range: DateRange): [string, string] {
  return [
    new Date(range.start.getTime() - CANDIDATE_WINDOW_MS).toISOString(),
    new Date(range.end.getTime() + CANDIDATE_WINDOW_MS).toISOString(),
  ]
}

/** Keep this predicate correlated on both identity columns: session ids are
 * not globally unique across providers or imported source files. */
export function selectScopedSessionRows(
  columns: readonly string[],
  table: 'ledger_session' | 'ledger_turn' | 'ledger_call',
): string {
  const projection = columns.map(column => `facts.${column}`).join(', ')
  return `
    WITH candidates AS MATERIALIZED (
      SELECT DISTINCT source_id, session_id
      FROM ledger_call
      WHERE timestamp >= ? AND timestamp <= ?
    )
    SELECT ${projection}, facts.rowid AS __rowid
    FROM candidates CROSS JOIN ${table} AS facts
    WHERE candidates.source_id = facts.source_id
      AND candidates.session_id = facts.session_id
  `
}
