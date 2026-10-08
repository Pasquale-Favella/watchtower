import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { describe, expect, it, vi } from 'vitest'

import { queryExport } from '../src/main/application/export-query.js'
import { exportCsv, exportJson } from '../src/main/export.js'
import { buildCsvExportFiles, buildJsonExport } from '../src/main/export-calculation.js'
import { FxRates } from '../src/main/fx.js'
import { capturePricingCatalogue } from '../src/main/pipeline/pricing-calculation.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import { LedgerIngest } from '../src/main/store/ledger-ports.js'
import { buildFixtureCachedFile, FIXTURE_SOURCE_PATH } from './fixtures/cached-file.js'
import { openLedgerFixture } from './fixtures/ledger-runtime.js'

const GENERATED = '2026-07-14T12:34:56.000Z'
const USD = { code: 'USD', symbol: '$', rate: 1 } as const
import { buildFixtureReport } from './fixtures/report.js'

function makeStore(): LedgerStore {
  const dir = mkdtempSync(join(tmpdir(), 'tr-export-'))
  return new LedgerStore(join(dir, 'data.db'))
}

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'tr-export-out-')), 'out')
}

/** Display-currency pin through the `FxRates` port (ADR 0032, Wave-6 pin):
 * same persisted value as the old direct store write — the repository-direct
 * layer sanitizes the code in `fx.ts`, so the stored result is unchanged. */
function pinDisplayCurrency(store: LedgerStore, code: string): void {
  Effect.runSync(
    Effect.flatMap(FxRates, rates => rates.setDisplayCurrency(code)).pipe(
      Effect.provide(FxRates.layerWithRepository(store)),
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

describe('pure export serialization', () => {
  it('keeps the literal CSV table set, headers, values, escaping and JSON contract', () => {
    const projects = buildFixtureReport()
    const files = buildCsvExportFiles(projects, USD, GENERATED)
    expect(files.map(file => file.name)).toEqual([
      'README.txt',
      'daily.csv',
      'activity.csv',
      'models.csv',
      'records.csv',
      'projects.csv',
      'sessions.csv',
      'tools.csv',
      'mcp.csv',
      'shell-commands.csv',
    ])
    expect(Object.fromEntries(files.map(file => [file.name, file.contents]))).toEqual({
      'README.txt': [
        'Watchtower Usage Export',
        '========================',
        '',
        `Generated: ${GENERATED}`,
        'Currency:  USD',
        '',
        'Files',
        '-----',
        '  daily.csv             Day-by-day breakdown.',
        '  activity.csv          Time spent per task category (Coding, Debugging, Exploration, etc.).',
        '  models.csv            Spend per model with token totals and cache usage.',
        '  records.csv           One row per API call.',
        '  projects.csv          Spend per project folder.',
        '  sessions.csv          One row per session.',
        '  tools.csv             Tool invocations and share.',
        '  mcp.csv               MCP server invocations and share.',
        '  shell-commands.csv    Shell commands executed via Bash tool.',
        '',
        'Notes',
        '-----',
        '  Every cost column is already converted to the active currency (USD). Tokens are raw',
        '  integer counts from provider telemetry. Share (%) is relative to the table total.',
        '  repoUrl is the git origin URL when the project path is a git checkout with a',
        '  configured origin, otherwise empty (CSV) / absent (JSON).',
        '',
      ].join('\n'),
      'daily.csv':
        'Date,Cost (USD),Saved (USD),API Calls,Sessions,Input Tokens,Output Tokens,Cache Read Tokens,Cache Write Tokens\n' +
        '2026-07-01,0.42,0,1,1,100,50,20,0\n',
      'activity.csv':
        'Activity,Cost (USD),Share (%),Turns\n' +
        'Coding,0.42,100,1\n' +
        'Debugging,0,0,0\nFeature Dev,0,0,0\nRefactoring,0,0,0\nTesting,0,0,0\nExploration,0,0,0\n' +
        'Planning,0,0,0\nDelegation,0,0,0\nGit Ops,0,0,0\nBuild/Deploy,0,0,0\nConversation,0,0,0\nBrainstorming,0,0,0\nGeneral,0,0,0\n',
      'models.csv':
        'Model,Cost (USD),Saved (USD),Share (%),API Calls,Input Tokens,Output Tokens,Cache Read Tokens,Cache Write Tokens\n' +
        'demo-model,0.42,0,100,1,100,50,20,0\n',
      'records.csv':
        'project,repoUrl,sessionId,timestamp,category,provider,model,inputTokens,outputTokens,reasoningTokens,cacheWriteTokens,cacheReadTokens,cost,savings\n' +
        '/tmp/demo,,sess-0,2026-07-01T10:00:00.000Z,coding,opencode,demo-model,100,50,5,0,20,0.42,0\n',
      'projects.csv':
        'Project,repoUrl,Cost (USD),Saved (USD),Avg/Session (USD),Share (%),API Calls,Sessions\n' +
        '/tmp/demo,,0.42,0,0.42,100,1,1\n',
      'sessions.csv':
        'Project,repoUrl,Session ID,Started At,Cost (USD),Saved (USD),API Calls,Turns,model\n' +
        '/tmp/demo,,sess-0,2026-07-01T09:00:00.000Z,0.42,0,1,1,demo-model\n',
      'tools.csv': 'Tool,Calls,Share (%)\nbash,1,100\n',
      'mcp.csv': '',
      'shell-commands.csv': 'Command,Calls,Share (%)\nls,1,100\n',
    })

    const json = JSON.parse(buildJsonExport(projects, USD, GENERATED)) as Record<string, unknown>
    expect(json).toEqual({
      schema: 'watchtower.export.v1',
      generated: GENERATED,
      currency: { code: 'USD', symbol: '$', rate: 1 },
      daily: [
        {
          Date: '2026-07-01',
          'Cost (USD)': 0.42,
          'Saved (USD)': 0,
          'API Calls': 1,
          Sessions: 1,
          'Input Tokens': 100,
          'Output Tokens': 50,
          'Cache Read Tokens': 20,
          'Cache Write Tokens': 0,
        },
      ],
      activity: expect.any(Array),
      models: [
        {
          Model: 'demo-model',
          'Cost (USD)': 0.42,
          'Saved (USD)': 0,
          'Share (%)': 100,
          'API Calls': 1,
          'Input Tokens': 100,
          'Output Tokens': 50,
          'Cache Read Tokens': 20,
          'Cache Write Tokens': 0,
        },
      ],
      projects: [
        {
          Project: '/tmp/demo',
          'Cost (USD)': 0.42,
          'Saved (USD)': 0,
          'Avg/Session (USD)': 0.42,
          'Share (%)': 100,
          'API Calls': 1,
          Sessions: 1,
        },
      ],
      sessions: [
        {
          Project: '/tmp/demo',
          'Session ID': 'sess-0',
          'Started At': '2026-07-01T09:00:00.000Z',
          'Cost (USD)': 0.42,
          'Saved (USD)': 0,
          'API Calls': 1,
          Turns: 1,
          model: 'demo-model',
        },
      ],
      records: [
        {
          project: '/tmp/demo',
          sessionId: 'sess-0',
          timestamp: '2026-07-01T10:00:00.000Z',
          category: 'coding',
          provider: 'opencode',
          model: 'demo-model',
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 5,
          cacheWriteTokens: 0,
          cacheReadTokens: 20,
          cost: 0.42,
          savings: 0,
        },
      ],
      tools: [{ Tool: 'bash', Calls: 1, 'Share (%)': 100 }],
      mcp: [],
      shellCommands: [{ Command: 'ls', Calls: 1, 'Share (%)': 100 }],
    })

    const call = projects[0]?.sessions[0]?.turns[0]?.assistantCalls[0]
    if (!call) throw new Error('fixture call missing')
    call.model = '=SUM(1,2)'
    expect(buildCsvExportFiles(projects, USD, GENERATED).find(file => file.name === 'records.csv')?.contents).toContain(
      '"\'=SUM(1,2)"',
    )
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
    await expect(exportCsv(buildFixtureReport(), join(dir, 'occupied'), store)).rejects.toMatchObject({
      reason: 'csv-unmarked-directory',
    })
    store.close()
  })

  it('captures the currency once before compatibility export file work', async () => {
    const store = makeStore()
    pinDisplayCurrency(store, 'EUR')
    store.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: new Date().toISOString() })
    const displayRead = vi.spyOn(store, 'getDisplayCurrency')
    const rateRead = vi.spyOn(store, 'getCurrencyRate')

    await exportJson(buildFixtureReport(), tempPath(), store)

    expect(displayRead).toHaveBeenCalledTimes(1)
    expect(rateRead).toHaveBeenCalledTimes(1)
    expect(rateRead).toHaveBeenCalledWith('EUR')
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
    const { runtime } = openLedgerFixture()
    runtime.runSync(
      Effect.flatMap(LedgerIngest, ingest =>
        ingest.portIn({
          provider: 'opencode',
          envFingerprint: 'env-demo',
          filePath: FIXTURE_SOURCE_PATH,
          verdict: 'new',
          cachedFile: buildFixtureCachedFile(),
          repoUrl: 'https://github.com/acme/demo-project',
        }),
      ),
    )

    const queryInput = {
      outputPath: tempPath(),
      catalogue: capturePricingCatalogue({
        prices: new Map(),
        overrides: new Map(),
        builtinAliases: {},
        userAliases: {},
        tiers: [],
        routedSegments: new Set(),
      }),
      proxyPaths: { paths: [], caseSensitive: false },
    }
    const jsonResult = await runtime.runPromise(queryExport({ ...queryInput, kind: 'json' }))
    expect(jsonResult.ok).toBe(true)
    if (!jsonResult.ok) throw new Error(jsonResult.error)
    if (!jsonResult.path) throw new Error('JSON export did not return a path')
    const target = jsonResult.path
    const data = JSON.parse(readFileSync(target, 'utf-8')) as {
      projects: Array<{ repoUrl?: string }>
      records: Array<{ repoUrl?: string }>
    }
    expect(data.projects[0]!.repoUrl).toBe('https://github.com/acme/demo-project')
    expect(data.records[0]!.repoUrl).toBe('https://github.com/acme/demo-project')

    const csvResult = await runtime.runPromise(queryExport({ ...queryInput, kind: 'csv' }))
    expect(csvResult.ok).toBe(true)
    if (!csvResult.ok) throw new Error(csvResult.error)
    if (!csvResult.path) throw new Error('CSV export did not return a path')
    const folder = csvResult.path
    expect(readFileSync(join(folder, 'projects.csv'), 'utf-8')).toContain('https://github.com/acme/demo-project')
    expect(readFileSync(join(folder, 'sessions.csv'), 'utf-8')).toContain('https://github.com/acme/demo-project')
    expect(readFileSync(join(folder, 'records.csv'), 'utf-8')).toContain('https://github.com/acme/demo-project')
  })
})
