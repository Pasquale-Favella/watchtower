import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { prepareProviderFixture } from '../scripts/fixtures/provider.cjs'
import { DbWorkerClient } from '../src/main/db-worker/client.js'
import type { DbWorkerData } from '../src/main/db-worker/protocol.js'

function addCodexSessionBurst(profile: string, count: number): void {
  const dateParts = new Date().toISOString().slice(0, 10).split('-')
  const year = dateParts[0]
  const month = dateParts[1]
  const day = dateParts[2]
  if (!year || !month || !day) throw new Error('failed to derive the controlled Codex fixture date')
  const sessionDirectory = join(profile, 'provider-fixtures', 'codex', 'sessions', year, month, day)
  const originalName = readdirSync(sessionDirectory).find(name => name.endsWith('.jsonl'))
  if (!originalName) throw new Error('controlled Codex provider fixture was not created')
  const originalPath = join(sessionDirectory, originalName)
  const records = readFileSync(originalPath, 'utf8')
    .trimEnd()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>)

  for (let index = 1; index < count; index++) {
    const sessionId = `watchtower-packaged-session-${index}`
    const clone = records.map(record => {
      if (record.type !== 'session_meta' || typeof record.payload !== 'object' || record.payload === null) return record
      return { ...record, payload: { ...record.payload, session_id: sessionId } }
    })
    const content = `${clone.map(record => JSON.stringify(record)).join('\n')}\n`
    writeFileSync(join(sessionDirectory, `rollout-burst-${String(index).padStart(4, '0')}.jsonl`), content)
  }
}

describe('production db-worker over official typed RPC', () => {
  let directory: string
  let entry: string

  beforeAll(async () => {
    directory = mkdtempSync(join(resolve('node_modules/.cache'), 'watchtower-worker-rpc-production-'))
    entry = join(directory, 'worker.mjs')
    await build({
      entryPoints: [resolve('src/main/db-worker/entry.ts')],
      outfile: entry,
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
    })
  })

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  it('scans real fixture data, applies config events before ACK, and closes its sole SQL worker gracefully', async () => {
    const profile = join(directory, 'successful-profile')
    const fixture = prepareProviderFixture(profile)
    const sessionCount = 128
    addCodexSessionBurst(profile, sessionCount)
    const init: DbWorkerData = {
      dbPath: join(profile, 'ledger.db'),
      dataDir: profile,
      cacheDir: join(profile, 'cache'),
    }
    let native: Worker | undefined
    let forcedTerminations = 0
    let exitCode: number | undefined
    const observed: string[] = []
    const client = new DbWorkerClient(init, entry, (path, data) => {
      native = new Worker(path, { workerData: data, env: fixture.env })
      native.on('exit', code => {
        exitCode = code
      })
      const terminate = native.terminate.bind(native)
      let termination: Promise<number> | undefined
      native.terminate = () => {
        if (!termination) {
          forcedTerminations++
          termination = terminate()
        }
        return termination
      }
      return native
    })
    client.onEvent(event => observed.push(event.event))
    try {
      await client.ready
      await expect(client.request('store:status')).resolves.toEqual({ scanned: false })
      await expect(client.request('scan:start', { provider: 'codex' })).resolves.toMatchObject({ ok: true })
      expect(observed).toContain('store:changed')
      await expect(client.request('overview:query', { period: 'all' })).resolves.not.toBeNull()
      await expect(client.request('store:views')).resolves.toMatchObject({
        kpis: { totalSessions: sessionCount },
      })

      await expect(client.request('models:setPrice', 'controlled-model', 0, 0)).resolves.toEqual({ ok: true })
      observed.push('write:ack')
      expect(observed.lastIndexOf('config:changed')).toBeLessThan(observed.indexOf('write:ack'))
      expect(observed).toContain('config:changed')
      await expect(client.request('models:getPriceOverrides')).resolves.toEqual([
        { model: 'controlled-model', inputPricePerMillion: 0, outputPricePerMillion: 0 },
      ])
      await expect(client.request('store:session', 'missing', 0)).rejects.toMatchObject({
        _tag: 'WorkerRpcError',
        code: 'invalid-request',
      })
      await client.request('settings:clear')
      expect(observed).toContain('ledger:reset')
      await expect(client.request('store:status')).resolves.toEqual({ scanned: false })
      await client.shutdown()
      expect({ exitCode, forcedTerminations }).toEqual({ exitCode: 0, forcedTerminations: 0 })
      expect(native?.threadId).toBe(-1)
    } finally {
      await client.shutdown()
    }
  }, 20_000)

  it('reports fatal ledger initialization once and never respawns it', async () => {
    const profile = join(directory, 'failed-profile')
    const fixture = prepareProviderFixture(profile)
    let spawns = 0
    const client = new DbWorkerClient({ dbPath: profile, dataDir: profile, cacheDir: profile }, entry, (path, data) => {
      spawns++
      return new Worker(path, { workerData: data, env: fixture.env })
    })
    try {
      await expect(client.ready).rejects.toMatchObject({ _tag: 'WorkerRpcError', code: 'database-unavailable' })
      await new Promise(resolve => setTimeout(resolve, 1_200))
      expect(spawns).toBe(1)
    } finally {
      await client.shutdown()
    }
  }, 15_000)
})
