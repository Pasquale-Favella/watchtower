import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlError from 'effect/sql/SqlError'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LedgerMaintenance } from '../src/core/ports/ledger-maintenance.js'
import { DbWorkerContext } from '../src/platform/electron/workers/context.js'
import { LedgerQueries } from '../src/core/ports/repository.js'
import { LedgerIngest } from '../src/infrastructure/sqlite/ledger-repository.js'
import { openEngineRuntime, type EngineRuntime } from '../src/infrastructure/runtime/engine-runtime.js'
import type { ScanMetadata } from '../src/shared/schemas/scan.js'
import { buildFixtureCachedFile, FIXTURE_SOURCE_PATH } from './fixtures/cached-file.js'

function removeFixture(directory: string): void {
  const target = resolve(directory)
  assert.equal(dirname(target), resolve(tmpdir()))
  assert.ok(basename(target).startsWith('watchtower-worker-source-status-'))
  rmSync(target, { recursive: true, force: true })
}

async function withWorker(
  run: (context: DbWorkerContext, owner: { runtime: EngineRuntime; dbPath: string }) => Promise<void>,
  hasSources?: LedgerQueries['Service']['hasSources'],
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-worker-source-status-'))
  const dbPath = join(directory, 'ledger.db')
  const unused = () => Effect.die('status must not load ledger facts')
  const overrides = hasSources
    ? Layer.succeed(
        LedgerQueries,
        LedgerQueries.of({
          hasSources,
          getSources: unused,
          getSessions: unused,
          getTurns: unused,
          getCalls: unused,
          getCallFacts: unused,
          getRequestSnapshotData: unused,
        }),
      )
    : undefined
  let runtime: EngineRuntime
  try {
    runtime = openEngineRuntime(dbPath, undefined, overrides)
  } catch (error) {
    removeFixture(directory)
    throw error
  }
  const owner = { runtime, dbPath }
  let context: DbWorkerContext
  try {
    context = new DbWorkerContext({ dbPath, dataDir: directory, cacheDir: join(directory, 'cache') }, () => {}, owner)
  } catch (error) {
    try {
      await runtime.dispose()
    } finally {
      removeFixture(directory)
    }
    throw error
  }
  try {
    await run(context, owner)
  } finally {
    try {
      await context.close()
    } finally {
      try {
        await runtime.dispose()
      } finally {
        removeFixture(directory)
      }
    }
  }
}

afterEach(() => vi.restoreAllMocks())

describe('worker scan status uses source existence', () => {
  it('observes native ingest and clear without hydrating the sources', async () => {
    await withWorker(async (context, owner) => {
      const queries = owner.runtime.runSync(LedgerQueries)
      const ingest = owner.runtime.runSync(LedgerIngest)
      const maintenance = owner.runtime.runSync(LedgerMaintenance)
      const hasSources = vi.spyOn(queries, 'hasSources')
      const clear = vi.spyOn(ingest, 'clear')
      const reclaim = vi.spyOn(maintenance, 'reclaim')
      const getSources = vi.spyOn(queries, 'getSources')
      const getSessions = vi.spyOn(queries, 'getSessions')
      const getTurns = vi.spyOn(queries, 'getTurns')
      const getCalls = vi.spyOn(queries, 'getCalls')
      const getCallFacts = vi.spyOn(queries, 'getCallFacts')
      const getSnapshot = vi.spyOn(queries, 'getRequestSnapshotData')
      expect(await context.dispatch('store:status', [])).toEqual({ scanned: false })
      expect(hasSources).toHaveBeenCalledOnce()
      expect(getSources).not.toHaveBeenCalled()
      expect(getSessions).not.toHaveBeenCalled()
      expect(getTurns).not.toHaveBeenCalled()
      expect(getCalls).not.toHaveBeenCalled()
      expect(getCallFacts).not.toHaveBeenCalled()
      expect(getSnapshot).not.toHaveBeenCalled()
      await owner.runtime.runPromise(
        Effect.flatMap(LedgerIngest, ingest =>
          ingest.portIn({
            provider: 'opencode',
            envFingerprint: 'status',
            filePath: FIXTURE_SOURCE_PATH,
            verdict: 'new',
            cachedFile: buildFixtureCachedFile(),
          }),
        ),
      )
      const writer = new DatabaseSync(owner.dbPath)
      try {
        writer.prepare("UPDATE ledger_source SET fingerprint_size_bytes = 'invalid'").run()
      } finally {
        writer.close()
      }
      expect(await context.dispatch('store:status', [])).toEqual({ scanned: true })
      expect(hasSources).toHaveBeenCalledTimes(2)
      await context.dispatch('settings:clear', [])
      expect(clear).toHaveBeenCalledOnce()
      expect(reclaim).toHaveBeenCalledOnce()
      expect(await context.dispatch('store:status', [])).toEqual({ scanned: false })
      expect(hasSources).toHaveBeenCalledTimes(3)
      expect(getSources).not.toHaveBeenCalled()
      expect(getSessions).not.toHaveBeenCalled()
      expect(getTurns).not.toHaveBeenCalled()
      expect(getCalls).not.toHaveBeenCalled()
      expect(getCallFacts).not.toHaveBeenCalled()
      expect(getSnapshot).not.toHaveBeenCalled()
    })
  })

  it('retains metadata after a zero-source scan and removes it on clear', async () => {
    await withWorker(async context => {
      const metadata: ScanMetadata = {
        scanId: 'empty',
        startedAt: '2026-10-06T12:00:00.000Z',
        completedAt: '2026-10-06T12:00:01.000Z',
        portedFiles: 0,
        unchangedFiles: 0,
        failedFiles: 0,
        perProvider: [],
        aborted: false,
      }
      vi.spyOn(context as unknown as { performScan: () => Effect.Effect<ScanMetadata> }, 'performScan').mockReturnValue(
        Effect.succeed(metadata),
      )
      expect(await context.dispatch('scan:start', [])).toEqual({ ok: true })
      expect(await context.dispatch('store:status', [])).toEqual({ scanned: true, metadata })
      await context.dispatch('settings:clear', [])
      expect(await context.dispatch('store:status', [])).toEqual({ scanned: false })
    })
  })

  it('uses a substituted existence port without any other fact reads', async () => {
    const read = vi.fn(() => Effect.succeed(true))
    await withWorker(async context => {
      expect(await context.dispatch('store:status', [])).toEqual({ scanned: true })
      expect(read).toHaveBeenCalledOnce()
    }, read)
  })

  it('preserves typed SQL failure and unexpected defects as rejected dispatches', async () => {
    const failure = new SqlError.SqlError({
      reason: new SqlError.ConnectionError({ cause: new Error('private database') }),
    })
    await withWorker(
      async context => {
        await expect(context.dispatch('store:status', [])).rejects.toBe(failure)
      },
      () => Effect.fail(failure),
    )
    const defect = new Error('status defect')
    await withWorker(
      async context => {
        await expect(context.dispatch('store:status', [])).rejects.toBe(defect)
      },
      () => Effect.die(defect),
    )
  })
})
