import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { describe, expect, it, vi } from 'vitest'

import { queryActiveCurrency, selectDisplayCurrency } from '../src/main/application/currency-commands.js'
import { FxRates } from '../src/main/fx.js'
import { initializeLedger } from '../src/main/store/ledger-initialization.js'
import { LedgerConfig } from '../src/main/store/ledger-ports.js'
import { makeWorkerRuntime } from '../src/main/worker-runtime.js'
import type { CurrencyRate } from '../src/shared/schemas/ledger.js'

function fakeRates(overrides: Partial<FxRates['Service']> = {}): FxRates['Service'] {
  return FxRates.of({
    getCurrencyRate: () => Effect.succeed(null),
    setCurrencyRate: () => Effect.void,
    getDisplayCurrency: () => Effect.succeed('USD'),
    setDisplayCurrency: () => Effect.void,
    ...overrides,
  })
}

function ratesLayer(rates: FxRates['Service']): Layer.Layer<FxRates> {
  return Layer.succeed(FxRates, rates)
}

describe('currency application commands', () => {
  it('reads the persisted code and cached rate only, preserving stale rates and the missing-rate fallback', async () => {
    const getCurrencyRate = vi.fn((code: string) =>
      Effect.succeed<CurrencyRate | null>(
        code === 'EUR' ? { code, symbol: 'cached €', rate: 0.87, updatedAt: '2000-01-01T00:00:00.000Z' } : null,
      ),
    )
    const rates = fakeRates({ getDisplayCurrency: () => Effect.succeed('EUR'), getCurrencyRate })

    await expect(Effect.runPromise(queryActiveCurrency().pipe(Effect.provide(ratesLayer(rates))))).resolves.toEqual({
      code: 'EUR',
      symbol: 'cached €',
      rate: 0.87,
      updatedAt: '2000-01-01T00:00:00.000Z',
    })
    expect(getCurrencyRate).toHaveBeenCalledExactlyOnceWith('EUR')

    const noRate = fakeRates({
      getDisplayCurrency: () => Effect.succeed('JPY'),
      getCurrencyRate: vi.fn(() => Effect.succeed(null)),
    })
    await expect(
      Effect.runPromise(queryActiveCurrency().pipe(Effect.provide(ratesLayer(noRate)))),
    ).resolves.toMatchObject({
      code: 'JPY',
      rate: 1,
    })
  })

  it('uses USD for an invalid persisted code and skips the rate lookup for USD', async () => {
    const getCurrencyRate = vi.fn(() => Effect.succeed(null))
    const rates = fakeRates({ getDisplayCurrency: () => Effect.succeed('not-a-currency'), getCurrencyRate })

    await expect(Effect.runPromise(queryActiveCurrency().pipe(Effect.provide(ratesLayer(rates))))).resolves.toEqual({
      code: 'USD',
      symbol: '$',
      rate: 1,
    })
    expect(getCurrencyRate).not.toHaveBeenCalled()

    const usd = fakeRates({ getDisplayCurrency: () => Effect.succeed('USD'), getCurrencyRate })
    await expect(Effect.runPromise(queryActiveCurrency().pipe(Effect.provide(ratesLayer(usd))))).resolves.toMatchObject(
      {
        code: 'USD',
      },
    )
    expect(getCurrencyRate).not.toHaveBeenCalled()
  })

  it('writes before returning the current cached currency and reflects later edits on the next read', async () => {
    const order: string[] = []
    let code = 'USD'
    let rate: CurrencyRate | null = null
    const rates = fakeRates({
      setDisplayCurrency: next =>
        Effect.sync(() => {
          order.push(`write:${next}`)
          code = next
        }),
      getDisplayCurrency: () =>
        Effect.sync(() => {
          order.push(`read:${code}`)
          return code
        }),
      getCurrencyRate: currency =>
        Effect.sync(() => {
          order.push(`rate:${currency}`)
          return rate
        }),
    })

    const selected = await Effect.runPromise(selectDisplayCurrency('EUR').pipe(Effect.provide(ratesLayer(rates))))
    expect(selected).toMatchObject({ code: 'EUR', rate: 1 })
    expect(order).toEqual(['write:EUR', 'read:EUR', 'rate:EUR'])

    rate = { code: 'EUR', symbol: '€', rate: 0.91, updatedAt: '2026-10-06T00:00:00.000Z' }
    order.length = 0
    await expect(
      Effect.runPromise(queryActiveCurrency().pipe(Effect.provide(ratesLayer(rates)))),
    ).resolves.toMatchObject({
      code: 'EUR',
      rate: 0.91,
    })
    expect(order).toEqual(['read:EUR', 'rate:EUR'])
  })

  it.each([null, 3, 'eur', ' EUR ', 'ZZZ'])('rejects invalid input %j before writing', async input => {
    const setDisplayCurrency = vi.fn(() => Effect.void)
    const exit = await Effect.runPromiseExit(
      selectDisplayCurrency(input).pipe(Effect.provide(ratesLayer(fakeRates({ setDisplayCurrency })))),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons[0]).toMatchObject({
        _tag: 'Fail',
        error: { _tag: 'CurrencyCommandValidationError', message: 'invalid ISO 4217 currency code' },
      })
    }
    expect(setDisplayCurrency).not.toHaveBeenCalled()
  })

  it('preserves SQL and Schema failures from the FX port', async () => {
    const sqlFailure = new SqlError.SqlError({
      reason: new SqlError.SqlSyntaxError({ cause: new Error('private SQL detail'), message: 'read failed' }),
    })
    const sqlExit = await Effect.runPromiseExit(
      queryActiveCurrency().pipe(
        Effect.provide(ratesLayer(fakeRates({ getDisplayCurrency: () => Effect.fail(sqlFailure) }))),
      ),
    )
    expect(Exit.isFailure(sqlExit)).toBe(true)
    if (Exit.isFailure(sqlExit)) expect(sqlExit.cause.reasons[0]).toMatchObject({ _tag: 'Fail', error: sqlFailure })

    const schemaFailure = Schema.decodeUnknownEffect(Schema.Never)(null)
    const schemaExit = await Effect.runPromiseExit(
      queryActiveCurrency().pipe(
        Effect.provide(
          ratesLayer(
            fakeRates({
              getDisplayCurrency: () => Effect.succeed('EUR'),
              getCurrencyRate: () => schemaFailure,
            }),
          ),
        ),
      ),
    )
    expect(Exit.isFailure(schemaExit)).toBe(true)
    if (Exit.isFailure(schemaExit)) {
      expect(schemaExit.cause.reasons[0]).toMatchObject({ _tag: 'Fail', error: { _tag: 'SchemaError' } })
    }
  })

  it('keeps defects and interruption in their failure causes', async () => {
    const defectExit = await Effect.runPromiseExit(
      selectDisplayCurrency('EUR').pipe(
        Effect.provide(ratesLayer(fakeRates({ setDisplayCurrency: () => Effect.die(new Error('port defect')) }))),
      ),
    )
    expect(Exit.isFailure(defectExit)).toBe(true)
    if (Exit.isFailure(defectExit)) expect(Cause.hasDies(defectExit.cause)).toBe(true)

    const runtime = Effect.runFork(
      selectDisplayCurrency('EUR').pipe(
        Effect.provide(ratesLayer(fakeRates({ setDisplayCurrency: () => Effect.never }))),
      ),
    )
    await Effect.runPromise(Fiber.interrupt(runtime))
    const interruptedExit = await Effect.runPromise(Fiber.await(runtime))
    expect(Exit.isFailure(interruptedExit)).toBe(true)
    if (Exit.isFailure(interruptedExit)) expect(Cause.hasInterruptsOnly(interruptedExit.cause)).toBe(true)
  })

  it('roundtrips a selected currency and cached rate through the native worker root', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-worker-currency-'))
    const runtime = makeWorkerRuntime(join(directory, 'ledger.db'))
    try {
      runtime.runSync(initializeLedger)
      await runtime
        .runPromise(
          Effect.gen(function* () {
            const config = yield* LedgerConfig
            yield* config.setCurrencyRate({
              code: 'EUR',
              symbol: '€',
              rate: 0.89,
              updatedAt: '2026-10-06T00:00:00.000Z',
            })
            const selected = yield* selectDisplayCurrency('EUR')
            const read = yield* queryActiveCurrency()
            return [selected, read] as const
          }),
        )
        .then(([selected, read]) => {
          expect(selected).toMatchObject({ code: 'EUR', symbol: '€', rate: 0.89 })
          expect(read).toEqual(selected)
        })
    } finally {
      await runtime.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
