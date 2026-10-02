import { afterEach, describe, expect, it } from 'vitest'

import { NodeSqliteDatabase } from '../src/main/store/node-sqlite-client.js'

const databases: NodeSqliteDatabase[] = []

function openDatabase(): NodeSqliteDatabase {
  const database = new NodeSqliteDatabase(':memory:')
  databases.push(database)
  return database
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('NodeSqliteDatabase', () => {
  it('executes prepared reads and writes through Effect SQL', () => {
    const database = openDatabase()
    database.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')

    const inserted = database.prepare('INSERT INTO sample (value) VALUES (?)').run('one')

    expect(inserted.changes).toBe(1)
    expect(Number(inserted.lastInsertRowid)).toBe(1)
    expect(database.prepare('SELECT value FROM sample WHERE id = ?').get(1)).toEqual({ value: 'one' })
    expect(database.prepare('SELECT value FROM sample ORDER BY id').all()).toEqual([{ value: 'one' }])
  })

  it('rolls back a transaction when its body throws', () => {
    const database = openDatabase()
    database.exec('CREATE TABLE sample (value TEXT NOT NULL)')

    expect(() =>
      database.transactionSync(() => {
        database.prepare('INSERT INTO sample (value) VALUES (?)').run('rolled back')
        throw new Error('abort transaction')
      }),
    ).toThrow('abort transaction')

    expect(database.prepare('SELECT value FROM sample').all()).toEqual([])
  })
})
