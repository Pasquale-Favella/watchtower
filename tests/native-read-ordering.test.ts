import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { build } from 'esbuild'
import { describe, expect, it, vi } from 'vitest'

import { DbWorkerClient, type DbWorkerPort } from '../src/main/db-worker/client.js'
import type { DbWorkerData } from '../src/main/db-worker/protocol.js'
import { dashboardViewsSchema } from '../src/shared/schemas/views.js'

const snapshotReadySchema = Schema.Struct({
  fixture: Schema.Literal('snapshot-ready'),
  aliases: Schema.Array(Schema.Unknown),
  overrides: Schema.Array(Schema.Unknown),
})
const eventSchema = Schema.Struct({ event: Schema.String })
const requestSchema = Schema.Struct({ id: Schema.Number, op: Schema.String, args: Schema.Array(Schema.Unknown) })
const responseSchema = Schema.Struct({ id: Schema.Number, ok: Schema.Boolean, data: dashboardViewsSchema })

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

    const rawMessages: unknown[] = []
    const requests: { id: number; op: string; args: readonly unknown[] }[] = []
    let worker: Worker | undefined
    let client: DbWorkerClient | undefined
    let releaseFixture: (() => void) | undefined

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
      const nativeWorker = worker
      const port: DbWorkerPort = {
        postMessage: message => {
          const request = Schema.decodeUnknownResult(requestSchema)(message)
          if (Result.isSuccess(request)) requests.push(request.success)
          nativeWorker.postMessage(message)
        },
        on: (event, listener) =>
          nativeWorker.on(event as 'message', (...args: unknown[]) => {
            if (event === 'message') rawMessages.push(args[0])
            listener(...args)
          }),
        terminate: () => nativeWorker.terminate(),
      }
      releaseFixture = () => port.postMessage({ fixtureControl: 'releaseSnapshot' })
      client = new DbWorkerClient(init, workerPath, () => port)
      await client.ready

      const firstRead = client.request('store:views')
      await vi.waitFor(() =>
        expect(
          rawMessages.some(message => Result.isSuccess(Schema.decodeUnknownResult(snapshotReadySchema)(message))),
        ).toBe(true),
      )
      const capturedSnapshot = Schema.decodeUnknownSync(snapshotReadySchema)(
        rawMessages.find(message => Result.isSuccess(Schema.decodeUnknownResult(snapshotReadySchema)(message))),
      )
      expect(capturedSnapshot).toMatchObject({ aliases: [], overrides: [] })

      const configWrite = client.request('models:setPrice', 'demo-model', 10, 20)
      await expect(configWrite).resolves.toEqual({ ok: true })
      const configEventIndex = rawMessages.findIndex(message => {
        const event = Schema.decodeUnknownResult(eventSchema)(message)
        return Result.isSuccess(event) && event.success.event === 'config:changed'
      })
      expect(configEventIndex).toBeGreaterThanOrEqual(0)

      const repeatedRead = client.request('store:views')
      expect(repeatedRead).toBe(firstRead)
      expect(requests.map(request => request.op)).toEqual(['store:views', 'models:setPrice'])

      const firstRequest = requests.at(0)
      if (!firstRequest) throw new Error('initial worker read was not recorded')
      const oldReadId = firstRequest.id
      releaseFixture()
      const oldPayload = await repeatedRead
      const oldResponseIndex = rawMessages.findIndex(message => {
        const response = Schema.decodeUnknownResult(responseSchema)(message)
        return Result.isSuccess(response) && response.success.id === oldReadId
      })
      expect(configEventIndex).toBeLessThan(oldResponseIndex)

      const freshPayload = await client.request('store:views')
      expect(requests.map(request => request.op)).toEqual(['store:views', 'models:setPrice', 'store:views'])
      const oldViews = Schema.decodeUnknownSync(dashboardViewsSchema)(oldPayload)
      const freshViews = Schema.decodeUnknownSync(dashboardViewsSchema)(freshPayload)
      expect(oldViews.kpis.totalCost).not.toEqual(freshViews.kpis.totalCost)
      expect(freshViews.byModel).toContainEqual(expect.objectContaining({ name: 'demo-model' }))

      const oldResponse = Schema.decodeUnknownSync(responseSchema)(
        rawMessages.find(message => {
          const response = Schema.decodeUnknownResult(responseSchema)(message)
          return Result.isSuccess(response) && response.success.id === oldReadId
        }),
      )
      expect(oldResponse).toMatchObject({ id: oldReadId, ok: true, data: oldPayload })
      expect(
        rawMessages.filter(message => {
          const event = Schema.decodeUnknownResult(eventSchema)(message)
          return Result.isSuccess(event) && event.success.event === 'config:changed'
        }),
      ).toHaveLength(1)
    } finally {
      try {
        releaseFixture?.()
        if (client) await client.shutdown()
        else if (worker) await worker.terminate()
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  }, 20_000)
})
