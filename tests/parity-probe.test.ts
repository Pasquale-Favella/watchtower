import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { LedgerStore } from '../src/main/store/ledger.js'

// Scratch probe for map #88 / ticket #89: dumps what SQLite introspection
// actually returns for the exact green-field DDL. Throwaway with its branch.
describe('parity introspection probe (throwaway)', () => {
  it('dumps tables, columns, ddl text and indexes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tr-parity-probe-'))
    const store = new LedgerStore(join(dir, 'data.db'))
    store.close()

    const db = new DatabaseSync(join(dir, 'data.db'), { readOnly: true })
    try {
      const tables = (db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all() as Array<{ name: string }>).map(r => r.name)
      console.log('TABLES:' + JSON.stringify(tables))

      // table_info vs table_xinfo on the generated column (hidden columns)
      const infoCall = db.prepare('PRAGMA table_info("ledger_call")').all() as Array<{ name: string }>
      console.log('TABLE_INFO_NAMES ledger_call:' + JSON.stringify(infoCall.map(c => c.name)))
      const fkCall = db.prepare('PRAGMA foreign_key_list("ledger_call")').all()
      console.log('FK ledger_call:' + JSON.stringify(fkCall))

      for (const t of tables) {
        const cols = db.prepare(`PRAGMA table_xinfo("${t}")`).all()
        console.log(`XINFO ${t}:` + JSON.stringify(cols))
        const ddl = db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
          .get('table', t) as { sql: string }
        console.log(`DDL ${t}:` + ddl.sql)
        const idxList = db.prepare(`PRAGMA index_list("${t}")`).all()
        console.log(`INDEX_LIST ${t}:` + JSON.stringify(idxList))
        for (const ix of idxList as Array<{ name: string }>) {
          const ixInfo = db.prepare(`PRAGMA index_info("${ix.name}")`).all()
          console.log(`INDEX_INFO ${ix.name}:` + JSON.stringify(ixInfo))
        }
      }
    } finally {
      db.close()
    }
    expect(true).toBe(true)
  })
})
