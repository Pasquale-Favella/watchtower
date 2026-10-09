import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { setPriceOverrides } from '../src/main/pipeline/models.js'
import type {
  ParsedProviderCall,
  Provider,
  SessionParser,
  SessionSource,
} from '../src/main/pipeline/providers/types.js'
import { createWarpProvider } from '../src/main/pipeline/providers/warp.js'
import { createZedProvider } from '../src/main/pipeline/providers/zed.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'

const tempDirs: string[] = []
const WARP_MODEL = 'warp-captured-pricing-model'
const ZED_MODEL = 'zed-captured-pricing-model'

afterEach(() => {
  setPriceOverrides({})
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'watchtower-desktop-pricing-'))
  tempDirs.push(dir)
  return dir
}

async function collect(parser: SessionParser): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  for await (const call of parser.parse()) calls.push(call)
  return calls
}

function configure(model: string, input: number): void {
  setPriceOverrides({ [model]: { input, output: input } })
}

function createWarpFixture(): { provider: Provider; source: SessionSource } {
  const dbPath = join(tempDir(), 'warp.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec(
    'CREATE TABLE agent_conversations (conversation_id TEXT, conversation_data TEXT, last_modified_at TEXT);' +
      'CREATE TABLE ai_queries (exchange_id TEXT, conversation_id TEXT, start_ts TEXT, input TEXT, working_directory TEXT, output_status TEXT, model_id TEXT, planning_model_id TEXT, coding_model_id TEXT);' +
      'CREATE TABLE blocks (block_id TEXT, start_ts TEXT, stylized_command BLOB, ai_metadata TEXT);',
  )
  db.prepare(
    'INSERT INTO agent_conversations (conversation_id, conversation_data, last_modified_at) VALUES (?, ?, ?)',
  ).run(
    'conversation-one',
    JSON.stringify({
      conversation_usage_metadata: {
        token_usage: [{ model_id: WARP_MODEL, warp_tokens: 20 }],
      },
    }),
    '2025-01-01T00:00:00Z',
  )
  db.prepare(
    'INSERT INTO ai_queries (exchange_id, conversation_id, start_ts, input, working_directory, output_status, model_id, planning_model_id, coding_model_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    'exchange-one',
    'conversation-one',
    '2025-01-01 00:00:00',
    JSON.stringify([{ Query: { text: 'prompt text' } }]),
    'C:/project',
    'Completed',
    '',
    '',
    '',
  )
  db.close()
  return {
    provider: createWarpProvider(dbPath),
    source: { path: `${dbPath}:conversation-one`, project: 'project', provider: 'warp' },
  }
}

function createZedFixture(): { provider: Provider; source: SessionSource } {
  const dbPath = join(tempDir(), 'zed.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE threads (id TEXT, summary TEXT, updated_at TEXT, data_type TEXT, data BLOB)')
  db.prepare('INSERT INTO threads (id, summary, updated_at, data_type, data) VALUES (?, ?, ?, ?, ?)').run(
    'thread-one',
    'prompt text',
    '2025-01-01T00:00:00Z',
    'json',
    JSON.stringify({
      model: { model: ZED_MODEL },
      request_token_usage: { 'prompt text': { input_tokens: 2, output_tokens: 1 } },
    }),
  )
  db.close()
  return {
    provider: createZedProvider(dbPath),
    source: { path: dbPath, project: 'zed', provider: 'zed' },
  }
}

describe('desktop provider captured scan pricing', () => {
  it.each([
    ['Warp', createWarpFixture, WARP_MODEL],
    ['Zed', createZedFixture, ZED_MODEL],
  ] as const)(
    '%s holds its parser price across config changes and refreshes for the next parser',
    async (_, fixture, model) => {
      const { provider, source } = fixture()
      configure(model, 500_000)
      const firstParser = provider.createSessionParser(source, new Set())
      configure(model, 1_000_000)

      const first = await collect(firstParser)
      const next = await collect(provider.createSessionParser(source, new Set()))

      const firstCost = first[0]?.costUSD ?? 0
      const nextCost = next[0]?.costUSD ?? 0
      expect(first).toHaveLength(1)
      expect(next).toHaveLength(1)
      expect(firstCost).toBeGreaterThan(0)
      expect(nextCost).toBe(firstCost * 2)
    },
  )

  it('uses the exact pricing capability supplied by the scan context', async () => {
    const warpFixture = createWarpFixture()
    const zedFixture = createZedFixture()
    const calculateCost = vi.fn(() => 31)
    const pricing: ScanPricing = { calculateCost, calculateLocalModelSavings: () => null }
    const context = { pricing }

    const calls = await Promise.all([
      collect(warpFixture.provider.createSessionParser(warpFixture.source, new Set(), undefined, context)),
      collect(zedFixture.provider.createSessionParser(zedFixture.source, new Set(), undefined, context)),
    ])

    expect(calls.map(result => result[0]?.costUSD)).toEqual([31, 31])
    expect(calculateCost).toHaveBeenCalledTimes(2)
  })
})
