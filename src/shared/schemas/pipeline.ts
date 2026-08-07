import { z } from 'zod'

/** The pipeline's parsed token-usage record. Raw SQLite counts arrive as
 * numbers; the schema enforces that (no silent string coercion). */
export const tokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cachedInputTokens: z.number(),
  reasoningTokens: z.number(),
  webSearchRequests: z.number(),
})
export type TokenUsage = z.infer<typeof tokenUsageSchema>

/** A single tool invocation within a call's tool sequence (rich capture). The
 * optional `file`/`command` make the shape tolerant of providers that only
 * record the tool name. */
export const toolCallSchema = z.object({
  tool: z.string(),
  file: z.string().optional(),
  command: z.string().optional(),
})
export type ToolCall = z.infer<typeof toolCallSchema>
