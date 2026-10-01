import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { effectSchemaDecoder } from '../src/renderer/src/shared/lib/schema-decoder.js'
import { exportResultSchema } from '../src/shared/schemas/export.js'
import { activeCurrencySchema, currencyOptionSchema, currencyOptionsSchema } from '../src/shared/schemas/fx.js'
import { appVersionSchema, updateStatusSchema } from '../src/shared/schemas/updates.js'

// Frozen copies of the pre-migration contracts. Replace these definitions with
// golden fixtures after the final Watchtower-owned Zod import and direct
// dependency are removed.
const priorContracts = {
  activeCurrency: z.object({
    code: z.string(),
    symbol: z.string(),
    rate: z.number(),
    updatedAt: z.string().optional(),
  }),
  currencyOption: z.object({ code: z.string(), symbol: z.string() }),
  updateStatus: z.object({
    currentVersion: z.string(),
    latestVersion: z.string().nullable(),
    updateAvailable: z.boolean(),
    tag: z.string().nullable(),
  }),
  appVersion: z.string(),
  exportResult: z.object({
    ok: z.boolean(),
    path: z.string().optional(),
    error: z.string().optional(),
  }),
}

const validCurrency = { code: 'EUR', symbol: '€', rate: 0.9 }
const validUpdateStatus = {
  currentVersion: '1.2.3',
  latestVersion: '1.2.4',
  updateAvailable: true,
  tag: 'v1.2.4',
}

describe('leaf wire schemas retain the prior Zod contract', () => {
  it('matches verdicts and decoded values across the active-currency contract', () => {
    const corpus: unknown[] = [
      validCurrency,
      { ...validCurrency, updatedAt: '2026-10-01T00:00:00.000Z' },
      { ...validCurrency, updatedAt: undefined },
      { ...validCurrency, extra: true },
      { code: 'EUR', symbol: '€', rate: -0 },
      { code: 'EUR', symbol: '€', rate: Number.MAX_VALUE },
      { code: 'EUR', symbol: '€', rate: Number.MIN_VALUE },
      { ...validCurrency, code: undefined },
      { ...validCurrency, code: null },
      { ...validCurrency, symbol: 1 },
      { ...validCurrency, rate: undefined },
      { ...validCurrency, rate: null },
      { ...validCurrency, rate: Number.NaN },
      { ...validCurrency, rate: Number.POSITIVE_INFINITY },
      { ...validCurrency, rate: Number.NEGATIVE_INFINITY },
      { ...validCurrency, updatedAt: null },
      null,
      [],
    ]

    expectParity(priorContracts.activeCurrency, activeCurrencySchema, corpus)
  })

  it('matches verdicts and decoded values across currency options and their mutable array', () => {
    const optionCorpus: unknown[] = [
      { code: 'USD', symbol: '$' },
      { code: '', symbol: '' },
      { code: 'USD', symbol: '$', extra: true },
      {},
      { code: undefined, symbol: '$' },
      { code: 'USD' },
      { code: 'USD', symbol: null },
      { code: 1, symbol: '$' },
      null,
      [],
    ]
    expectParity(priorContracts.currencyOption, currencyOptionSchema, optionCorpus)

    const arrayCorpus: unknown[] = [
      [
        { code: 'EUR', symbol: '€', extension: 1 },
        { code: 'USD', symbol: '$' },
      ],
      [],
      [{ code: 'EUR', symbol: '€', extra: true }],
      [{ code: 'EUR' }],
      [{ code: 'EUR', symbol: undefined }],
      [null],
      { code: 'EUR', symbol: '€' },
      null,
    ]
    expectParity(z.array(priorContracts.currencyOption), currencyOptionsSchema, arrayCorpus)
  })

  it('matches verdicts and decoded values for update status required and nullable fields', () => {
    const corpus: unknown[] = [
      validUpdateStatus,
      { ...validUpdateStatus, latestVersion: null, tag: null },
      { ...validUpdateStatus, extra: true },
      { ...validUpdateStatus, currentVersion: undefined },
      { ...validUpdateStatus, currentVersion: null },
      { ...validUpdateStatus, latestVersion: undefined },
      { ...validUpdateStatus, latestVersion: 1 },
      { ...validUpdateStatus, updateAvailable: undefined },
      { ...validUpdateStatus, updateAvailable: null },
      { ...validUpdateStatus, updateAvailable: 'true' },
      { ...validUpdateStatus, tag: undefined },
      { ...validUpdateStatus, tag: 1 },
      { currentVersion: '1.2.3', updateAvailable: true, tag: null },
      null,
      [],
    ]

    expectParity(priorContracts.updateStatus, updateStatusSchema, corpus)
  })

  it('matches verdicts and decoded values for app-version strings', () => {
    const corpus: unknown[] = ['desktop/1.2.3', '', 'arbitrary version value', undefined, null, 123, [], {}]

    expectParity(priorContracts.appVersion, appVersionSchema, corpus)
  })

  it('matches verdicts and decoded values for optional export fields', () => {
    const corpus: unknown[] = [
      { ok: true },
      { ok: true, path: '/tmp/export' },
      { ok: false, error: 'denied' },
      { ok: true, path: undefined },
      { ok: false, error: undefined },
      { ok: true, path: '/tmp/export', error: 'retained' },
      { ok: false, error: 'denied', extra: true },
      { ok: undefined },
      { ok: null },
      { ok: 'true' },
      { ok: true, path: null },
      { ok: true, error: 1 },
      {},
      null,
    ]

    expectParity(priorContracts.exportResult, exportResultSchema, corpus)
  })
})

function expectParity(
  priorSchema: z.ZodType,
  currentSchema: Parameters<typeof effectSchemaDecoder>[0],
  corpus: ReadonlyArray<unknown>,
): void {
  for (const input of corpus) {
    const prior = priorSchema.safeParse(input)
    const current = effectSchemaDecoder(currentSchema)(input)

    expect(current.ok, `verdict for ${JSON.stringify(input)}`).toBe(prior.success)
    if (prior.success && current.ok) {
      expect(current.value, `decoded output for ${JSON.stringify(input)}`).toStrictEqual(prior.data)
    }
  }
}
