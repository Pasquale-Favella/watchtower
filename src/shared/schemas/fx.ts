import * as Schema from 'effect/Schema'

const finiteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()))
const writable = Schema.mutableKey

export const activeCurrencySchema = Schema.Struct({
  code: writable(Schema.String),
  symbol: writable(Schema.String),
  rate: writable(finiteNumber),
  updatedAt: writable(Schema.optional(Schema.String)),
})
export type ActiveCurrency = Schema.Schema.Type<typeof activeCurrencySchema>

export const currencyOptionSchema = Schema.Struct({
  code: writable(Schema.String),
  symbol: writable(Schema.String),
})
export type CurrencyOption = Schema.Schema.Type<typeof currencyOptionSchema>

export const currencyOptionsSchema = Schema.mutable(Schema.Array(currencyOptionSchema))
