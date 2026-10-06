import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DbWorkerContext } from '../src/main/db-worker/context.js'
import { LedgerQueries } from '../src/main/store/ledger-ports.js'
import type { ScanMetadata } from '../src/shared/schemas/scan.js'
import { buildFixtureCachedFile, FIXTURE_SOURCE_PATH } from './fixtures/cached-file.js'
import { openWorkerOwner } from './fixtures/worker-owner.js'

async function withWorker(
  run: (context: DbWorkerContext, owner: ReturnType<typeof openWorkerOwner>) => Promise<void>,
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
  const owner = openWorkerOwner(dbPath, undefined, overrides)
  const context = new DbWorkerContext(
    { dbPath, dataDir: directory, cacheDir: join(directory, 'cache') },
    () => {},
    owner,
  )
  try {
    await run(context, owner)
  } finally {
    await context.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

afterEach(() => vi.restoreAllMocks())

describe('worker scan status uses source existence', () => {
  it('observes native ingest and clear without hydrating the sources', async () => {
    await withWorker(async (context, owner) => {
      const facade = vi.spyOn(owner.ledger, 'getSources').mockImplementation(() => {
        throw new Error('facade read')
      })
      expect(await context.dispatch('store:status', [])).toEqual({ scanned: false })
      owner.ledger.portIn({
        provider: 'opencode',
        envFingerprint: 'status',
        filePath: FIXTURE_SOURCE_PATH,
        verdict: 'new',
        cachedFile: buildFixtureCachedFile(),
      })
      const writer = new DatabaseSync(owner.ledger.dbPath)
      try {
        writer.prepare("UPDATE ledger_source SET fingerprint_size_bytes = 'invalid'").run()
      } finally {
        writer.close()
      }
      expect(await context.dispatch('store:status', [])).toEqual({ scanned: true })
      await context.dispatch('settings:clear', [])
      expect(await context.dispatch('store:status', [])).toEqual({ scanned: false })
      expect(facade).not.toHaveBeenCalled()
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
