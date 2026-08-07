import { z } from 'zod'

export const compareFormatFnSchema = z.enum(['cost', 'number', 'percent', 'decimal', 'compact'])
export type CompareFormatFn = z.infer<typeof compareFormatFnSchema>

export const compareModelStatSchema = z.object({
  model: z.string(),
  displayName: z.string(),
  calls: z.number(),
  costUSD: z.number(),
  outputTokens: z.number(),
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  totalTurns: z.number(),
  editTurns: z.number(),
  oneShotTurns: z.number(),
  retries: z.number(),
})
export type CompareModelStat = z.infer<typeof compareModelStatSchema>

export const compareWinnerSchema = z.enum(['a', 'b', 'tie', 'none'])
export type CompareWinner = z.infer<typeof compareWinnerSchema>

export const comparisonRowSchema = z.object({
  label: z.string(),
  valueA: z.number().nullable(),
  valueB: z.number().nullable(),
  formatFn: compareFormatFnSchema,
  winner: compareWinnerSchema,
})
export type ComparisonRow = z.infer<typeof comparisonRowSchema>

export const categoryComparisonSchema = z.object({
  category: z.string(),
  turnsA: z.number(),
  editTurnsA: z.number(),
  oneShotRateA: z.number().nullable(),
  turnsB: z.number(),
  editTurnsB: z.number(),
  oneShotRateB: z.number().nullable(),
  winner: compareWinnerSchema,
})
export type CategoryComparison = z.infer<typeof categoryComparisonSchema>

export const workingStyleRowSchema = z.object({
  label: z.string(),
  valueA: z.number().nullable(),
  valueB: z.number().nullable(),
  formatFn: compareFormatFnSchema,
})
export type WorkingStyleRow = z.infer<typeof workingStyleRowSchema>

export const compareReportSchema = z.object({
  modelA: compareModelStatSchema,
  modelB: compareModelStatSchema,
  metrics: z.array(comparisonRowSchema),
  categories: z.array(categoryComparisonSchema),
  workingStyle: z.array(workingStyleRowSchema),
})
export type CompareReport = z.infer<typeof compareReportSchema>

export const comparePayloadSchema = z.object({
  models: z.array(compareModelStatSchema),
  report: compareReportSchema.nullable(),
})
export type ComparePayload = z.infer<typeof comparePayloadSchema>

export const comparePairSchema = z.object({
  modelA: z.string(),
  modelB: z.string(),
})
export type ComparePair = z.infer<typeof comparePairSchema>
