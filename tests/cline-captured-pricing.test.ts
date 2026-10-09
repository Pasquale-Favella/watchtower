import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { setModelAliases, setPriceOverrides } from '../src/main/pipeline/models.js'
import { createClineProvider } from '../src/main/pipeline/providers/cline.js'
import { createIBMBobProvider } from '../src/main/pipeline/providers/ibm-bob.js'
import { createKiloCodeProvider } from '../src/main/pipeline/providers/kilo-code.js'
import { createRooCodeProvider } from '../src/main/pipeline/providers/roo-code.js'
import type { ParsedProviderCall, SessionParser } from '../src/main/pipeline/providers/types.js'
import type { ScanPricing } from '../src/main/pipeline/scan-pricing.js'

const tempDirs: string[] = []
const ALIAS = 'captured-cline-probe'

afterEach(() => {
  setModelAliases({})
  setPriceOverrides({})
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'watchtower-cline-pricing-'))
  tempDirs.push(dir)
  return dir
}

function makeTask(): string {
  const taskDir = join(tempDir(), 'tasks', 'task-one')
  mkdirSync(taskDir, { recursive: true })
  writeFileSync(
    join(taskDir, 'ui_messages.json'),
    JSON.stringify([
      {
        type: 'say',
        say: 'api_req_started',
        ts: 1_750_000_000_000,
        text: JSON.stringify({ tokensIn: 2, tokensOut: 3 }),
      },
    ]),
  )
  writeFileSync(
    join(taskDir, 'api_conversation_history.json'),
    JSON.stringify([{ role: 'user', content: [{ text: `<model>${ALIAS}</model>` }] }]),
  )
  return taskDir
}

async function collect(parser: SessionParser): Promise<ParsedProviderCall[]> {
  const calls: ParsedProviderCall[] = []
  for await (const call of parser.parse()) calls.push(call)
  return calls
}

describe('Cline family captured scan pricing', () => {
  it('keeps one parser on captured alias pricing and uses fresh state on the next parser', async () => {
    const taskDir = makeTask()
    setModelAliases({ [ALIAS]: 'cline-price-one' })
    setPriceOverrides({
      'cline-price-one': { input: 1, output: 2 },
      'cline-price-two': { input: 10, output: 20 },
    })
    const provider = createClineProvider(taskDir)
    const source = { path: taskDir, project: 'Cline', provider: 'cline' }
    const first = provider.createSessionParser(source, new Set())
    setModelAliases({ [ALIAS]: 'cline-price-two' })

    await expect(collect(first)).resolves.toMatchObject([{ costUSD: 0.000008 }])
    await expect(collect(provider.createSessionParser(source, new Set()))).resolves.toMatchObject([
      { costUSD: 0.00008 },
    ])
  })

  it('passes the scan pricing capability unchanged through each Cline-family wrapper', async () => {
    const taskDir = makeTask()
    const calculateCost = vi.fn(() => 17)
    const pricing: ScanPricing = {
      calculateCost,
      calculateLocalModelSavings: () => null,
    }
    const context = { pricing }
    const source = { path: taskDir, project: 'project', provider: 'test' }
    const providers = [
      createClineProvider(taskDir),
      createRooCodeProvider(taskDir),
      createIBMBobProvider(taskDir),
      createKiloCodeProvider(taskDir),
    ]

    for (const provider of providers) {
      const result = await collect(provider.createSessionParser(source, new Set(), undefined, context))
      expect(result).toHaveLength(1)
      expect(result[0]?.costUSD).toBe(17)
    }
    expect(calculateCost).toHaveBeenCalledTimes(providers.length)
  })
})
