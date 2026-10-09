import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { describe, expect, it } from 'vitest'

import { FxRates, refreshFxRateWithRates } from '../src/main/fx.js'
import { HttpFetch } from '../src/main/pipeline/fetch-utils.js'
import { LedgerConfig } from '../src/main/store/ledger-repository.js'
import { openLedgerFixture } from './fixtures/ledger-runtime.js'

function configLayer(overrides: Partial<LedgerConfig['Service']> = {}): Layer.Layer<LedgerConfig> {
  const noop = Effect.void
  return Layer.succeed(
    LedgerConfig,
    LedgerConfig.of({
      getModelAliases: () => Effect.succeed([]),
      setModelAlias: () => noop,
      removeModelAlias: () => noop,
      getPriceOverrides: () => Effect.succeed([]),
      setPriceOverride: () => noop,
      removePriceOverride: () => noop,
      getCurrencyRate: () => Effect.succeed(null),
      setCurrencyRate: () => noop,
      getDisplayCurrency: () => Effect.succeed('USD'),
      setDisplayCurrency: () => noop,
      getRefreshCadence: () => Effect.succeed(''),
      setRefreshCadence: () => noop,
      getLedgerMcpStartupMode: () => Effect.succeed('on-demand'),
      setLedgerMcpStartupMode: () => noop,
      getSkillDismissals: () => Effect.succeed([]),
      dismissSkill: () => noop,
      ...overrides,
    }),
  )
}

function liveRatesLayer(config: Layer.Layer<LedgerConfig>): Layer.Layer<FxRates> {
  return Layer.provide(FxRates.layer, config)
}

describe('FxRates.layer (LedgerConfig adapter)', () => {
  it('composes with the native worker config port', async () => {
    const fixture = openLedgerFixture()
    await fixture.runtime.runPromise(
      Effect.gen(function* () {
        const rates = yield* FxRates
        yield* rates.setDisplayCurrency('eur')
        yield* rates.setCurrencyRate({
          code: 'EUR',
          symbol: '€',
          rate: 0.9,
          updatedAt: '2026-10-01T00:00:00.000Z',
        })
      }),
    )
    const saved = await fixture.runtime.runPromise(
      Effect.gen(function* () {
        const rates = yield* FxRates
        return [yield* rates.getDisplayCurrency(), yield* rates.getCurrencyRate('EUR')] as const
      }),
    )
    expect(saved).toEqual(['EUR', { code: 'EUR', symbol: '€', rate: 0.9, updatedAt: '2026-10-01T00:00:00.000Z' }])
  })

  it('forwards reads, writes, and display-code sanitization to LedgerConfig', async () => {
    let savedCode = 'USD'
    let savedRate: { code: string; symbol: string; rate: number; updatedAt: string } | undefined
    const config = configLayer({
      getDisplayCurrency: () => Effect.succeed(savedCode),
      setDisplayCurrency: code =>
        Effect.sync(() => {
          savedCode = code
        }),
      getCurrencyRate: () => Effect.succeed(savedRate ?? null),
      setCurrencyRate: rate =>
        Effect.sync(() => {
          savedRate = rate
        }),
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const rates = yield* FxRates
        yield* rates.setDisplayCurrency('eur')
        yield* rates.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: '2026-10-01T00:00:00.000Z' })
        return [yield* rates.getDisplayCurrency(), yield* rates.getCurrencyRate('EUR')] as const
      }).pipe(Effect.provide(liveRatesLayer(config))),
    )

    expect(result).toEqual(['EUR', { code: 'EUR', symbol: '€', rate: 0.9, updatedAt: '2026-10-01T00:00:00.000Z' }])
  })

  it('keeps a cached-read SchemaError in the failure channel', async () => {
    const schemaFailure = Effect.as(Schema.decodeUnknownEffect(Schema.String)(123), null)
    const config = configLayer({ getCurrencyRate: () => schemaFailure })
    const exit = await Effect.runPromiseExit(
      refreshFxRateWithRates('EUR').pipe(
        Effect.provide(liveRatesLayer(config)),
        Effect.provide(
          HttpFetch.layerWithFetch(async () => {
            throw new Error('must not fetch')
          }),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons[0]).toMatchObject({ _tag: 'Fail', error: { _tag: 'SchemaError' } })
    }
  })

  it('keeps a cache-persist SqlError in the failure channel', async () => {
    const sqlFailure = new SqlError.SqlError({
      reason: new SqlError.SqlSyntaxError({ cause: new Error('test SQL failure'), message: 'persist failed' }),
    })
    const config = configLayer({ setCurrencyRate: () => Effect.fail(sqlFailure) })
    const exit = await Effect.runPromiseExit(
      refreshFxRateWithRates('EUR').pipe(
        Effect.provide(liveRatesLayer(config)),
        Effect.provide(
          HttpFetch.layerWithFetch(
            async () =>
              ({
                ok: true,
                status: 200,
                json: async () => ({ rates: { EUR: 0.9 } }),
              }) as Response,
          ),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons[0]).toMatchObject({
        _tag: 'Fail',
        error: { _tag: 'SqlError', reason: { _tag: 'SqlSyntaxError' } },
      })
    }
  })

  it('still falls back to the stale rate on network failure', async () => {
    const cached = { code: 'EUR', symbol: '€', rate: 0.88, updatedAt: '2000-01-01T00:00:00.000Z' }
    const config = configLayer({ getCurrencyRate: () => Effect.succeed(cached) })
    const result = await Effect.runPromise(
      refreshFxRateWithRates('EUR').pipe(
        Effect.provide(liveRatesLayer(config)),
        Effect.provide(
          HttpFetch.layerWithFetch(async () => {
            throw new Error('offline')
          }),
        ),
      ),
    )
    expect(result).toMatchObject({ code: 'EUR', rate: 0.88 })
  })
})
