import * as Effect from 'effect/Effect'
import type { SchemaError } from 'effect/Schema'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import type { ActiveCurrency } from '../../shared/schemas/fx.js'
import { FxRates } from '../fx.js'
import { activeFromCachedRate, isValidCurrencyCode, USD_CURRENCY } from '../fx-calculation.js'

export class CurrencyCommandValidationError extends Schema.TaggedError<CurrencyCommandValidationError>()(
  'CurrencyCommandValidationError',
  { message: Schema.Literals(['invalid ISO 4217 currency code']) },
) {}

const currencyCodeSchema = Schema.String.check(
  Schema.makeFilter(code => (isValidCurrencyCode(code) ? undefined : 'invalid ISO 4217 currency code')),
)

/** Reads the persisted display currency and its cached rate without fetching. */
export const queryActiveCurrency = Effect.fn('queryActiveCurrency')(function* (): Effect.fn.Return<
  ActiveCurrency,
  SqlError | SchemaError,
  FxRates
> {
  const rates = yield* FxRates
  const persistedCode = yield* rates.getDisplayCurrency()
  const code = isValidCurrencyCode(persistedCode) ? persistedCode : 'USD'
  if (code === 'USD') return { ...USD_CURRENCY }

  const cached = yield* rates.getCurrencyRate(code)
  return activeFromCachedRate(code, cached)
})

/** Validates and persists a display currency, then returns its cached state. */
export const selectDisplayCurrency = Effect.fn('selectDisplayCurrency')(function* (
  input: unknown,
): Effect.fn.Return<ActiveCurrency, CurrencyCommandValidationError | SqlError | SchemaError, FxRates> {
  const code = yield* Schema.decodeUnknownEffect(currencyCodeSchema)(input).pipe(
    Effect.mapError(() => new CurrencyCommandValidationError({ message: 'invalid ISO 4217 currency code' })),
  )
  const rates = yield* FxRates
  yield* rates.setDisplayCurrency(code)
  return yield* queryActiveCurrency()
})
