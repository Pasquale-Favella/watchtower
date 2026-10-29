import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import * as Schema from 'effect/Schema'
import { build } from 'esbuild'
import { describe, expect, it, vi } from 'vitest'

import { DbWorkerClient, type DbWorkerPort } from '../src/main/db-worker/client.js'
import type { DbWorkerData, DbWorkerEvent } from '../src/main/db-worker/protocol.js'
import { dashboardViewsSchema } from '../src/shared/schemas/views.js'

const isReadOrderingMarker = (event: DbWorkerEvent): boolean =>
  event.event === 'scan:progress' &&
  typeof event.progress === 'object' &&
  event.progress !== null &&
  'provider' in event.progress &&
  event.progress.provider === 'native-read-ordering'

describe('native read ordering evidence', () => {
  it('records a real same-scope read coalesced across a config write', async () => {
    const cacheRoot = join(process.cwd(), 'node_modules', '.cache')
    mkdirSync(cacheRoot, { recursive: true })
    const directory = mkdtempSync(join(cacheRoot, 'watchtower-native-read-ordering-'))
    const workerPath = join(directory, 'native-read-ordering-worker.mjs')
    const init: DbWorkerData = {
      dbPath: join(directory, 'ledger.db'),
      dataDir: directory,
      cacheDir: join(directory, 'cache'),
    }

    const events: DbWorkerEvent[] = []
    let worker: Worker | undefined
    let client: DbWorkerClient | undefined

    try {
      await build({
        absWorkingDir: process.cwd(),
        entryPoints: [join(process.cwd(), 'tests/fixtures/native-read-ordering-worker.ts')],
        outfile: workerPath,
        bundle: true,
        packages: 'external',
        platform: 'node',
        format: 'esm',
      })

      worker = new Worker(workerPath, { workerData: init })
      client = new DbWorkerClient(init, workerPath, () => worker as unknown as DbWorkerPort)
      client.onEvent(event => events.push(event))
      await client.ready

      const firstRead = client.request('store:views')
      await vi.waitFor(() => expect(events.some(isReadOrderingMarker)).toBe(true))
      const snapshotEvent = events.find(isReadOrderingMarker)
      expect(snapshotEvent).toBeDefined()
      const snapshotEventIndex = events.indexOf(snapshotEvent!)
      expect(snapshotEvent?.event).toBe('scan:progress')

      const configWrite = client.request('models:setPrice', 'demo-model', 10, 20)
      await expect(configWrite).resolves.toEqual({ ok: true })
      const configEventIndex = events.findIndex(event => event.event === 'config:changed')
      expect(configEventIndex).toBeGreaterThanOrEqual(0)

      const repeatedRead = client.request('store:views')
      expect(repeatedRead).toBe(firstRead)
      const refreshedPayload = await repeatedRead

      const refreshedViews = Schema.decodeUnknownSync(dashboardViewsSchema)(refreshedPayload)
      expect(refreshedViews.byModel).toContainEqual(expect.objectContaining({ name: 'demo-model' }))
      expect(events.filter(event => event.event === 'config:changed')).toHaveLength(1)
      expect(configEventIndex).toBeGreaterThan(snapshotEventIndex)
    } finally {
      if (client) await client.shutdown()
      else if (worker) await worker.terminate()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 20_000)
})
