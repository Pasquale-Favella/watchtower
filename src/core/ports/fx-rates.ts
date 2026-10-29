import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type { SchemaError } from 'effect/Schema'
import type { SqlError } from 'effect/sql/SqlError'

import type { CurrencyRate } from '../../shared/schemas/ledger.js'
import { LedgerConfig } from './repository.js'

function sanitizeDisplayCurrencyCode(code: string): string {
  return /^[A-Za-z]{3}$/.test(code) ? code.toUpperCase() : 'USD'
}

export class FxRates extends Context.Service<
  FxRates,
  {
    readonly getCurrencyRate: (code: string) => Effect.Effect<CurrencyRate | null, SqlError | SchemaError>
    readonly setCurrencyRate: (rate: CurrencyRate) => Effect.Effect<void, SqlError | SchemaError>
    readonly getDisplayCurrency: () => Effect.Effect<string, SqlError | SchemaError>
    readonly setDisplayCurrency: (code: string) => Effect.Effect<void, SqlError | SchemaError>
  }
>()('watchtower/fx/FxRates') {
  /** Live FX adapter over the composed ledger config port. Service methods
   * stay as Effects so SQL and row-decoding failures reach callers unchanged. */
  static readonly layer: Layer.Layer<FxRates, never, LedgerConfig> = Layer.effect(
    FxRates,
    Effect.gen(function* () {
      const config = yield* LedgerConfig
      return FxRates.of({
        getCurrencyRate: code => config.getCurrencyRate(code),
        setCurrencyRate: rate => config.setCurrencyRate(rate),
        getDisplayCurrency: () => config.getDisplayCurrency(),
        setDisplayCurrency: code => config.setDisplayCurrency(sanitizeDisplayCurrencyCode(code)),
      })
    }),
  )

  static readonly layerWithRates = (rates: FxRates['Service']): Layer.Layer<FxRates> =>
    Layer.succeed(FxRates, FxRates.of(rates))
}
