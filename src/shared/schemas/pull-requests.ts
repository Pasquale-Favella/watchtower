import { z } from 'zod'

export const pullRequestRowSchema = z.object({
  url: z.string(),
  label: z.string(),
  cost: z.number(),
  sessions: z.number(),
  calls: z.number(),
  firstStarted: z.string(),
  lastEnded: z.string(),
  models: z.array(z.string()),
  /** Per-model raw feeders for Alias-merged models (`models` holds the merged
   * identity). Present only when a merge happened. */
  modelProvenance: z.record(z.string(), z.array(z.string())).optional(),
  categories: z.array(z.object({ name: z.string(), cost: z.number() })).optional(),
})
export type PullRequestRow = z.infer<typeof pullRequestRowSchema>

export const pullRequestsPayloadSchema = z.object({
  rows: z.array(pullRequestRowSchema),
  distinctCost: z.number(),
  distinctSessions: z.number(),
  subagentSessions: z.number(),
  attributedCost: z.number(),
  unattributedCost: z.number(),
})
export type PullRequestsPayload = z.infer<typeof pullRequestsPayloadSchema>
