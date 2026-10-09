import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  fetchAddModelAlias,
  fetchAppVersion,
  fetchCadence,
  fetchCheckForUpdates,
  fetchClearData,
  fetchCoachHarnesses,
  fetchCoachInspect,
  fetchCoachRun,
  fetchCompare,
  fetchCurrencies,
  fetchCurrency,
  fetchDismissSkill,
  fetchExport,
  fetchLedgerMcpConnection,
  fetchLedgerMcpStatus,
  fetchOptimize,
  fetchOverview,
  fetchPayload,
  fetchPullRequests,
  fetchRefreshPricing,
  fetchRegenerateLedgerMcpToken,
  fetchRemoveModelAlias,
  fetchRemovePriceOverride,
  fetchSaveSkill,
  fetchScan,
  fetchScanStatus,
  fetchSetCadence,
  fetchSetCurrency,
  fetchSetModelPrice,
  fetchSettings,
  fetchSkills,
  fetchSpend,
  fetchViews,
  fetchYield,
  onCoachHarnessesChanged,
  openCoachLoginTerminal,
  parsePayload,
  refreshCoachHarnesses,
} from '../src/renderer/src/shared/lib/api.js'

const scanStatusSchema = Schema.Struct({ scanned: Schema.Boolean })

/** Stub the preload surface for the fetch wrappers' IPC-call sites. The
 * renderer-lib modules themselves never touch `window` at load time — only
 * inside the fetch wrappers — so a test-time global works without jsdom. */
function mockWindow(api: unknown): void {
  vi.stubGlobal('window', { api })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renderer parse seam (ADR 0005)', () => {
  const scope = { period: 'today' } as const
  const pair = { modelA: 'a', modelB: 'b' }
  const thresholds = { frequency: 5, spread: 2 }
  const sectionFetches = [
    { label: 'overview', method: 'getOverview', fetch: () => fetchOverview(scope), args: [scope] },
    { label: 'spend', method: 'getSpend', fetch: () => fetchSpend(scope), args: [scope] },
    { label: 'compare', method: 'getCompare', fetch: () => fetchCompare(scope, pair), args: [scope, pair] },
    { label: 'optimize', method: 'getOptimize', fetch: () => fetchOptimize(scope), args: [scope] },
    { label: 'yield', method: 'getYield', fetch: () => fetchYield(scope), args: [scope] },
    { label: 'pull requests', method: 'getPullRequests', fetch: () => fetchPullRequests(scope), args: [scope] },
    {
      label: 'skills',
      method: 'getSkills',
      fetch: () => fetchSkills(scope, thresholds),
      args: [scope, thresholds],
    },
  ]

  const coachRequest = { harnessKind: 'codex', scope, prompt: 'Review usage.' }
  const commandFetches = [
    {
      label: 'model alias write',
      method: 'addModelAlias',
      fetch: () => fetchAddModelAlias('a', 'b'),
      args: ['a', 'b'],
      value: { ok: true },
    },
    {
      label: 'model alias remove',
      method: 'removeModelAlias',
      fetch: () => fetchRemoveModelAlias('a'),
      args: ['a'],
      value: { ok: true },
    },
    {
      label: 'price write',
      method: 'setModelPrice',
      fetch: () => fetchSetModelPrice('a', 1, 2),
      args: ['a', 1, 2],
      value: { ok: true },
    },
    {
      label: 'price remove',
      method: 'removePriceOverride',
      fetch: () => fetchRemovePriceOverride('a'),
      args: ['a'],
      value: { ok: true },
    },
    { label: 'coach harnesses', method: 'getCoachHarnesses', fetch: () => fetchCoachHarnesses(), args: [], value: [] },
    {
      label: 'coach harnesses refresh',
      method: 'refreshCoachHarnesses',
      fetch: () => refreshCoachHarnesses(),
      args: [],
      value: [],
    },
    {
      label: 'coach login terminal',
      method: 'openCoachLoginTerminal',
      fetch: () => openCoachLoginTerminal('codex'),
      args: ['codex'],
      value: { ok: true },
    },
    {
      label: 'coach inspect',
      method: 'inspectCoachHarness',
      fetch: () => fetchCoachInspect('codex'),
      args: ['codex'],
      value: { ok: true },
    },
    {
      label: 'coach run',
      method: 'startCoachRun',
      fetch: () => fetchCoachRun(coachRequest),
      args: [coachRequest],
      value: { ok: true, runId: 'run-1' },
    },
  ]

  it.each(commandFetches)('decodes $label and preserves IPC arguments', async row => {
    const invoke = vi.fn().mockResolvedValue(row.value)
    mockWindow({ [row.method]: invoke })
    expect(await row.fetch()).toStrictEqual({ ok: true, data: row.value })
    expect(invoke).toHaveBeenCalledExactlyOnceWith(...row.args)
  })

  it.each(commandFetches)('rejects malformed $label payloads', async row => {
    mockWindow({ [row.method]: () => Promise.resolve(null) })
    const result = await row.fetch()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain(`Invalid ${row.label} payload`)
  })

  it('decodes harness broadcasts and retains subscription ownership', () => {
    const callback = vi.fn()
    const unsubscribe = vi.fn()
    const listeners: Array<(payload: unknown) => void> = []
    mockWindow({
      onCoachHarnessesChanged: (listener: (payload: unknown) => void) => {
        listeners.push(listener)
        return unsubscribe
      },
    })
    const teardown = onCoachHarnessesChanged(callback)
    const harness = {
      instanceId: 'codex',
      kind: 'codex',
      displayName: 'Codex',
      status: 'ready',
      auth: { status: 'configured' },
    }
    listeners[0]!([{ ...harness, extra: 'discarded', auth: { ...harness.auth, extra: 'discarded' } }])
    expect(callback).toHaveBeenCalledExactlyOnceWith([harness])
    listeners[0]!([{ ...harness, status: 'invalid' }])
    expect(callback).toHaveBeenCalledTimes(1)
    teardown()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it.each(sectionFetches)('accepts a null $label payload and preserves IPC arguments', async row => {
    const invoke = vi.fn().mockResolvedValue(null)
    mockWindow({ [row.method]: invoke })
    expect(await row.fetch()).toStrictEqual({ ok: true, data: null })
    expect(invoke).toHaveBeenCalledExactlyOnceWith(...row.args)
  })

  it.each(sectionFetches)('rejects a malformed $label payload with its channel label', async row => {
    mockWindow({ [row.method]: () => Promise.resolve(42) })
    const result = await row.fetch()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain(`Invalid ${row.label} payload`)
  })

  it('decodes Skills command results and preserves request arguments', async () => {
    const dismissRequest = { source: 'skill', name: 'unused', reason: 'irrelevant' } as const
    const saveRequest = { name: 'review', content: 'Review changes.' }
    const dismissSkill = vi.fn().mockResolvedValue({ ok: true, extra: 'stripped' })
    const saveSkill = vi.fn().mockResolvedValue({ ok: false, error: 'cancelled', extra: 'stripped' })
    mockWindow({ dismissSkill, saveSkill })

    expect(await fetchDismissSkill(dismissRequest)).toStrictEqual({ ok: true, data: { ok: true } })
    expect(await fetchSaveSkill(saveRequest)).toStrictEqual({ ok: true, data: { ok: false, error: 'cancelled' } })
    expect(dismissSkill).toHaveBeenCalledExactlyOnceWith(dismissRequest)
    expect(saveSkill).toHaveBeenCalledExactlyOnceWith(saveRequest)
  })

  it('rejects malformed Skills command results', async () => {
    mockWindow({
      dismissSkill: () => Promise.resolve({ ok: 'true' }),
      saveSkill: () => Promise.resolve({ ok: true, path: null }),
    })
    expect((await fetchDismissSkill({ source: 'tool', name: 'unused', reason: '' })).ok).toBe(false)
    expect((await fetchSaveSkill({ name: 'review', content: '' })).ok).toBe(false)
  })

  it('parsePayload passes a valid payload through untouched', () => {
    const result = parsePayload(scanStatusSchema, 'scan status', { scanned: true })
    expect(result).toEqual({ ok: true, data: { scanned: true } })
  })

  it('parsePayload names the channel and failing field on a bad payload', () => {
    const result = parsePayload(scanStatusSchema, 'scan status', { scanned: 'nope' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid scan status payload/)
      expect(result.error).toMatch(/scanned/)
    }
  })

  it('fetchPayload turns an IPC rejection into an error state, never a throw', async () => {
    const result = await fetchPayload('scan status', scanStatusSchema, () => Promise.reject(new Error('boom')))
    expect(result).toEqual({ ok: false, error: 'boom' })
  })

  it('fetchScanStatus trips on a schema-invalid window.api payload', async () => {
    mockWindow({ getScanStatus: () => Promise.resolve({ scanned: 'yes' }) })
    const result = await fetchScanStatus()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid scan status payload/)
    }
  })

  it('fetchScanStatus passes a schema-valid payload through', async () => {
    mockWindow({ getScanStatus: () => Promise.resolve({ scanned: true }) })
    const result = await fetchScanStatus()
    expect(result).toEqual({ ok: true, data: { scanned: true } })
  })

  it('decodes scan, settings, pricing, and ledger MCP fetches through Effect schemas', async () => {
    const scanOptions = { provider: 'claude' }
    const calls: unknown[][] = []
    const settings = { dataDir: '/data', dbSize: 1, dataDirSize: 2, cacheDir: '/cache', cacheSize: 3 }
    const status = { startupMode: 'on-demand', running: false, url: null }
    mockWindow({
      scan: (options: unknown) => {
        calls.push(['scan', options])
        return Promise.resolve({ ok: true, alreadyRunning: false })
      },
      getSettings: () => Promise.resolve(settings),
      clearData: () => Promise.resolve(settings),
      refreshPricing: () => Promise.resolve({ ok: false, error: 'offline' }),
      getLedgerMcpStatus: () => Promise.resolve(status),
      getLedgerMcpConnection: () => Promise.resolve({ url: 'http://localhost:1234', config: '{}' }),
      regenerateLedgerMcpToken: () => Promise.resolve(status),
    })

    expect(await fetchScan(scanOptions)).toEqual({ ok: true, data: { ok: true, alreadyRunning: false } })
    expect(await fetchSettings()).toEqual({ ok: true, data: settings })
    expect(await fetchClearData()).toEqual({ ok: true, data: settings })
    expect(await fetchRefreshPricing()).toEqual({ ok: true, data: { ok: false, error: 'offline' } })
    expect(await fetchLedgerMcpStatus()).toEqual({ ok: true, data: status })
    expect(await fetchLedgerMcpConnection()).toEqual({
      ok: true,
      data: { url: 'http://localhost:1234', config: '{}' },
    })
    expect(await fetchRegenerateLedgerMcpToken()).toEqual({ ok: true, data: status })
    expect(calls).toEqual([['scan', scanOptions]])
  })

  it('keeps labels for malformed migrated settings and ledger MCP payloads', async () => {
    mockWindow({
      getSettings: () => Promise.resolve({ dataDir: '/data', dbSize: '1' }),
      getLedgerMcpStatus: () => Promise.resolve({ startupMode: 'sometimes', running: false, url: null }),
    })
    expect(await fetchSettings()).toEqual({
      ok: false,
      error: 'Invalid settings payload (dbSize: has an unexpected type)',
    })
    expect(await fetchLedgerMcpStatus()).toEqual({
      ok: false,
      error: 'Invalid ledger MCP status payload (startupMode: does not match the expected shape)',
    })
  })

  it('fetchViews accepts a null payload (a valid nullable view)', async () => {
    mockWindow({ getViews: () => Promise.resolve(null) })
    const result = await fetchViews()
    expect(result).toEqual({ ok: true, data: null })
  })

  it('cadence get and set wrappers reject non-string IPC values', async () => {
    mockWindow({ getCadence: () => Promise.resolve(5), setCadence: () => Promise.resolve(null) })

    const getResult = await fetchCadence()
    const setResult = await fetchSetCadence('anything')

    expect(getResult).toEqual({
      ok: false,
      error: 'Invalid cadence payload (payload: has an unexpected type)',
    })
    expect(setResult).toEqual({
      ok: false,
      error: 'Invalid cadence payload (payload: has an unexpected type)',
    })
  })

  it('decodes all migrated wire fetches without changing their labels or IPC arguments', async () => {
    const calls: unknown[][] = []
    mockWindow({
      checkForUpdates: () =>
        Promise.resolve({ currentVersion: '1.0', latestVersion: null, updateAvailable: false, tag: null }),
      getCurrency: () => Promise.resolve({ code: 'EUR', symbol: '€', rate: 0.9 }),
      setCurrency: (code: string) => {
        calls.push(['setCurrency', code])
        return Promise.resolve({ code, symbol: '€', rate: 0.9 })
      },
      getCurrencies: () =>
        Promise.resolve([
          { code: 'EUR', symbol: '€' },
          { code: 'USD', symbol: '$' },
        ]),
      getAppVersion: () => Promise.resolve('1.0.0'),
      exportData: (format: string, destination?: string) => {
        calls.push(['exportData', format, destination])
        return Promise.resolve({ ok: true, path: '/tmp/export' })
      },
    })

    expect(await fetchCheckForUpdates()).toEqual({
      ok: true,
      data: {
        currentVersion: '1.0',
        latestVersion: null,
        updateAvailable: false,
        tag: null,
      },
    })
    expect(await fetchCurrency()).toEqual({ ok: true, data: { code: 'EUR', symbol: '€', rate: 0.9 } })
    expect(await fetchSetCurrency('EUR')).toEqual({ ok: true, data: { code: 'EUR', symbol: '€', rate: 0.9 } })
    expect(await fetchCurrencies()).toEqual({
      ok: true,
      data: [
        { code: 'EUR', symbol: '€' },
        { code: 'USD', symbol: '$' },
      ],
    })
    expect(await fetchAppVersion()).toEqual({ ok: true, data: '1.0.0' })
    expect(await fetchExport('csv', '/tmp/export')).toEqual({ ok: true, data: { ok: true, path: '/tmp/export' } })
    expect(calls).toEqual([
      ['setCurrency', 'EUR'],
      ['exportData', 'csv', '/tmp/export'],
    ])
  })

  it('keeps channel labels for malformed migrated IPC payloads and rejected calls', async () => {
    mockWindow({
      checkForUpdates: () => Promise.resolve({ currentVersion: 1 }),
      getCurrency: () => Promise.resolve({ code: 'EUR', symbol: '€', rate: Number.NaN }),
      setCurrency: () => Promise.reject(new Error('currency IPC failed')),
      getCurrencies: () => Promise.resolve({ code: 'EUR', symbol: '€' }),
      getAppVersion: () => Promise.resolve(1),
      exportData: () => Promise.resolve({ ok: true, path: null }),
    })

    expect((await fetchCheckForUpdates()).ok).toBe(false)
    expect(await fetchCurrency()).toEqual({
      ok: false,
      error: 'Invalid currency payload (rate: has an invalid value)',
    })
    expect(await fetchSetCurrency('EUR')).toEqual({ ok: false, error: 'currency IPC failed' })
    expect((await fetchCurrencies()).ok).toBe(false)
    expect((await fetchAppVersion()).ok).toBe(false)
    expect((await fetchExport('json')).ok).toBe(false)
  })
})
