import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

const { extractReadSql } = createRequire(import.meta.url)('../scripts/query-sql-source.cjs') as {
  extractReadSql(source: string, name: string): string
}

describe('measurement SQL extraction', () => {
  it('resolves the measured SQL constant instead of a later unrelated template', () => {
    const source = [
      'const SELECT_SOURCES = `SELECT id FROM ledger_source`',
      "const read = Effect.fn('LedgerQueries.getSources')(function* () {",
      '  return yield* sql.unsafe(SELECT_SOURCES)',
      '})',
      "const remove = Effect.fn('LedgerIngest.deleteSource')(function* () {",
      '  return yield* sql`DELETE FROM ledger_source`',
      '})',
    ].join('\n')
    expect(extractReadSql(source, 'getSources')).toBe('SELECT id FROM ledger_source')
  })

  it('supports the historical inline template read', () => {
    const source =
      "Effect.fn('LedgerRepository.getCalls')(function* () { return yield* sql`SELECT model FROM ledger_call` })"
    expect(extractReadSql(source, 'getCalls')).toBe('SELECT model FROM ledger_call')
  })

  it('ignores an unrelated call that repeats the tracing label', () => {
    const source = [
      "const label = decorate('LedgerQueries.getCalls')(() => sql`DELETE FROM ledger_call`)",
      "Effect.fn('LedgerQueries.getCalls')(function* () { return yield* sql`SELECT model FROM ledger_call` })",
    ].join('\n')
    expect(extractReadSql(source, 'getCalls')).toBe('SELECT model FROM ledger_call')
  })

  it.each([
    "Effect.fn('LedgerQueries.getCalls')(function* () { return yield* sql.unsafe(dynamicSql()) })",
    "Effect.fn('LedgerQueries.getCalls')(function* () { yield* sql`SELECT 1`; return yield* sql`SELECT 2` })",
    "Effect.fn('LedgerQueries.getCalls')(function* () { return yield* sql`DELETE FROM ledger_call` })",
    "Effect.fn('LedgerQueries.getOther')(function* () { return yield* sql`SELECT 1` })",
    "const query = `SELECT 1`; function unrelated() { const query = `SELECT 2` }; Effect.fn('LedgerQueries.getCalls')(function* () { return yield* sql.unsafe(query) })",
    "const query = alias; const alias = query; Effect.fn('LedgerQueries.getCalls')(function* () { return yield* sql.unsafe(query) })",
    "Effect.fn('LedgerQueries.getCalls')(function* () { return yield* sql`SELECT ${column} FROM ledger_call` })",
  ])('rejects unsupported or ambiguous reads instead of reporting unrelated SQL', source => {
    expect(() => extractReadSql(source, 'getCalls')).toThrow()
  })

  it.each([
    ['getSources', 'ledger_source', 11],
    ['getSessions', 'ledger_session', 16],
    ['getTurns', 'ledger_turn', 12],
    ['getCalls', 'ledger_call', 38],
  ] as const)('extracts the real %s projection', (name, table, columns) => {
    const source = readFileSync(new URL('../src/main/store/ledger-repository.ts', import.meta.url), 'utf8')
    const sql = extractReadSql(source, name)
    expect(sql).toMatch(new RegExp(`FROM ${table}\\b`))
    const projection = sql.slice(sql.indexOf('SELECT') + 6, sql.lastIndexOf('FROM'))
    expect(projection.split(',')).toHaveLength(columns)
  })
})
