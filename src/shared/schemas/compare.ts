import * as Schema from 'effect/Schema'

const finiteNumber = Schema.Finite
const writable = Schema.mutableKey
const mutableArray = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.mutable(Schema.Array(schema))

export const compareFormatFnSchema = Schema.Literals(['cost', 'number', 'percent', 'decimal', 'compact'])
export type CompareFormatFn = Schema.Schema.Type<typeof compareFormatFnSchema>

export const compareModelStatSchema = Schema.Struct({
  model: writable(Schema.String),
  displayName: writable(Schema.String),
  calls: writable(finiteNumber),
  costUSD: writable(finiteNumber),
  outputTokens: writable(finiteNumber),
  inputTokens: writable(finiteNumber),
  cacheReadTokens: writable(finiteNumber),
  totalTurns: writable(finiteNumber),
  editTurns: writable(finiteNumber),
  oneShotTurns: writable(finiteNumber),
  retries: writable(finiteNumber),
})
export type CompareModelStat = Schema.Schema.Type<typeof compareModelStatSchema>

export const compareWinnerSchema = Schema.Literals(['a', 'b', 'tie', 'none'])
export type CompareWinner = Schema.Schema.Type<typeof compareWinnerSchema>

export const comparisonRowSchema = Schema.Struct({
  label: writable(Schema.String),
  valueA: writable(Schema.NullOr(finiteNumber)),
  valueB: writable(Schema.NullOr(finiteNumber)),
  formatFn: writable(compareFormatFnSchema),
  winner: writable(compareWinnerSchema),
})
export type ComparisonRow = Schema.Schema.Type<typeof comparisonRowSchema>

export const categoryComparisonSchema = Schema.Struct({
  category: writable(Schema.String),
  turnsA: writable(finiteNumber),
  editTurnsA: writable(finiteNumber),
  oneShotRateA: writable(Schema.NullOr(finiteNumber)),
  turnsB: writable(finiteNumber),
  editTurnsB: writable(finiteNumber),
  oneShotRateB: writable(Schema.NullOr(finiteNumber)),
  winner: writable(compareWinnerSchema),
})
export type CategoryComparison = Schema.Schema.Type<typeof categoryComparisonSchema>

export const workingStyleRowSchema = Schema.Struct({
  label: writable(Schema.String),
  valueA: writable(Schema.NullOr(finiteNumber)),
  valueB: writable(Schema.NullOr(finiteNumber)),
  formatFn: writable(compareFormatFnSchema),
})
export type WorkingStyleRow = Schema.Schema.Type<typeof workingStyleRowSchema>

export const compareReportSchema = Schema.Struct({
  modelA: writable(compareModelStatSchema),
  modelB: writable(compareModelStatSchema),
  metrics: writable(mutableArray(comparisonRowSchema)),
  categories: writable(mutableArray(categoryComparisonSchema)),
  workingStyle: writable(mutableArray(workingStyleRowSchema)),
})
export type CompareReport = Schema.Schema.Type<typeof compareReportSchema>

export const comparePayloadSchema = Schema.Struct({
  models: writable(mutableArray(compareModelStatSchema)),
  report: writable(Schema.NullOr(compareReportSchema)),
})
export type ComparePayload = Schema.Schema.Type<typeof comparePayloadSchema>

export const comparePairSchema = Schema.Struct({
  modelA: writable(Schema.String),
  modelB: writable(Schema.String),
})
export type ComparePair = Schema.Schema.Type<typeof comparePairSchema>
