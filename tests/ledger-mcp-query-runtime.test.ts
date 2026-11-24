import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

import { LedgerIngest } from '@/core/ports/repository.js'
import { openEngineRuntime } from '@/infrastructure/runtime/engine-runtime.js'
import { DbWorkerClient } from '@/platform/electron/workers/client.js'
import { createLedgerMcpQueries } from '@/platform/mcp/query-api.js'

import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'

it('reads all six ledger MCP views through the DB worker and observes pricing edits', async () => {
  const cache = resolve('node_modules/.cache')
  mkdirSync(cache, { recursive: true })
  const directory = mkdtempSync(join(cache, 'watchtower-ledger-mcp-worker-'))
  try {
    const entry = join(directory, 'worker.mjs')
    await build({
      entryPoints: [resolve('src/platform/electron/workers/entry.ts')],
      outfile: entry,
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
    })
    const dbPath = join(directory, 'ledger.db')
    const seed = openEngineRuntime(dbPath)
    try {
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
      seed.runSync(
        Effect.flatMap(LedgerIngest, ingest =>
          ingest.portIn({
            provider: 'claude',
            envFingerprint: 'runtime-test',
            filePath: '/cache/runtime.jsonl',
            project: 'runtime-project',
            verdict: 'new',
            cachedFile: buildFixtureCachedFile({ canonicalProjectName: 'runtime-project', turns: [turn] }),
          }),
        ),
      )
    } finally {
      await seed.dispose()
    }

    const worker = new DbWorkerClient({ dbPath, dataDir: directory, cacheDir: join(directory, 'cache') }, entry)
    try {
      await worker.ready
      const queries = createLedgerMcpQueries(worker)
      const scope = { period: 'lifetime' } as const
      expect(await queries.scope(scope)).toMatchObject({ calls: 1, sessions: 1 })
      expect(await queries.calls({ scope, tool: 'Read', limit: 1 })).toMatchObject([{ model: 'mcp-raw-model' }])
      expect(await queries.calls({ scope, tool: 'Bash', limit: 1 })).toEqual([])
      expect(await queries.sessions(scope)).toMatchObject([{ sessionId: 'runtime-session' }])
      expect(await queries.overview(scope)).toHaveProperty('kpis')
      expect(await queries.skills(scope)).toMatchObject({ summary: { sessions: 1, calls: 1 } })
      await worker.request('models:addAlias', 'mcp-raw-model', 'mcp-aliased-model')
      await worker.request('models:setPrice', 'mcp-aliased-model', 12, 24)
      expect((await queries.models(scope)).byModel.map(model => model.model)).toContain('mcp-aliased-model')
    } finally {
      await worker.shutdown()
    }
  } finally {
    if (dirname(directory) === cache) rmSync(directory, { recursive: true, force: true })
  }
})
