import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/sql/SqlClient'
import { describe, expect, it } from 'vitest'

import { withNativeSqliteRuntime } from './fixtures/native-sqlite-runtime.js'

describe('native SQLite client', () => {
  it('executes prepared reads and writes through Effect SQL', async () => {
    await withNativeSqliteRuntime(':memory:', runtime => {
      const sql = runtime.runSync(SqlClient.SqlClient)
      runtime.runSync(sql.unsafe('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL)'))

      const inserted = runtime.runSync(sql.unsafe('INSERT INTO sample (value) VALUES (?)', ['one']).raw) as {
        readonly changes: number | bigint
        readonly lastInsertRowid: number | bigint
      }

      expect(inserted.changes).toBe(1)
      expect(Number(inserted.lastInsertRowid)).toBe(1)
      expect(runtime.runSync(sql.unsafe('SELECT value FROM sample WHERE id = ?', [1]))[0]).toEqual({ value: 'one' })
      expect(runtime.runSync(sql.unsafe('SELECT value FROM sample ORDER BY id'))).toEqual([{ value: 'one' }])
    })
  })

  it('rolls back a transaction when its body throws', async () => {
    await withNativeSqliteRuntime(':memory:', runtime => {
      const sql = runtime.runSync(SqlClient.SqlClient)
      runtime.runSync(sql.unsafe('CREATE TABLE sample (value TEXT NOT NULL)'))

      expect(() =>
        runtime.runSync(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql.unsafe('INSERT INTO sample (value) VALUES (?)', ['rolled back'])
              return yield* Effect.sync(() => {
                throw new Error('abort transaction')
              })
            }),
          ),
        ),
      ).toThrow('abort transaction')

      expect(runtime.runSync(sql.unsafe('SELECT value FROM sample'))).toEqual([])
    })
  })
})
