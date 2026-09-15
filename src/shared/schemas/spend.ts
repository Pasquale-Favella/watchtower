import { z } from 'zod'

export const spendSegmentSchema = z.object({ name: z.string(), cost: z.number(), sourceModels: z.array(z.string()).optional() })
export type SpendSegment = z.infer<typeof spendSegmentSchema>

export const spendDayEntrySchema = z.object({
  date: z.string(),
  cost: z.number(),
  segments: z.array(spendSegmentSchema),
})
export type SpendDayEntry = z.infer<typeof spendDayEntrySchema>

export const spendFlowNodeSchema = z.object({ id: z.string(), label: z.string(), cost: z.number(), sourceModels: z.array(z.string()).optional() })
export type SpendFlowNode = z.infer<typeof spendFlowNodeSchema>

export const spendFlowLinkSchema = z.object({ model: z.string(), project: z.string(), cost: z.number() })
export type SpendFlowLink = z.infer<typeof spendFlowLinkSchema>

export const spendFlowSchema = z.object({
  models: z.array(spendFlowNodeSchema),
  projects: z.array(spendFlowNodeSchema),
  links: z.array(spendFlowLinkSchema),
})
export type SpendFlow = z.infer<typeof spendFlowSchema>

export const spendPayloadSchema = z.object({
  byModel: z.array(spendDayEntrySchema),
  byProject: z.array(spendDayEntrySchema),
  flow: spendFlowSchema,
  dataStart: z.string().nullable(),
})
export type SpendPayload = z.infer<typeof spendPayloadSchema>
