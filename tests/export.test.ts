import { mkdtempSync, readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LedgerStore } from '../src/main/store/ledger.js'
import { buildFixtureReport } from './fixtures/report.js'
import { exportCsv, exportJson } from '../src/main/export.js'

function makeStore(): LedgerStore {
  const dir = mkdtempSync(join(tmpdir(), 'tr-export-'))
  return new LedgerStore(join(dir, 'data.db'))
}

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'tr-export-out-')), 'out')
}

describe('exportJson (ticket 32: carries the selected display currency at export time)', () => {
  it('converts every cost column and records the active currency in the payload', async () => {
    const store = makeStore()
    store.setDisplayCurrency('EUR')
    store.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: new Date().toISOString() })

    const target = await exportJson(buildFixtureReport(), tempPath(), store)
    const data = JSON.parse(readFileSync(target, 'utf-8')) as {
      schema: string
      currency: { code: string; symbol: string; rate: number }
      records: Array<{ cost: number }>
      daily: Array<{ 'Cost (EUR)': number }>
      projects: Array<{ 'Cost (EUR)': number }>
    }

    expect(data.schema).toBe('watchtower.export.v1')
    expect(data.currency).toEqual({ code: 'EUR', symbol: '€', rate: 0.9 })
    // Fixture: one call at $0.42 → €0.378 → rounded to €0.38.
    expect(data.records[0]!.cost).toBe(0.38)
    expect(data.daily[0]!['Cost (EUR)']).toBe(0.38)
    expect(data.projects[0]!['Cost (EUR)']).toBe(0.38)
    store.close()
  })

  it('exports raw USD figures with the USD currency block by default', async () => {
    const store = makeStore()
    const target = await exportJson(buildFixtureReport(), tempPath(), store)
    const data = JSON.parse(readFileSync(target, 'utf-8')) as {
      currency: { code: string; symbol: string; rate: number }
      records: Array<{ cost: number }>
    }
    expect(data.currency).toEqual({ code: 'USD', symbol: '$', rate: 1 })
    expect(data.records[0]!.cost).toBe(0.42)
    store.close()
  })

  it('rounds to zero fraction digits for JPY (¥412 not ¥412.37)', async () => {
    const store = makeStore()
    store.setDisplayCurrency('JPY')
    store.setCurrencyRate({ code: 'JPY', symbol: '¥', rate: 150, updatedAt: new Date().toISOString() })

    const target = await exportJson(buildFixtureReport(), tempPath(), store)
    const data = JSON.parse(readFileSync(target, 'utf-8')) as { records: Array<{ cost: number }> }
    expect(data.records[0]!.cost).toBe(63) // 0.42 × 150 = 63
    store.close()
  })
})

describe('exportCsv (ticket 32: folder of CSVs in the selected display currency)', () => {
  it('writes one-table-per-file with currency-labeled headers and converted values', async () => {
    const store = makeStore()
    store.setDisplayCurrency('EUR')
    store.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: new Date().toISOString() })

    const folder = await exportCsv(buildFixtureReport(), tempPath(), store)

    const files = readdirSync(folder)
    expect(files).toContain('README.txt')
    expect(files).toContain('daily.csv')
    expect(files).toContain('records.csv')
    expect(files).toContain('projects.csv')
    expect(files).toContain('sessions.csv')

    const daily = readFileSync(join(folder, 'daily.csv'), 'utf-8')
    expect(daily).toContain('Cost (EUR)')
    expect(daily).toContain('Saved (EUR)')
    // Converted value: 0.38 for the 0.42 USD fixture row.
    expect(daily).toContain('0.38')

    const readme = readFileSync(join(folder, 'README.txt'), 'utf-8')
    expect(readme).toContain('Currency:  EUR')
    store.close()
  })

  it('labels CSV headers USD and keeps USD figures by default', async () => {
    const store = makeStore()
    const folder = await exportCsv(buildFixtureReport(), tempPath(), store)
    const daily = readFileSync(join(folder, 'daily.csv'), 'utf-8')
    expect(daily).toContain('Cost (USD)')
    expect(daily).toContain('0.42')
    store.close()
  })

  it('refuses to overwrite a directory that is not a previous export', async () => {
    const store = makeStore()
    const dir = mkdtempSync(join(tmpdir(), 'tr-export-guard-'))
    mkdirSync(join(dir, 'occupied'), { recursive: true })
    await expect(exportCsv(buildFixtureReport(), join(dir, 'occupied'), store))
      .rejects.toThrow('no .watchtower-export marker')
    store.close()
  })
})
