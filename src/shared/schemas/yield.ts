import { z } from 'zod'

export const yieldCategorySchema = z.enum(['productive', 'reverted', 'abandoned', 'ambiguous'])
export type YieldCategory = z.infer<typeof yieldCategorySchema>

export const yieldBucketSchema = z.object({
  costUSD: z.number(),
  sessions: z.number(),
  costPercent: z.number(),
  sessionPercent: z.number(),
})
export type YieldBucket = z.infer<typeof yieldBucketSchema>

export const yieldDetailSchema = z.object({
  sessionId: z.string(),
  project: z.string(),
  costUSD: z.number(),
  category: yieldCategorySchema,
  commitCount: z.number(),
})
export type YieldDetail = z.infer<typeof yieldDetailSchema>

export const yieldPayloadSchema = z.object({
  period: z.object({ start: z.string().nullable(), end: z.string().nullable() }),
  summary: z.object({
    productive: yieldBucketSchema,
    reverted: yieldBucketSchema,
    abandoned: yieldBucketSchema,
    ambiguous: yieldBucketSchema,
    total: z.object({ costUSD: z.number(), sessions: z.number() }),
    productiveToRevertedCostRatio: z.number().nullable(),
  }),
  methodology: z.literal('timestamp-window'),
  details: z.array(yieldDetailSchema),
})
export type YieldPayload = z.infer<typeof yieldPayloadSchema>
