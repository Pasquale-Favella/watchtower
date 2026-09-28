import { mkdtempSync, readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import { FxRates } from '../src/main/fx.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import { buildProjectsFromLedger } from '../src/main/views.js'
import { buildFixtureReport } from './fixtures/report.js'
import { buildFixtureCachedFile, FIXTURE_SOURCE_PATH } from './fixtures/cached-file.js'
import { exportCsv, exportJson } from '../src/main/export.js'

function makeStore(): LedgerStore {
  const dir = mkdtempSync(join(tmpdir(), 'tr-export-'))
  return new LedgerStore(join(dir, 'data.db'))
}

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'tr-export-out-')), 'out')
}

/** Display-currency pin through the `FxRates` port (ADR 0032, Wave-6 pin):
 * same persisted value as the old direct store write — the store-backed
 * layer delegates to `LedgerStore`, so sanitization is unchanged. */
function pinDisplayCurrency(store: LedgerStore, code: string): void {
  Effect.runSync(
    Effect.flatMap(FxRates, rates => rates.setDisplayCurrency(code)).pipe(
      Effect.provide(FxRates.layerWithStore(store)),
    ),
  )
}

describe('exportJson (ADR 0009: carries the selected display currency at export time)', () => {
  it('converts every cost column and records the active currency in the payload', async () => {
    const store = makeStore()
    pinDisplayCurrency(store, 'EUR')
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
    pinDisplayCurrency(store, 'JPY')
    store.setCurrencyRate({ code: 'JPY', symbol: '¥', rate: 150, updatedAt: new Date().toISOString() })

    const target = await exportJson(buildFixtureReport(), tempPath(), store)
    const data = JSON.parse(readFileSync(target, 'utf-8')) as { records: Array<{ cost: number }> }
    expect(data.records[0]!.cost).toBe(63) // 0.42 × 150 = 63
    store.close()
  })
})

describe('exportCsv (ADR 0009: folder of CSVs in the selected display currency)', () => {
  it('writes one-table-per-file with currency-labeled headers and converted values', async () => {
    const store = makeStore()
    pinDisplayCurrency(store, 'EUR')
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
    await expect(exportCsv(buildFixtureReport(), join(dir, 'occupied'), store)).rejects.toThrow(
      'no .watchtower-export marker',
    )
    store.close()
  })
})

describe('export git info (repoUrl in projects/sessions/records)', () => {
  const REPO = 'git@github.com:acme/demo.git'

  it('carries the raw repoUrl through projects/sessions/records in JSON', async () => {
    const store = makeStore()
    const report = buildFixtureReport()
    report[0]!.repoUrl = REPO
    report[0]!.sessions[0]!.repoUrl = REPO

    const target = await exportJson(report, tempPath(), store)
    const data = JSON.parse(readFileSync(target, 'utf-8')) as {
      projects: Array<{ repoUrl?: string }>
      sessions: Array<{ repoUrl?: string }>
      records: Array<{ repoUrl?: string }>
    }

    expect(data.projects[0]!.repoUrl).toBe(REPO)
    expect(data.sessions[0]!.repoUrl).toBe(REPO)
    expect(data.records[0]!.repoUrl).toBe(REPO)
    store.close()
  })

  it('omits repoUrl in JSON and leaves the CSV cell empty when the project is not a git checkout', async () => {
    const store = makeStore()
    const target = await exportJson(buildFixtureReport(), tempPath(), store)
    const data = JSON.parse(readFileSync(target, 'utf-8')) as {
      projects: Array<Record<string, unknown>>
      sessions: Array<Record<string, unknown>>
      records: Array<Record<string, unknown>>
    }
    expect('repoUrl' in data.projects[0]!).toBe(false)
    expect('repoUrl' in data.sessions[0]!).toBe(false)
    expect('repoUrl' in data.records[0]!).toBe(false)

    const folder = await exportCsv(buildFixtureReport(), tempPath(), store)
    const projectsCsv = readFileSync(join(folder, 'projects.csv'), 'utf-8')
    const header = projectsCsv.split('\n')[0]!
    expect(header).toContain('repoUrl')
    expect(projectsCsv).not.toContain('github.com')
    store.close()
  })

  it('populates repoUrl from ledger_source on the real export path', async () => {
    const store = makeStore()
    store.portIn({
      provider: 'opencode',
      envFingerprint: 'env-demo',
      filePath: FIXTURE_SOURCE_PATH,
      verdict: 'new',
      cachedFile: buildFixtureCachedFile(),
      repoUrl: 'https://github.com/acme/demo-project',
    })

    const projects = buildProjectsFromLedger(store)
    expect(projects[0]!.repoUrl).toBe('https://github.com/acme/demo-project')
    expect(projects[0]!.sessions[0]!.repoUrl).toBe('https://github.com/acme/demo-project')

    const target = await exportJson(projects, tempPath(), store)
    const data = JSON.parse(readFileSync(target, 'utf-8')) as {
      projects: Array<{ repoUrl?: string }>
      records: Array<{ repoUrl?: string }>
    }
    expect(data.projects[0]!.repoUrl).toBe('https://github.com/acme/demo-project')
    expect(data.records[0]!.repoUrl).toBe('https://github.com/acme/demo-project')

    const folder = await exportCsv(projects, tempPath(), store)
    expect(readFileSync(join(folder, 'projects.csv'), 'utf-8')).toContain('https://github.com/acme/demo-project')
    expect(readFileSync(join(folder, 'sessions.csv'), 'utf-8')).toContain('https://github.com/acme/demo-project')
    expect(readFileSync(join(folder, 'records.csv'), 'utf-8')).toContain('https://github.com/acme/demo-project')
    store.close()
  })
})
