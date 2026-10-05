import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { setModelAliases, setPriceOverrides } from '../src/main/pipeline/models.js'
import { createOpenCodeProvider } from '../src/main/pipeline/providers/opencode.js'
import type { ParsedProviderCall, SessionParser } from '../src/main/pipeline/providers/types.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'

const tempDirs: string[] = []
const ALIAS = 'captured-pricing-probe'
const FIRST = 'captured-pricing-first'
const SECOND = 'captured-pricing-second'

afterEach(() => {
  setModelAliases({})
  setPriceOverrides({})
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'watchtower-opencode-pricing-'))
  tempDirs.push(dir)
  return dir
}

function setPricing(target = FIRST, input = 1, output = 2, alias = ALIAS): void {
  setModelAliases({ [alias]: target })
  setPriceOverrides({ [FIRST]: { input, output }, [SECOND]: { input: 10, output: 20 } })
}

async function collect(parser: SessionParser): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  for await (const call of parser.parse()) calls.push(call)
  return calls
}

describe('OpenCode captured scan pricing', () => {
  it('keeps a file parser on its captured alias and prices the next parser with fresh state', async () => {
    const base = tempDir()
    const dataDir = join(base, 'opencode')
    const sessionDir = join(dataDir, 'storage', 'session', 'project')
    const messageDir = join(dataDir, 'storage', 'message', 'session-one')
    mkdirSync(sessionDir, { recursive: true })
    mkdirSync(messageDir, { recursive: true })
    const sessionPath = join(sessionDir, 'session-one.json')
    writeFileSync(sessionPath, JSON.stringify({ id: 'session-one', directory: 'C:/project' }))
    writeFileSync(
      join(messageDir, 'message-one.json'),
      JSON.stringify({
        id: 'message-one',
        role: 'assistant',
        modelID: ALIAS,
        tokens: { input: 2, output: 3 },
        time: { created: 1_750_000_000_000 },
      }),
    )

    setPricing()
    const provider = createOpenCodeProvider(base)
    const first = provider.createSessionParser(
      { path: sessionPath, project: 'project', provider: 'opencode' },
      new Set(),
    )
    setPricing(SECOND)
    const oldCapture = await collect(first)
    const newCapture = await collect(
      provider.createSessionParser({ path: sessionPath, project: 'project', provider: 'opencode' }, new Set()),
    )

    expect(oldCapture.map(call => call.costUSD)).toEqual([0.000008])
    expect(newCapture.map(call => call.costUSD)).toEqual([0.00008])
  })

  it('keeps SQLite message rows on the price captured before parsing starts', async () => {
    const dir = tempDir()
    const dataDir = join(dir, 'opencode')
    mkdirSync(dataDir)
    const dbPath = join(dataDir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    db.exec(
      'CREATE TABLE session_v2 (id TEXT, directory TEXT, title TEXT, time_created REAL, time_archived REAL, parent_id TEXT);' +
        'CREATE TABLE session_message (session_id TEXT, id TEXT, type TEXT, seq INTEGER, time_created REAL, data BLOB);',
    )
    db.prepare('INSERT INTO session_v2 (id, directory, title, time_created) VALUES (?, ?, ?, ?)').run(
      'session-two',
      'C:/project',
      'test',
      1_750_000_000,
    )
    db.prepare(
      'INSERT INTO session_message (session_id, id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'session-two',
      'message-two',
      'assistant',
      1,
      1_750_000_000,
      JSON.stringify({
        role: 'assistant',
        model: { id: ALIAS, providerID: 'openai' },
        tokens: { input: 2, output: 3 },
      }),
    )
    db.close()

    setPricing()
    const provider = createOpenCodeProvider(dir)
    const source = { path: `${dbPath}:session-two`, project: 'project', provider: 'opencode' }
    const first = provider.createSessionParser(source, new Set())
    setPricing(SECOND)

    await expect(collect(first)).resolves.toMatchObject([{ costUSD: 0.000008 }])
    await expect(collect(provider.createSessionParser(source, new Set()))).resolves.toMatchObject([
      { costUSD: 0.00008 },
    ])
  })

  it('uses the same pricing capability supplied by the scan context', async () => {
    const base = tempDir()
    const dataDir = join(base, 'opencode')
    const sessionDir = join(dataDir, 'storage', 'session', 'project')
    const messageDir = join(dataDir, 'storage', 'message', 'session-context')
    mkdirSync(sessionDir, { recursive: true })
    mkdirSync(messageDir, { recursive: true })
    const sessionPath = join(sessionDir, 'session-context.json')
    writeFileSync(sessionPath, JSON.stringify({ id: 'session-context' }))
    writeFileSync(
      join(messageDir, 'message-context.json'),
      JSON.stringify({
        id: 'message-context',
        role: 'assistant',
        modelID: ALIAS,
        tokens: { input: 2, output: 3 },
        time: { created: 1_750_000_000_000 },
      }),
    )
    const calculateCost = vi.fn(() => 23)
    const pricing: ScanPricing = { calculateCost, calculateLocalModelSavings: () => null }
    const provider = createOpenCodeProvider(base)
    const result = await collect(
      provider.createSessionParser(
        { path: sessionPath, project: 'project', provider: 'opencode' },
        new Set(),
        undefined,
        { pricing },
      ),
    )

    expect(result).toMatchObject([{ costUSD: 23 }])
    expect(calculateCost).toHaveBeenCalledTimes(1)
  })
})
