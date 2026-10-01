import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  fetchAppVersion,
  fetchCadence,
  fetchCheckForUpdates,
  fetchCurrencies,
  fetchCurrency,
  fetchExport,
  fetchPayload,
  fetchScanStatus,
  fetchSetCadence,
  fetchSetCurrency,
  fetchViews,
  parsePayload,
} from '../src/renderer/src/shared/lib/api.js'
import { zodDecoder } from '../src/renderer/src/shared/lib/schema-decoder.js'

const scanStatusSchema = z.object({ scanned: z.boolean() })

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
  it('parsePayload passes a valid payload through untouched', () => {
    const result = parsePayload(zodDecoder(scanStatusSchema), 'scan status', { scanned: true })
    expect(result).toEqual({ ok: true, data: { scanned: true } })
  })

  it('parsePayload names the channel and failing field on a bad payload', () => {
    const result = parsePayload(zodDecoder(scanStatusSchema), 'scan status', { scanned: 'nope' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/Invalid scan status payload/)
      expect(result.error).toMatch(/scanned/)
    }
  })

  it('fetchPayload turns an IPC rejection into an error state, never a throw', async () => {
    const result = await fetchPayload('scan status', zodDecoder(scanStatusSchema), () =>
      Promise.reject(new Error('boom')),
    )
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
