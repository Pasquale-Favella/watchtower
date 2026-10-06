import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, StatementSync } from 'node:sqlite'

import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createLedgerMcpQueryRuntime } from '../src/main/agents/ledger-mcp/query-runtime.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'

const directories: string[] = []
const runtimes: Array<{ dispose: () => Promise<void> }> = []

function makeLedger(): { store: LedgerStore; dbPath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-ledger-mcp-runtime-'))
  directories.push(directory)
  const dbPath = join(directory, 'ledger.db')
  const store = new LedgerStore(dbPath)
  const call = {
    ...buildFixtureCachedCall(0),
    provider: 'claude',
    model: 'mcp-raw-model',
    timestamp: '2026-07-01T10:00:00.000Z',
    deduplicationKey: 'runtime-call-0',
    tools: ['Read'],
  }
  const turn = buildFixtureCachedTurn(0, 'Inspect the project', {
    sessionId: 'runtime-session',
    timestamp: call.timestamp,
    calls: [call],
  })
  store.portIn({
    provider: 'claude',
    envFingerprint: 'runtime-test',
    filePath: '/cache/runtime.jsonl',
    project: 'runtime-project',
    verdict: 'new',
    cachedFile: buildFixtureCachedFile({ canonicalProjectName: 'runtime-project', turns: [turn] }),
  })
  return { store, dbPath }
}

async function openRuntime(dbPath: string) {
  const runtime = await createLedgerMcpQueryRuntime(dbPath)
  runtimes.push(runtime)
  return runtime
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Ledger MCP query runtime', () => {
  it('uses one read-only SQLite connection for all query calls and picks up external config edits', async () => {
    const { store, dbPath } = makeLedger()
    const runtime = await openRuntime(dbPath)
    const writer = new DatabaseSync(dbPath)
    try {
      const first = await runtime.queries.scope({ period: 'lifetime' })
      expect(first.calls).toBe(1)

      writer
        .prepare('INSERT INTO model_alias (model, alias_of) VALUES (?, ?)')
        .run('mcp-raw-model', 'mcp-aliased-model')
      writer
        .prepare(
          'INSERT INTO price_override (model, input_price_per_million, output_price_per_million) VALUES (?, ?, ?)',
        )
        .run('mcp-aliased-model', 12, 24)
      const payload = await runtime.queries.models({ period: 'lifetime' })
      expect(payload.byModel.map(model => model.model)).toContain('mcp-aliased-model')

      await expect(runtime.run(Effect.succeed('same owner runtime'))).resolves.toBe('same owner runtime')
      await expect(
        runtime.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql.unsafe("INSERT INTO ledger_source (provider, env_fingerprint, file_path) VALUES ('x', 'y', 'z')")
          }),
        ),
      ).rejects.toBeDefined()

      expect(store.getSources()).toHaveLength(1)
    } finally {
      writer.close()
      store.close()
    }
  })

  it('prepares the six request-snapshot SELECTs for a Models query on its persistent connection', async () => {
    const { store, dbPath } = makeLedger()
    const runtime = await openRuntime(dbPath)
    const prepared: Array<{ database: DatabaseSync; sql: string }> = []
    const executedSelects: string[] = []
    const statementSql = new WeakMap<object, string>()
    const originalPrepare = DatabaseSync.prototype.prepare
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
      prepared.push({ database: this, sql })
      const statement = originalPrepare.call(this, sql)
      statementSql.set(statement, sql)
      return statement
    })
    const originalAll = StatementSync.prototype.all
    vi.spyOn(StatementSync.prototype, 'all').mockImplementation(function (
      this: StatementSync,
      ...parameters: Parameters<StatementSync['all']>
    ) {
      const sql = statementSql.get(this)
      if (sql && /^\s*SELECT\b/i.test(sql)) executedSelects.push(sql)
      return originalAll.apply(this, parameters)
    })
    try {
      for (let query = 0; query < 2; query++) {
        const before = executedSelects.length
        await runtime.queries.models({ period: 'lifetime' })
        expect(executedSelects.slice(before)).toHaveLength(6)
      }
      expect(prepared.filter(({ sql }) => /^\s*SELECT\b/i.test(sql))).toHaveLength(6)
      expect(new Set(prepared.map(({ database }) => database)).size).toBe(1)
    } finally {
      store.close()
    }
  })

  it('does not create a missing read-only database and releases a runtime with an invalid schema', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-ledger-mcp-missing-'))
    directories.push(directory)
    const missingPath = join(directory, 'missing.db')
    await expect(createLedgerMcpQueryRuntime(missingPath)).rejects.toBeDefined()
    expect(existsSync(missingPath)).toBe(false)

    const emptyDatabase = new DatabaseSync(join(directory, 'empty.db'))
    emptyDatabase.close()
    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    await expect(createLedgerMcpQueryRuntime(join(directory, 'empty.db'))).rejects.toBeDefined()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the native database handle when its owner disposes the runtime', async () => {
    const { store, dbPath } = makeLedger()
    store.close()
    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    const runtime = await openRuntime(dbPath)
    await runtime.dispose()
    runtimes.splice(runtimes.indexOf(runtime), 1)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
