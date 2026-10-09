import { describe, expect, it } from 'vitest'

import { decodeSchema } from '../src/renderer/src/shared/lib/schema-decoder.js'
import { exportResultSchema } from '../src/shared/schemas/export.js'
import { activeCurrencySchema, currencyOptionSchema, currencyOptionsSchema } from '../src/shared/schemas/fx.js'
import { appVersionSchema, updateStatusSchema } from '../src/shared/schemas/updates.js'

type CurrentSchema = Parameters<typeof decodeSchema>[0]
type ExpectedCase = { input: unknown; output: unknown } | { input: unknown; rejects: true }

function expectCases(schema: CurrentSchema, cases: ReadonlyArray<ExpectedCase>): void {
  for (const testCase of cases) {
    const result = decodeSchema(schema, testCase.input)
    if ('rejects' in testCase) {
      expect(result.ok, `rejection for ${String(testCase.input)}`).toBe(false)
    } else {
      expect(result.ok, `acceptance for ${String(testCase.input)}`).toBe(true)
      if (result.ok) expect(result.value).toStrictEqual(testCase.output)
    }
  }
}

const validCurrency = { code: 'EUR', symbol: '€', rate: 0.9 }
const validUpdateStatus = {
  currentVersion: '1.2.3',
  latestVersion: '1.2.4',
  updateAvailable: true,
  tag: 'v1.2.4',
}

describe('leaf wire schemas retain the prior decoded contract', () => {
  it('preserves active-currency verdicts and decoded values', () => {
    expectCases(activeCurrencySchema, [
      { input: validCurrency, output: validCurrency },
      {
        input: { ...validCurrency, updatedAt: '2026-10-01T00:00:00.000Z' },
        output: { ...validCurrency, updatedAt: '2026-10-01T00:00:00.000Z' },
      },
      { input: { ...validCurrency, updatedAt: undefined }, output: { ...validCurrency, updatedAt: undefined } },
      { input: { ...validCurrency, extra: true }, output: validCurrency },
      { input: { code: 'EUR', symbol: '€', rate: -0 }, output: { code: 'EUR', symbol: '€', rate: -0 } },
      {
        input: { code: 'EUR', symbol: '€', rate: Number.MAX_VALUE },
        output: { code: 'EUR', symbol: '€', rate: Number.MAX_VALUE },
      },
      {
        input: { code: 'EUR', symbol: '€', rate: Number.MIN_VALUE },
        output: { code: 'EUR', symbol: '€', rate: Number.MIN_VALUE },
      },
      { input: { ...validCurrency, code: undefined }, rejects: true },
      { input: { ...validCurrency, code: null }, rejects: true },
      { input: { ...validCurrency, symbol: 1 }, rejects: true },
      { input: { ...validCurrency, rate: undefined }, rejects: true },
      { input: { ...validCurrency, rate: null }, rejects: true },
      { input: { ...validCurrency, rate: Number.NaN }, rejects: true },
      { input: { ...validCurrency, rate: Number.POSITIVE_INFINITY }, rejects: true },
      { input: { ...validCurrency, rate: Number.NEGATIVE_INFINITY }, rejects: true },
      { input: { ...validCurrency, updatedAt: null }, rejects: true },
      { input: null, rejects: true },
      { input: [], rejects: true },
    ])
  })

  it('preserves currency-option and mutable-array verdicts and decoded values', () => {
    expectCases(currencyOptionSchema, [
      { input: { code: 'USD', symbol: '$' }, output: { code: 'USD', symbol: '$' } },
      { input: { code: '', symbol: '' }, output: { code: '', symbol: '' } },
      { input: { code: 'USD', symbol: '$', extra: true }, output: { code: 'USD', symbol: '$' } },
      { input: {}, rejects: true },
      { input: { code: undefined, symbol: '$' }, rejects: true },
      { input: { code: 'USD' }, rejects: true },
      { input: { code: 'USD', symbol: null }, rejects: true },
      { input: { code: 1, symbol: '$' }, rejects: true },
      { input: null, rejects: true },
      { input: [], rejects: true },
    ])
    expectCases(currencyOptionsSchema, [
      {
        input: [
          { code: 'EUR', symbol: '€', extension: 1 },
          { code: 'USD', symbol: '$' },
        ],
        output: [
          { code: 'EUR', symbol: '€' },
          { code: 'USD', symbol: '$' },
        ],
      },
      { input: [], output: [] },
      { input: [{ code: 'EUR', symbol: '€', extra: true }], output: [{ code: 'EUR', symbol: '€' }] },
      { input: [{ code: 'EUR' }], rejects: true },
      { input: [{ code: 'EUR', symbol: undefined }], rejects: true },
      { input: [null], rejects: true },
      { input: { code: 'EUR', symbol: '€' }, rejects: true },
      { input: null, rejects: true },
    ])
  })

  it('preserves update-status verdicts with required and nullable fields', () => {
    expectCases(updateStatusSchema, [
      { input: validUpdateStatus, output: validUpdateStatus },
      {
        input: { ...validUpdateStatus, latestVersion: null, tag: null },
        output: { ...validUpdateStatus, latestVersion: null, tag: null },
      },
      { input: { ...validUpdateStatus, extra: true }, output: validUpdateStatus },
      { input: { ...validUpdateStatus, currentVersion: undefined }, rejects: true },
      { input: { ...validUpdateStatus, currentVersion: null }, rejects: true },
      { input: { ...validUpdateStatus, latestVersion: undefined }, rejects: true },
      { input: { ...validUpdateStatus, latestVersion: 1 }, rejects: true },
      { input: { ...validUpdateStatus, updateAvailable: undefined }, rejects: true },
      { input: { ...validUpdateStatus, updateAvailable: null }, rejects: true },
      { input: { ...validUpdateStatus, updateAvailable: 'true' }, rejects: true },
      { input: { ...validUpdateStatus, tag: undefined }, rejects: true },
      { input: { ...validUpdateStatus, tag: 1 }, rejects: true },
      { input: { currentVersion: '1.2.3', updateAvailable: true, tag: null }, rejects: true },
      { input: null, rejects: true },
      { input: [], rejects: true },
    ])
  })

  it('preserves app-version string verdicts and values', () => {
    expectCases(appVersionSchema, [
      { input: 'desktop/1.2.3', output: 'desktop/1.2.3' },
      { input: '', output: '' },
      { input: 'arbitrary version value', output: 'arbitrary version value' },
      { input: undefined, rejects: true },
      { input: null, rejects: true },
      { input: 123, rejects: true },
      { input: [], rejects: true },
      { input: {}, rejects: true },
    ])
  })

  it('preserves optional export-field verdicts and decoded values', () => {
    expectCases(exportResultSchema, [
      { input: { ok: true }, output: { ok: true } },
      { input: { ok: true, path: '/tmp/export' }, output: { ok: true, path: '/tmp/export' } },
      { input: { ok: false, error: 'denied' }, output: { ok: false, error: 'denied' } },
      { input: { ok: true, path: undefined }, output: { ok: true, path: undefined } },
      { input: { ok: false, error: undefined }, output: { ok: false, error: undefined } },
      {
        input: { ok: true, path: '/tmp/export', error: 'retained' },
        output: { ok: true, path: '/tmp/export', error: 'retained' },
      },
      { input: { ok: false, error: 'denied', extra: true }, output: { ok: false, error: 'denied' } },
      { input: { ok: undefined }, rejects: true },
      { input: { ok: null }, rejects: true },
      { input: { ok: 'true' }, rejects: true },
      { input: { ok: true, path: null }, rejects: true },
      { input: { ok: true, error: 1 }, rejects: true },
      { input: {}, rejects: true },
      { input: null, rejects: true },
    ])
  })
})
