import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Sqlite from '@effect/sql-sqlite-node'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { afterEach, describe, expect, it } from 'vitest'

import { clearLedger } from '../src/main/application/clear-ledger.js'
import { LedgerMaintenance } from '../src/main/application/ledger-maintenance.js'
import { LedgerMaintenanceLive } from '../src/main/ledger-maintenance-live.js'
import { initializeLedger } from '../src/main/store/ledger-initialization.js'
import { LedgerConfig } from '../src/main/store/ledger-ports.js'
import { LedgerIngest, LedgerPortsLayer } from '../src/main/store/ledger-repository.js'
import { buildFixtureCachedFile, FIXTURE_SOURCE_PATH } from './fixtures/cached-file.js'

const tempDirs: string[] = []

function makeSqlError(): SqlError.SqlError {
  return new SqlError.SqlError({
    reason: new SqlError.SqlSyntaxError({ cause: new Error('controlled SQL failure'), message: 'controlled failure' }),
  })
}

function commandLayer(
  seen: string[],
  options: { clear?: Effect.Effect<void, SqlError.SqlError>; reclaim?: Effect.Effect<void, SqlError.SqlError> } = {},
) {
  return Layer.mergeAll(
    Layer.succeed(
      LedgerIngest,
      LedgerIngest.of({
        portIn: () => Effect.die('unused'),
        deleteSource: () => Effect.die('unused'),
        clear: () =>
          Effect.flatMap(
            Effect.sync(() => seen.push('clear')),
            () => options.clear ?? Effect.void,
          ),
      }),
    ),
    Layer.succeed(
      LedgerMaintenance,
      LedgerMaintenance.of({
        reclaim: () =>
          Effect.flatMap(
            Effect.sync(() => seen.push('reclaim')),
            () => options.reclaim ?? Effect.void,
          ),
      }),
    ),
  )
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('clearLedger', () => {
  it('clears before reclaiming and recovers only a typed reclaim SQL failure', async () => {
    const seen: string[] = []
    const exit = await Effect.runPromiseExit(
      clearLedger().pipe(Effect.provide(commandLayer(seen, { reclaim: Effect.fail(makeSqlError()) }))),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(seen).toEqual(['clear', 'reclaim'])
  })

  it('does not reclaim after a typed clear failure', async () => {
    const seen: string[] = []
    const clearFailure = makeSqlError()
    const exit = await Effect.runPromiseExit(
      clearLedger().pipe(Effect.provide(commandLayer(seen, { clear: Effect.fail(clearFailure) }))),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain('SqlError')
    expect(seen).toEqual(['clear'])
  })

  it('keeps defects and interruption as failures', async () => {
    const defect = await Effect.runPromiseExit(
      clearLedger().pipe(Effect.provide(commandLayer([], { reclaim: Effect.die('maintenance defect') }))),
    )
    expect(Exit.isFailure(defect)).toBe(true)
    if (Exit.isFailure(defect)) expect(defect.cause.toString()).toContain('maintenance defect')

    const interrupted = await Effect.runPromiseExit(
      clearLedger().pipe(Effect.provide(commandLayer([], { reclaim: Effect.interrupt }))),
    )
    expect(Exit.isFailure(interrupted)).toBe(true)
    if (Exit.isFailure(interrupted)) expect(interrupted.cause.toString()).toContain('Interrupt')
  })

  it('reclaims real SQLite pages on the existing writer after the fact clear commits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tr-ledger-clear-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'ledger.db')
    const sqlite = Sqlite.SqliteClient.layer({ filename: dbPath })
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(LedgerPortsLayer, LedgerMaintenanceLive).pipe(Layer.provideMerge(sqlite)),
    )

    try {
      runtime.runSync(initializeLedger)
      runtime.runSync(
        Effect.gen(function* () {
          const config = yield* LedgerConfig
          yield* config.setModelAlias('old-model', 'new-model')
          yield* config.setPriceOverride('new-model', { inputPricePerMillion: 2, outputPricePerMillion: 3 })
          yield* config.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: '2026-10-06T00:00:00.000Z' })
          yield* config.setDisplayCurrency('EUR')
          yield* config.setRefreshCadence('5m')
          yield* config.setLedgerMcpStartupMode('at-launch')
          yield* config.dismissSkill('skill', 'skill-to-keep', 'kept preference', '2026-10-06T00:00:00.000Z')

          const ingest = yield* LedgerIngest
          yield* ingest.portIn({
            provider: 'opencode',
            envFingerprint: 'clear-fixture',
            filePath: FIXTURE_SOURCE_PATH,
            verdict: 'new',
            cachedFile: buildFixtureCachedFile(),
          })

          const sql = yield* SqlClient.SqlClient
          yield* sql.withTransaction(
            Effect.gen(function* () {
              for (let index = 0; index < 220; index += 1) {
                yield* sql.unsafe('INSERT INTO ledger_source (provider, env_fingerprint, file_path) VALUES (?, ?, ?)', [
                  'fixture',
                  `bulk-${index}`,
                  `${index}-${'x'.repeat(18_000)}`,
                ])
              }
            }),
          )
        }),
      )

      const beforeBytes = statSync(dbPath).size
      const beforeWalBytes = statSync(`${dbPath}-wal`).size
      runtime.runSync(clearLedger())
      const afterBytes = statSync(dbPath).size
      const afterWalBytes = statSync(`${dbPath}-wal`).size

      expect(beforeBytes).toBeGreaterThan(afterBytes)
      expect(beforeWalBytes).toBeGreaterThan(0)
      expect(afterWalBytes).toBe(0)
      expect(
        runtime.runSync(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const stats = (yield* sql.unsafe('PRAGMA freelist_count')) as readonly { freelist_count: number }[]
            return Number(stats[0]?.freelist_count ?? 0)
          }),
        ),
      ).toBe(0)

      const remaining = runtime.runSync(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const facts = yield* sql.unsafe(`
            SELECT
              (SELECT COUNT(*) FROM ledger_source) AS sources,
              (SELECT COUNT(*) FROM ledger_session) AS sessions,
              (SELECT COUNT(*) FROM ledger_turn) AS turns,
              (SELECT COUNT(*) FROM ledger_call) AS calls
          `)
          const config = yield* LedgerConfig
          return {
            facts: facts[0],
            config: {
              aliases: yield* config.getModelAliases(),
              prices: yield* config.getPriceOverrides(),
              currencyRate: yield* config.getCurrencyRate('EUR'),
              displayCurrency: yield* config.getDisplayCurrency(),
              cadence: yield* config.getRefreshCadence(),
              startupMode: yield* config.getLedgerMcpStartupMode(),
              dismissals: yield* config.getSkillDismissals(),
            },
          }
        }),
      )

      expect(remaining.facts).toEqual({ sources: 0, sessions: 0, turns: 0, calls: 0 })
      expect(remaining.config).toEqual({
        aliases: [{ model: 'old-model', aliasOf: 'new-model' }],
        prices: [{ model: 'new-model', inputPricePerMillion: 2, outputPricePerMillion: 3 }],
        currencyRate: { code: 'EUR', symbol: '€', rate: 0.9, updatedAt: '2026-10-06T00:00:00.000Z' },
        displayCurrency: 'EUR',
        cadence: '5m',
        startupMode: 'at-launch',
        dismissals: [
          { source: 'skill', name: 'skill-to-keep', reason: 'kept preference', created: '2026-10-06T00:00:00.000Z' },
        ],
      })
    } finally {
      Effect.runSync(runtime.disposeEffect)
    }
  })
})
