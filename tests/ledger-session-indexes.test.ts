import * as SqlClient from 'effect/sql/SqlClient'
import { describe, expect, it } from 'vitest'

import { initializeLedger } from '../src/main/store/ledger-initialization.js'
import { makeWorkerRuntime } from '../src/main/worker-runtime.js'

describe('ledger session detail indexes', () => {
  it('uses session indexes for detail rows and source lookup after upgrading version 1', async () => {
    const runtime = makeWorkerRuntime(':memory:')
    try {
      runtime.runSync(initializeLedger)
      const sql = runtime.runSync(SqlClient.SqlClient)
      runtime.runSync(sql.unsafe('DROP INDEX idx_ledger_session_session'))
      runtime.runSync(sql.unsafe('DROP INDEX idx_ledger_turn_session_turn'))
      runtime.runSync(sql.unsafe('DELETE FROM watchtower_sql_migrations WHERE migration_id = 2'))

      const explain = (query: string) =>
        runtime.runSync(sql.unsafe(`EXPLAIN QUERY PLAN ${query}`, ['target-session'])) as Array<{ detail: string }>
      const detailSessionPlan = explain(
        'SELECT source_id FROM ledger_session WHERE session_id = ? ORDER BY session_id ASC, rowid ASC',
      )
      const detailTurnPlan = explain(
        'SELECT source_id FROM ledger_turn WHERE session_id = ? ORDER BY session_id ASC, turn_index ASC, rowid ASC',
      )
      const sourceLookupPlan = explain(
        'SELECT id FROM ledger_source WHERE id IN (SELECT source_id FROM ledger_session WHERE session_id = ?) ORDER BY id ASC',
      )

      expect(detailSessionPlan.map(({ detail }) => detail).join(' ')).toMatch(/SCAN s|SCAN ledger_session/i)
      expect(detailTurnPlan.map(({ detail }) => detail).join(' ')).toMatch(/SCAN ledger_turn/i)
      expect(sourceLookupPlan.map(({ detail }) => detail).join(' ')).toMatch(/SCAN ledger_session/i)

      runtime.runSync(initializeLedger)

      const indexedDetailSessionPlan = explain(
        'SELECT source_id FROM ledger_session AS s WHERE session_id = ? ORDER BY session_id ASC, rowid ASC',
      )
      const indexedDetailTurnPlan = explain(
        'SELECT source_id FROM ledger_turn WHERE session_id = ? ORDER BY session_id ASC, turn_index ASC, rowid ASC',
      )
      const indexedSourceLookupPlan = explain(
        'SELECT id FROM ledger_source WHERE id IN (SELECT source_id FROM ledger_session WHERE session_id = ?) ORDER BY id ASC',
      )

      expect(indexedDetailSessionPlan.map(({ detail }) => detail).join(' ')).toMatch(
        /SEARCH s USING INDEX idx_ledger_session_session/i,
      )
      expect(indexedDetailTurnPlan.map(({ detail }) => detail).join(' ')).toMatch(
        /SEARCH ledger_turn USING INDEX idx_ledger_turn_session_turn/i,
      )
      expect(indexedSourceLookupPlan.map(({ detail }) => detail).join(' ')).toMatch(
        /SEARCH ledger_session USING INDEX idx_ledger_session_session/i,
      )
    } finally {
      await runtime.dispose()
    }
  })
})
